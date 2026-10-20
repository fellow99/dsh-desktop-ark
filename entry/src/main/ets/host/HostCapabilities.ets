import { abilityAccessCtrl, bundleManager, common, PermissionRequestResult, Permissions, Want } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HostBridge } from '@fellow99/node-bridge';
import { Constants } from '../common/Constants';
import { resolve as resolveNodeMode } from '../common/NodeMode';

interface NameArgs {
  name?: string;
}

interface NamesArgs {
  names?: string[];
}

interface UriArgs {
  uri?: string;
}

/** `image.normalize` 入参（与 `packages/attachment-image-ohos` 的调用面一致） */
interface ImageNormalizeArgs {
  data?: string;
  format?: string;
  quality?: number;
  rotate?: boolean;
  colourspace?: string;
  width?: number;
  height?: number;
  fit?: string;
  withoutEnlargement?: boolean;
  sourceFormat?: string;
}

/** `image.normalize` 成功信封（调用方要 base64 + 实际尺寸） */
interface ImageNormalizeResult {
  ok: boolean;
  data: string;
  format: string;
  width: number;
  height: number;
  channels: number;
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
  /** 请求了几项（用于区分「平台返回空数组」与「参数没送到」） */
  requested: number;
  /** 平台返回的条目数；0 表示系统没有产生任何授权应答（多半是拒绝弹窗） */
  answered: number;
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
    // 图像规范化（S4 的像素后端）：SharpPipeline 的每个像素操作都走这里。
    host.register('image.normalize', (args: string): Promise<string> => HostCapabilities.normalizeImage(context, args));

