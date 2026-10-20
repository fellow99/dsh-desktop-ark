import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import {
  NodeRuntime,
  NodeRuntimeOptions,
  NodeStartResult,
  NodeState,
  CrashRecord
} from '@fellow99/node-bridge';
import { Constants } from '../common/Constants';
import { Probe } from './Probe';
import { HostCapabilities } from '../host/HostCapabilities';
import { INSPECT_PORT } from '../common/BuildConfig';
import { resolve as resolveNodeMode, NodeModeDecision } from '../common/NodeMode';

/** 启动编排阶段（与 `specs/overall-data-model.md` §3 一致） */
export enum LaunchPhase {
  IDLE = 'IDLE',
  PREPARING = 'PREPARING',
  STARTING = 'STARTING',
  WAITING = 'WAITING',
  PROBING = 'PROBING',
  READY = 'READY',
  RUNNING = 'RUNNING',
  FAILED = 'FAILED',
  STOPPING = 'STOPPING',
  STOPPED = 'STOPPED'
}

/** 面向 UI 的一帧状态 */
export interface LaunchSnapshot {
  phase: LaunchPhase;
  message: string;
  detail: string;
  url: string;
}

/** `ready.json` 的读取视图（容忍未知字段） */
interface ReadyInfo {
  schema?: number;
  at?: number;
  phase?: string;
  url?: string;
  origin?: string;
  token?: string;
  pid?: number;
  version?: string;
  diagnostic?: string;
}

/**
 * 启动编排：准备目录 → 投递 Node → 等待就绪 → 回读 ready.json → 探活 → 交给页面。
 *
 * 关键事实（评审 #1）：库的 `waitUntilRunning` 以原生 `isRunning` 为判据，
 * 在 `node::Start` 之前就已置真，因此它**不代表业务就绪**。业务就绪只能由
 * `ready.json` 的 `phase` 表达；本类对它做有界重试 + 新鲜度 + schema/token 校验。
 *
 * 单例：`node::Start` 每进程只能一次，重复 `launch` 只重放最后一帧状态。
 */
export class DshRuntime {
  private static readonly instance: DshRuntime = new DshRuntime();

  private phase: LaunchPhase = LaunchPhase.IDLE;
  private message: string = '尚未启动';
  private detail: string = '';
  private url: string = '';
  private launched: boolean = false;
  private listener: ((s: LaunchSnapshot) => void) | null = null;

  static get(): DshRuntime {
    return DshRuntime.instance;
  }

  /** 当前帧（幂等读取） */
  snapshot(): LaunchSnapshot {
    return { phase: this.phase, message: this.message, detail: this.detail, url: this.url };
  }

  /**
   * 启动一次（幂等）。
   * @param context - UIAbility 上下文
   * @param listener - 状态回调（每次迁移同步调用）
   */
  async launch(context: common.UIAbilityContext, listener: (s: LaunchSnapshot) => void): Promise<void> {
    this.listener = listener;
    if (this.launched) {
      this.emit();
      return;
    }
    this.launched = true;
    const runtime: NodeRuntime = NodeRuntime.getInstance();
    const launchedAt: number = Date.now();
    // 109-jitless：形态是编译期常量；这里只解析一次并打事实（不含任何运行期切换）。
    const mode: NodeModeDecision = resolveNodeMode();
    this.log('node mode: ' + mode.describe());

    try {
      this.enter(LaunchPhase.PREPARING, '正在准备运行目录…');
      Constants.ensureDirs(context);

      const mailbox: string = runtime.host.startMailbox(Constants.mailboxDir(context), Constants.MAILBOX_POLL_MS);
      if (!mailbox.startsWith('started:')) {
        // 信箱不可用 ⇒ 宿主能力整体不可用；不能带着这个状态进入 RUNNING（C2）。
        this.fail(runtime, `宿主桥不可用（startMailbox=${mailbox}）`);
        return;
      }
      this.log(`mailbox transport: ${mailbox}`);

      HostCapabilities.install(runtime.host, context);

      this.enter(LaunchPhase.STARTING, '正在启动 Node 运行时…');
      const options: NodeRuntimeOptions = {
        scriptPath: Constants.bootScriptPath(context),
        payloadRoot: Constants.payloadRoot(context),
        readonlyRoot: context.resourceDir,
        archive: Constants.archivePath(context),
        cwd: Constants.workspaceRoot(context),
        homeDir: context.filesDir,
        logPath: Constants.payloadRoot(context) + '/node.log',
        // --expose-internals：垫片 S6 靠它替代无 OHOS 目标的 node-addon-require-builtin
        // （app-boot 的 profile 解析要读 internal/modules/*）。缺它 ⇒ Host 启动即失败。
        // 204-plugin-git：debug 取证通道（`INSPECT_PORT`，0 = 关闭）。只绑回环，
        // 设备外需 `hdc fport` 才能连；不改变任何业务行为（spec FR-204-050/051）。
        flags: '--no-verify-heap --expose-internals'
          + (INSPECT_PORT > 0 ? ` --inspect=127.0.0.1:${INSPECT_PORT}` : ''),
        // 109-jitless：compat 形态由库在脚本路径前插入 --jitless（库契约 §2.3）；
        // jit 形态保持现状（不带 --jitless）。
        jitless: mode.jitless(),
        env: {
          DSH_OHOS_HOME: Constants.dshHome(context),
          DSH_HOME: Constants.dshHome(context),
          DSH_OHOS_WORKSPACE: Constants.workspaceRoot(context),
          DSH_OHOS_APP_LOG: Constants.appLogPath(context),
          DSH_OHOS_MAILBOX: Constants.mailboxDir(context),
          DSH_OHOS_USER_ROOT: Constants.USER_ROOT
        },
        onStateChange: (state: NodeState, detail?: string): void => {
          this.log(`node state: ${state}${detail === undefined ? '' : ' - ' + detail}`);
        }
      };

      const started: NodeStartResult = runtime.start(context, options);
      if (!started.ok) {
        this.fail(runtime, `运行时投递失败（code=${started.code}）：${started.message}`);
        return;
      }

      // 线程存活 ≠ 业务就绪：先等线程，再等公告。
      this.enter(LaunchPhase.WAITING, '正在等待服务就绪…');
      await runtime.waitUntilRunning(Constants.START_TIMEOUT_MS);

      this.enter(LaunchPhase.PROBING, '正在确认服务可达…');
      const ready: ReadyInfo | null = await DshRuntime.waitReady(context, launchedAt);
      if (ready === null) {
        this.fail(runtime, `未在预算内读到有效公告：${Constants.readyPath(context)}`);
        return;
      }
      if (ready.schema !== 1) {
        this.fail(runtime, `公告 schema 非法（${String(ready.schema)}）`);
        return;
      }
      if (ready.phase === 'payload-missing' || ready.phase === 'failed') {
        this.fail(runtime, ready.diagnostic ?? `服务未就绪（phase=${ready.phase ?? 'unknown'}）`);
        return;
      }
      if (ready.phase !== 'ready' || ready.url === undefined || ready.url === '') {
        this.fail(runtime, `服务未就绪（phase=${ready.phase ?? 'unknown'}）`);
        return;
      }
      if (ready.token === undefined || ready.token === '') {
        this.fail(runtime, '公告缺少一次性 token（拒绝把无凭据 URL 交给页面）');
        return;
      }

      const reachable: boolean = await Probe.waitFor(
        ready.origin ?? ready.url,
        Constants.PROBE_RETRIES,
        Constants.PROBE_INTERVAL_MS
      );
      if (!reachable) {
        this.fail(runtime, `服务不可达：${ready.origin ?? ready.url}`);
        return;
      }

      runtime.markRunning();
      this.url = ready.url;
      this.phase = LaunchPhase.RUNNING;
      this.message = `已就绪（${ready.version ?? 'unknown'}）`;
      this.detail = '';
      this.emit();
      this.log('runtime ready');
    } catch (error) {
      const message: string = error instanceof Error ? error.message : String(error);
      this.fail(runtime, `启动异常：${message}`);
    }
  }

