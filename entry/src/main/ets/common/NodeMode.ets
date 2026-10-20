import { abilityAccessCtrl, bundleManager, Permissions } from '@kit.AbilityKit';
import { NODE_MODE } from './BuildConfig';

/**
 * 109-jitless：Node 运行形态（`jit` / `compat`）。
 *
 * **形态只认编译期常量**（`common/BuildConfig.ets` 的 `NODE_MODE`）。这里的 ACL 探测
 * **只用于打依据串**（排障第一现场），不参与决策 —— 权限位不是 JIT 可用性的预检：
 * 参考工程在手机上实测「`grantStatus=0` 却按 jit 启动即 SIGTRAP」，详见
 * `docs/ACL-无ACL评估.md` §3.1。
 */

/** 形态常量（与 `specs/109-jitless/spec.md` §3 术语一致） */
export const NODE_MODE_JIT: string = 'jit';
export const NODE_MODE_COMPAT: string = 'compat';

/** JIT 所需的 ACL（`system_basic` + `provisionEnable`，仅 `jit` 形态声明） */
const ACL_WRITABLE_CODE_MEMORY: string = 'ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY';

/** 形态判定结果（含依据：只报形态不报依据，出问题时无法归因） */
export class NodeModeDecision {
  readonly mode: string;
  readonly reason: string;

  constructor(mode: string, reason: string) {
    this.mode = mode;
    this.reason = reason;
  }

  /** 是否 compat（= 需要 `--jitless` + 载荷兼容层） */
  isCompat(): boolean {
    return this.mode === NODE_MODE_COMPAT;
  }

  /** 交给 `NodeRuntimeOptions.jitless` 的取值（库负责把 `--jitless` 排在脚本路径之前） */
  jitless(): boolean {
    return this.isCompat();
  }

  /** 一行可读事实（hilog / 诊断串共用） */
  describe(): string {
    return 'mode=' + this.mode + '（依据：' + this.reason + '）';
  }
}

/**
 * 探测 JIT ACL 当前是否被授予 —— **只用于诊断**。
 *
 * 为什么用 `checkAccessTokenSync` 而不是 `requestPermissionsFromUser`：ACL 是签名 Profile
 * 授予的系统级权限，运行期申请不会弹窗也不会通过；这里只需要「现在有没有」。
 * 查询失败（未声明该权限、API 变更）按「未授予」记录，不影响形态。
 */
export function probeJitAclDetail(): string {
  try {
    const info: bundleManager.BundleInfo = bundleManager.getBundleInfoForSelfSync(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
    const tokenId: number = info.appInfo.accessTokenId;
    const manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
    // 权限名是常量，但 API 要求字面量联合类型 ⇒ 显式断言（与 HostCapabilities 同口径）
    const status: abilityAccessCtrl.GrantStatus =
      manager.checkAccessTokenSync(tokenId, ACL_WRITABLE_CODE_MEMORY as Permissions);
    return ACL_WRITABLE_CODE_MEMORY + ' → ' + status;
  } catch (e) {
    return '权限查询失败（不影响形态）：' + JSON.stringify(e);
  }
}

/**
 * 解析本次启动形态。
 *
 * 非法常量值 fail-safe 到 `compat`（宁慢不崩）。切到 jit 的唯一方式：
 * `node scripts/set-node-mode.mjs jit` 后重新构建。
 */
export function resolve(): NodeModeDecision {
  const built: string = NODE_MODE === NODE_MODE_JIT ? NODE_MODE_JIT : NODE_MODE_COMPAT;
  const reason: string = '编译期常量 BuildConfig.NODE_MODE=' + built
    + '（运行期不可切换）｜诊断读数：' + probeJitAclDetail();
  return new NodeModeDecision(built, reason);
}