    // 已注册但未实现：显式返回 not-implemented（宪法 C2）。
    HostCapabilities.notImplemented(host, 'fs.pickFolder', 'workspace-picker 将经 directoryPicker seam 提供；本轮请用 browse 后端');
    HostCapabilities.notImplemented(host, 'fs.pickFiles', '附件导入将在 P2 提供；本轮暂用拖拽/粘贴');
    HostCapabilities.notImplemented(host, 'fs.saveFile', '导出将在 P2 提供');
    HostCapabilities.notImplemented(host, 'notify.show', '通知桥将在 P2 接入 NotificationKit');
    HostCapabilities.notImplemented(host, 'clipboard.readImage', '剪贴板图片将在 P2 接入 pasteboard');
    HostCapabilities.notImplemented(host, 'clipboard.writeText', '剪贴板文本将在 P2 接入 pasteboard');
    HostCapabilities.notImplemented(host, 'power.keepAwake', '长时任务已由 backgroundModes 提供，运行锁将在 P2 接入');
  }

  /**
   * 图像规范化：base64 进 → 解码/缩放/编码 → base64 出。
   *
   * 契约与 `packages/attachment-image-ohos`（S4 的 sharp 替身）一致：
   * `{data, format, quality, width?, height?, withoutEnlargement?}` →
   * `{ok:true, data, format, width, height, channels}`。
   *
   * 像素操作全部在 ArkTS 侧（`@kit.ImageKit`）：jitless 下 WASM 不可用，纯 JS 解码大图
   * 代价过高；设备原生解码既快又能复用系统 ImageKit。
   */
  private static async normalizeImage(context: common.UIAbilityContext, args: string): Promise<string> {
    let source: image.ImageSource | null = null;
    let pixelMap: image.PixelMap | null = null;
    let packer: image.ImagePacker | null = null;
    try {
      const parsed: ImageNormalizeArgs = JSON.parse(args) as ImageNormalizeArgs;
      HostCapabilities.appLog(context, 'image.normalize in: ' + args.length + 'B format=' + String(parsed.format)
        + ' w=' + String(parsed.width) + ' h=' + String(parsed.height)
        + ' noEnlarge=' + String(parsed.withoutEnlargement));
      if (parsed.data === undefined || parsed.data === '') {
        const bad: CapabilityError = { ok: false, error: 'bad-args', hint: 'image.normalize 需要 data(base64)' };
        return JSON.stringify(bad);
      }
      const helper: util.Base64Helper = new util.Base64Helper();
      const bytes: Uint8Array = helper.decodeSync(parsed.data);
      const buffer: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      source = image.createImageSource(buffer);
      const info: image.ImageInfo = await source.getImageInfo();
      const target: image.Size = HostCapabilities.fitInside(info.size, parsed);
      const decoding: image.DecodingOptions = { desiredSize: target, editable: false };
      pixelMap = await source.createPixelMap(decoding);
      HostCapabilities.appLog(context, 'image.normalize decode: src=' + info.size.width + 'x' + info.size.height
        + ' target=' + target.width + 'x' + target.height);

      const requested: string = HostCapabilities.packFormat(parsed.format);
      const quality: number = HostCapabilities.clampQuality(parsed.quality);
      packer = image.createImagePacker();
      let out: ArrayBuffer;
      let usedFormat: string = requested;
      try {
        const option: image.PackingOption = { format: requested, quality: quality };
        out = await packer.packing(pixelMap, option);
      } catch (encodeError) {
        // 部分设备不支持 WebP/PNG 编码 ⇒ 退 JPEG，并**如实**回报实际格式（不伪装）。
        usedFormat = 'image/jpeg';
        const fallback: image.PackingOption = { format: usedFormat, quality: quality };
        out = await packer.packing(pixelMap, fallback);
      }
      const encoded: string = helper.encodeToStringSync(new Uint8Array(out));
      HostCapabilities.appLog(context, 'image.normalize out: ' + out.byteLength + 'B format=' + usedFormat);
      const result: ImageNormalizeResult = {
        ok: true,
        data: encoded,
        format: HostCapabilities.formatName(usedFormat),
        width: target.width,
        height: target.height,
        channels: 4
      };
      return JSON.stringify(result);
    } catch (error) {
      HostCapabilities.appLog(context, 'image.normalize failed: ' + (error instanceof Error ? error.message : String(error)));
      return HostCapabilities.internal('image.normalize', error);
    } finally {
      if (pixelMap !== null) {
        try { await pixelMap.release(); } catch (e) { }
      }
      if (source !== null) {
        try { await source.release(); } catch (e) { }
      }
      if (packer !== null) {
        try { await packer.release(); } catch (e) { }
      }
    }
  }

  /** `fit: 'inside'` + `withoutEnlargement`（与 sharp 的默认语义一致）。 */
  private static fitInside(size: image.Size, args: ImageNormalizeArgs): image.Size {
    let targetW: number = size.width;
    let targetH: number = size.height;
    const w: number | undefined = args.width;
    const h: number | undefined = args.height;
    const hasW: boolean = w !== undefined && w > 0;
    const hasH: boolean = h !== undefined && h > 0;
    if (hasW || hasH) {
      const rw: number = hasW ? (w as number) / size.width : Number.POSITIVE_INFINITY;
      const rh: number = hasH ? (h as number) / size.height : Number.POSITIVE_INFINITY;
      const ratio: number = Math.min(rw, rh);
      const noEnlarge: boolean = args.withoutEnlargement !== false;
      const scale: number = noEnlarge ? Math.min(1, ratio) : ratio;
      if (Number.isFinite(scale)) {
        targetW = Math.max(1, Math.round(size.width * scale));
        targetH = Math.max(1, Math.round(size.height * scale));
      }
    }
    const result: image.Size = { width: targetW, height: targetH };
    return result;
  }

  private static packFormat(name: string | undefined): string {
    if (name === 'png') {
      return 'image/png';
    }
    if (name === 'webp') {
      return 'image/webp';
    }
    return 'image/jpeg';
  }

  private static formatName(mime: string): string {
    if (mime === 'image/png') {
      return 'png';
    }
    if (mime === 'image/webp') {
      return 'webp';
    }
    return 'jpeg';
  }

  private static clampQuality(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
      return 85;
    }
    return Math.max(1, Math.min(100, Math.round(value)));
  }

  /** 追加一行到 `app.log`（与 Node 侧同一份文件；诊断用，失败不影响业务）。 */
  private static appLog(context: common.UIAbilityContext, line: string): void {
    try {
      const path: string = Constants.appLogPath(context);
      const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.APPEND | fs.OpenMode.WRITE_ONLY);
      try {
        fs.writeSync(file.fd, new Date().toISOString() + ' HOST ' + line + String.fromCharCode(10));
      } finally {
        fs.closeSync(file);
      }
    } catch (e) {
      // 诊断写入失败不能影响能力调用
    }
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
        // 109-jitless：如实上报本次进程形态（compat ⇒ true），不得写死
        jitless: resolveNodeMode().jitless()
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
      'runtime.facts', 'log.hilog', 'perm.check', 'perm.request', 'perm.openAppInfo', 'shell.openExternal',
      'image.normalize'
    ];
    const pending: string[] = [
      'fs.pickFolder', 'fs.pickFiles', 'fs.saveFile', 'notify.show',
      'clipboard.readImage', 'clipboard.writeText', 'power.keepAwake'
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

  /** 诊断日志（hilog；权限相关只记状态与数量，不记用户数据）。 */
  private static log(message: string): void {
    hilog.info(Constants.HILOG_DOMAIN, Constants.HILOG_TAG, '%{public}s', message);
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
      HostCapabilities.log(`perm.check：${name} status=${status} tokenId=${tokenId}`);
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
      HostCapabilities.log(`perm.request：申请 ${names.length} 项 ${JSON.stringify(names)}`);
      const result: PermissionRequestResult =
        await manager.requestPermissionsFromUser(context, names as Permissions[]);
      const authResults: number[] = result.authResults ?? [];
      const answeredPermissions: string[] = result.permissions ?? [];
      // 空数组是重要事实（系统没给任何应答），必须连"申请了几项"一起回传，否则调用方
      // 无法区分"平台拒绝受理"与"参数没送到"（真机上就是这样被误读的）。
      HostCapabilities.log(`perm.request：应答 ${answeredPermissions.length} 项 authResults=${JSON.stringify(authResults)}`);
      const payload: PermissionReply = {
        ok: true,
        authResults: authResults,
        permissions: answeredPermissions,
        requested: names.length,
        answered: answeredPermissions.length
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
