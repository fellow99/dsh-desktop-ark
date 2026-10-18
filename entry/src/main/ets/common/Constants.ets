import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';

/**
 * 全局常量与路径派生（单一事实源）。
 *
 * 约定：所有路径都由 `context.filesDir` / `context.resourceDir` 派生；
 * 真机上 `process.cwd()` 是 `/`，任何相对路径都不可信（宪法 C6）。
 */
export class Constants {
  /** hilog 域与标签（现场排查用；业务日志另写 app.log） */
  static readonly HILOG_DOMAIN: number = 0xD0033;
  static readonly HILOG_TAG: string = 'DSH_DESKTOP_ARK';

  /** 启动编排的时间预算 */
  static readonly START_TIMEOUT_MS: number = 60000;
  static readonly PROBE_RETRIES: number = 20;
  static readonly PROBE_INTERVAL_MS: number = 500;
  /** 就绪公告（ready.json）的有界重试：线程存活 ≠ 业务就绪 */
  static readonly READY_RETRIES: number = 20;
  static readonly READY_INTERVAL_MS: number = 500;
  /** 宿主桥信箱轮询间隔 */
  static readonly MAILBOX_POLL_MS: number = 100;
  static readonly LOG_TAIL_LINES: number = 200;

  /** 随包载荷（resfile）与运行期目录名 */
  static readonly PAYLOAD_ASSET_DIR: string = 'dsh-payload';
  static readonly BOOT_SCRIPT: string = 'bootstrap.js';
  static readonly HOST_SCRIPT: string = 'host.js';
  static readonly ARCHIVE_NAME: string = 'dsh.tar.gz';
  static readonly READY_FILE: string = 'ready.json';
  static readonly APP_LOG: string = 'app.log';

  /** 四主目录之一：沙箱工作区 */
  static readonly SANDBOX_WORKSPACE: string = 'workspace';

  /** 用户目录（固定解析 + 存在性检查；不按 homedir 猜测） */
  static readonly USER_ROOT: string = '/storage/Users/currentUser';
  static readonly USER_DIRS: string[] = ['Desktop', 'Documents', 'Download'];

  /** `$DSH_HOME`（沙箱内） */
  static dshHome(context: common.Context): string {
    return context.filesDir + '/dsh-home';
  }

  /** Node 可写根（载荷解包 + node.log） */
  static payloadRoot(context: common.Context): string {
    return context.filesDir + '/payload';
  }

  /** 随包载荷的只读根（resfile 是真实目录，Node 可直读） */
  static assetRoot(context: common.Context): string {
    return context.resourceDir + '/' + Constants.PAYLOAD_ASSET_DIR;
  }

  static bootScriptPath(context: common.Context): string {
    return Constants.assetRoot(context) + '/' + Constants.BOOT_SCRIPT;
  }

  static archivePath(context: common.Context): string {
    return Constants.assetRoot(context) + '/' + Constants.ARCHIVE_NAME;
  }

  static readyPath(context: common.Context): string {
    return Constants.payloadRoot(context) + '/' + Constants.READY_FILE;
  }

  static appLogPath(context: common.Context): string {
    return Constants.payloadRoot(context) + '/' + Constants.APP_LOG;
  }

  static workspaceRoot(context: common.Context): string {
    return context.filesDir + '/' + Constants.SANDBOX_WORKSPACE;
  }

  static bridgeDir(context: common.Context): string {
    return context.filesDir + '/node-bridge';
  }

  /** 宿主桥文件信箱目录（Node 与 ArkTS 共用） */
  static mailboxDir(context: common.Context): string {
    return Constants.bridgeDir(context) + '/mailbox';
  }

  /** 创建运行期目录（幂等；父目录 filesDir 由系统保证存在） */
  static ensureDirs(context: common.Context): void {
    const dirs: string[] = [
      Constants.payloadRoot(context),
      Constants.payloadRoot(context) + '/tmp',
      Constants.dshHome(context),
      Constants.workspaceRoot(context),
      Constants.bridgeDir(context),
      Constants.mailboxDir(context)
    ];
    for (let i = 0; i < dirs.length; i++) {
      try {
        fs.mkdirSync(dirs[i]);
      } catch (e) {
        // 已存在即忽略；真正的权限/磁盘问题会在后续真实读写时报错，不在这里伪装成功。
      }
    }
  }
}
