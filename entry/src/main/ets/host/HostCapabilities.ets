import { abilityAccessCtrl, bundleManager, common, PermissionRequestResult, Permissions, Want } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HostBridge } from '@fellow99/node-bridge';
import { Constants } from '../common/Constants';

interface NameArgs {
  name?: string;
}

interface NamesArgs {
  names?: string[];
}

interface UriArgs {
  uri?: string;
}

interface LogArgs {
  level?: string;
  msg?: string;
}

/** 失败信封（封闭错误码集合，见 specs/overall-data-model.md §4.2） */
interface CapabilityError {
  ok: boolean;
  error: string;
  hint: string;
}

/** 成功但无载荷 */
interface OkResult {
  ok: boolean;
}

interface PermissionCheckResult {
  ok: boolean;
  granted: boolean;
}

interface PermissionReply {
  ok: boolean;
  authResults: number[];
  permissions: string[];
}

interface AppFacts {
  bundleName: string;
  versionName: string;
  versionCode: number;
}

interface NodeFacts {
  expected: string;
  abi: number;
}

interface PathFacts {
  filesDir: string;
  resourceDir: string;
  payloadRoot: string;
  assetRoot: string;
  dshHome: string;
  workspace: string;
  mailbox: string;
}

interface UserDirFact {
  id: string;
  path: string;
  available: boolean;
}

interface CapabilityStatus {
  name: string;
  status: string;
}

interface RuntimeFacts {
  schema: number;
  app: AppFacts;
  node: NodeFacts;
  paths: PathFacts;
  userDirs: UserDirFact[];
  jitless: boolean;
  capabilities: CapabilityStatus[];
}

/**
 * 宿主能力面（`specs/overall-data-model.md` §4）。
 *
 * 纪律：
 * - 入参与返回值都是 JSON **字符串**；
 * - 处理器永不抛异常（异常统一映射为 `internal`）；
 * - 未实现的能力注册为 `not-implemented` + 可执行提示，不返回伪成功。
 */
export class HostCapabilities {
  /**
   * 注册全部能力（重复注册同名会覆盖，库的注册表语义）。
   * @param host - 库提供的宿主桥
   * @param context - UIAbility 上下文
   */
  static install(host: HostBridge, context: common.UIAbilityContext): void {
    host.register('runtime.facts', (_args: string): string => HostCapabilities.facts(context));
    host.register('log.hilog', (args: string): string => HostCapabilities.hilog(args));
    host.register('perm.check', (args: string): string => HostCapabilities.checkPermission(context, args));
    host.register('perm.request', (args: string): Promise<string> => HostCapabilities.requestPermission(context, args));
    host.register('perm.openAppInfo', (_args: string): Promise<string> => HostCapabilities.openAppInfo(context));
    host.register('shell.openExternal', (args: string): Promise<string> => HostCapabilities.openExternal(context, args));

    // 已注册但未实现：显式返回 not-implemented（宪法 C2）。
    HostCapabilities.notImplemented(host, 'fs.pickFolder', 'workspace-picker 将经 directoryPicker seam 提供；本轮请用 browse 后端');
    HostCapabilities.notImplemented(host, 'fs.pickFiles', '附件导入将在 P2 提供；本轮暂用拖拽/粘贴');
    HostCapabilities.notImplemented(host, 'fs.saveFile', '导出将在 P2 提供');
    HostCapabilities.notImplemented(host, 'notify.show', '通知桥将在 P2 接入 NotificationKit');
    HostCapabilities.notImplemented(host, 'clipboard.readImage', '剪贴板图片将在 P2 接入 pasteboard');
    HostCapabilities.notImplemented(host, 'clipboard.writeText', '剪贴板文本将在 P2 接入 pasteboard');
    HostCapabilities.notImplemented(host, 'image.normalize', '图像桥将在 P2 接入 ImageKit');
    HostCapabilities.notImplemented(host, 'power.keepAwake', '长时任务已由 backgroundModes 提供，运行锁将在 P2 接入');
  }

  private static notImplemented(host: HostBridge, name: string, hint: string): void {
    host.register(name, (_args: string): string => {
      const payload: CapabilityError = { ok: false, error: 'not-implemented', hint };
      return JSON.stringify(payload);
    });
  }