  /** 通知运行时退出（不拦截系统终止；进程内无优雅停止接口） */
  shutdown(reason: string): void {
    this.phase = LaunchPhase.STOPPING;
    this.message = '正在退出…';
    this.emit();
    try {
      NodeRuntime.getInstance().shutdown(reason);
    } catch (error) {
      this.log(`shutdown failed: ${String(error)}`);
    }
    this.phase = LaunchPhase.STOPPED;
    this.emit();
  }

  private enter(phase: LaunchPhase, message: string): void {
    this.phase = phase;
    this.message = message;
    this.detail = '';
    this.emit();
    this.log(`${phase}: ${message}`);
  }

  /**
   * 有界等待公告进入终态（ready / failed / payload-missing）。
   * 只接受 `at >= notBefore` 的公告，避免读到上一轮的残留（旧端口/旧 token）。
   */
  private static async waitReady(context: common.UIAbilityContext, notBefore: number): Promise<ReadyInfo | null> {
    const path: string = Constants.readyPath(context);
    for (let i = 0; i < Constants.READY_RETRIES; i++) {
      const info: ReadyInfo | null = DshRuntime.readReady(path);
      if (info !== null) {
        const fresh: boolean = info.at === undefined || info.at >= notBefore;
        if (fresh && (info.phase === 'ready' || info.phase === 'failed' || info.phase === 'payload-missing')) {
          return info;
        }
      }
      await DshRuntime.delay(Constants.READY_INTERVAL_MS);
    }
    return null;
  }

  private fail(runtime: NodeRuntime, reason: string): void {
    const parts: string[] = [reason];
    const tail: string = DshRuntime.logTail(runtime);
    if (tail !== '') {
      parts.push('--- node.log (tail) ---');
      parts.push(tail);
    }
    const crash: CrashRecord | null = runtime.lastCrash();
    if (crash !== null) {
      parts.push('--- last crash ---');
      parts.push(`stage=${crash.stage} signal=${crash.signal ?? '-'} at=${crash.at}`);
      if (crash.hint !== undefined) {
        parts.push(crash.hint);
      }
    }
    this.phase = LaunchPhase.FAILED;
    this.message = '启动失败';
    this.detail = parts.join('\n');
    this.emit();
    this.log(`FAILED: ${reason}`);
    try {
      runtime.markFailed(reason);
    } catch (error) {
      this.log(`markFailed failed: ${String(error)}`);
    }
  }

  private static logTail(runtime: NodeRuntime): string {
    const lines: string[] = [];
    const entries = runtime.logs(Constants.LOG_TAIL_LINES);
    for (let i = 0; i < entries.length; i++) {
      lines.push(entries[i].text);
    }
    return lines.join('\n');
  }

  private static readReady(path: string): ReadyInfo | null {
    try {
      if (!fs.accessSync(path)) {
        return null;
      }
      const text: string = fs.readTextSync(path);
      return JSON.parse(text) as ReadyInfo;
    } catch (error) {
      return null;
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  private emit(): void {
    if (this.listener !== null) {
      this.listener(this.snapshot());
    }
  }

  private log(message: string): void {
    hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
  }
}