  private static facts(context: common.UIAbilityContext): string {
    try {
      const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT
      );
      const app: AppFacts = {
        bundleName: info.name,
        versionName: info.versionName,
        versionCode: info.versionCode
      };
      const node: NodeFacts = { expected: 'v24.2.0', abi: 137 };
      const paths: PathFacts = {
        filesDir: context.filesDir,
        resourceDir: context.resourceDir,
        payloadRoot: Constants.payloadRoot(context),
        assetRoot: Constants.assetRoot(context),
        dshHome: Constants.dshHome(context),
        workspace: Constants.workspaceRoot(context),
        mailbox: Constants.mailboxDir(context)
      };
      const payload: RuntimeFacts = {
        schema: 1,
        app,
        node,
        paths,
        userDirs: HostCapabilities.userDirs(),
        capabilities: HostCapabilities.capabilities(),
        jitless: false
      };
      return JSON.stringify(payload);
    } catch (error) {
      return HostCapabilities.internal('runtime.facts', error);
    }
  }

  private static userDirs(): UserDirFact[] {
    const result: UserDirFact[] = [];
    for (let i = 0; i < Constants.USER_DIRS.length; i++) {
      const name: string = Constants.USER_DIRS[i];
      const dirPath: string = Constants.USER_ROOT + '/' + name;
      const fact: UserDirFact = {
        id: name.toLowerCase(),
        path: dirPath,
        available: HostCapabilities.exists(dirPath)
      };
      result.push(fact);
    }
    return result;
  }

  private static exists(path: string): boolean {
    try {
      // 只报存在性（整体数据模型 §5）；权限/可见性问题由真实读写暴露。
      return fs.accessSync(path);
    } catch (error) {
      return false;
    }
  }

  private static capabilities(): CapabilityStatus[] {
    const implemented: string[] = [
      'runtime.facts', 'log.hilog', 'perm.check', 'perm.request', 'perm.openAppInfo', 'shell.openExternal'
    ];
    const pending: string[] = [
      'fs.pickFolder', 'fs.pickFiles', 'fs.saveFile', 'notify.show',
      'clipboard.readImage', 'clipboard.writeText', 'image.normalize', 'power.keepAwake'
    ];
    const result: CapabilityStatus[] = [];
    for (let i = 0; i < implemented.length; i++) {
      const entry: CapabilityStatus = { name: implemented[i], status: 'implemented' };
      result.push(entry);
    }
    for (let i = 0; i < pending.length; i++) {
      const entry: CapabilityStatus = { name: pending[i], status: 'not-implemented' };
      result.push(entry);
    }
    return result;
  }

  private static hilog(args: string): string {
    try {
      const parsed: LogArgs = JSON.parse(args) as LogArgs;
      const message: string = parsed.msg ?? '';
      const level: string = parsed.level ?? 'info';
      if (level === 'error') {
        hilog.error(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
      } else if (level === 'warn') {
        hilog.warn(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
      } else {
        hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
      }
      const ok: OkResult = { ok: true };
      return JSON.stringify(ok);
    } catch (error) {
      return HostCapabilities.internal('log.hilog', error);
    }
  }

  private static checkPermission(context: common.UIAbilityContext, args: string): string {
    try {
      const parsed: NameArgs = JSON.parse(args) as NameArgs;
      const name: string = parsed.name ?? '';
      if (name === '') {
        const bad: CapabilityError = { ok: false, error: 'bad-args', hint: 'name is required' };
        return JSON.stringify(bad);
      }
      const tokenId: number = HostCapabilities.tokenId();
      const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const status: abilityAccessCtrl.GrantStatus = manager.checkAccessTokenSync(tokenId, name as Permissions);
      const payload: PermissionCheckResult = {
        ok: true,
        granted: status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED
      };
      return JSON.stringify(payload);
    } catch (error) {
      return HostCapabilities.internal('perm.check', error);
    }
  }

  private static async requestPermission(context: common.UIAbilityContext, args: string): Promise<string> {
    try {
      const parsed: NamesArgs = JSON.parse(args) as NamesArgs;
      const names: string[] = parsed.names ?? [];
      if (names.length === 0) {
        const bad: CapabilityError = { ok: false, error: 'bad-args', hint: 'names is required' };
        return JSON.stringify(bad);
      }
      const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const result: PermissionRequestResult =
        await manager.requestPermissionsFromUser(context, names as Permissions[]);
      const payload: PermissionReply = {
        ok: true,
        authResults: result.authResults,
        permissions: result.permissions
      };
      return JSON.stringify(payload);
    } catch (error) {
      return HostCapabilities.internal('perm.request', error);
    }
  }

  private static async openAppInfo(context: common.UIAbilityContext): Promise<string> {
    try {
      const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT
      );
      const want: Want = {
        action: 'ohos.settings.application.details',
        parameters: { bundleName: info.name }
      };
      await context.startAbility(want);
      const ok: OkResult = { ok: true };
      return JSON.stringify(ok);
    } catch (error) {
      return HostCapabilities.internal('perm.openAppInfo', error);
    }
  }

  private static async openExternal(context: common.UIAbilityContext, args: string): Promise<string> {
    try {
      const parsed: UriArgs = JSON.parse(args) as UriArgs;
      const uri: string = parsed.uri ?? '';
      if (!uri.startsWith('https://')) {
        const refused: CapabilityError = {
          ok: false,
          error: 'not-implemented',
          hint: 'only https links are allowed in 000-scaffold'
        };
        return JSON.stringify(refused);
      }
      await context.openLink(uri);
      const ok: OkResult = { ok: true };
      return JSON.stringify(ok);
    } catch (error) {
      return HostCapabilities.internal('shell.openExternal', error);
    }
  }

  private static tokenId(): number {
    const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION
    );
    return info.appInfo.accessTokenId;
  }

  private static internal(name: string, error: Object): string {
    const message: string = error instanceof Error ? error.message : String(error);
    const payload: CapabilityError = { ok: false, error: 'internal', hint: `${name}: ${message}` };
    return JSON.stringify(payload);
  }
}
