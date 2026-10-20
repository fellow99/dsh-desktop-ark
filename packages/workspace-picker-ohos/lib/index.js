/**
 * `@dsh-ohos/workspace-picker` — `ctx.directoryPicker` with a four-root fence.
 *
 * Shape (upstream seam: `packages/host/directory-picker/src/index.ts:104-113`):
 * the service exposes the stable `browse` capability (`list` / `createDirectory`),
 * exactly what the wire controller (`packages/api/workspace-controller/src/directory-picker.ts`)
 * drives. Listing and creation are delegated to
 * `@deepseek-ai/dsh-host-directory-picker-browse`
 * (`packages/host/directory-picker-browse/src/index.ts:199-323`); this package
 * never implements filesystem access itself.
 *
 * The one thing this package adds is the ROOT FENCE (a security property, not a
 * bug):
 * - only four roots are addressable: the sandbox workspace and
 *   `Desktop`/`Documents`/`Download` under the fixed user root;
 * - `..` segments, relative paths, and paths outside every root are refused;
 * - a listed directory must canonicalize inside its root (a symlink cannot
 *   escape), and entries that canonicalize outside are dropped with a
 *   `fencedOut` count;
 * - breadcrumbs are truncated to the root, and there is no "type a path"
 *   entry point — the capability surface only accepts paths produced by the
 *   browser.
 *
 * Delegation detail: two plugins cannot register the same cordis service name
 * (`vendor/cordis/src/reflect.ts:289-291`). If a browse provider is already
 * registered in this scope (and is not us), its capability is used directly.
 * Otherwise the upstream browse backend is mounted into an ISOLATED child
 * context (`ctx.isolate('directoryPicker')`, `vendor/cordis/src/context.ts:121`),
 * so its registration cannot collide with this service. When the backend is not
 * resolvable the capability fails with `directory-picker/unavailable` — never a
 * silent fallback.
 *
 * @module @dsh-ohos/workspace-picker
 */

import { realpathSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { invoke as invokeHost, USER_CHOICE_TIMEOUT_MS } from '@dsh-ohos/host-bridge'
import { registerPickerRoutes } from './routes.js'

export { registerPickerRoutes }

/**
 * Root ids in the fixed tab order.
 *
 * 「桌面」已按 2026-10-19 的真机测试结论移除：桌面目录需要
 * `ohos.permission.READ_WRITE_DESKTOP_DIRECTORY`（system_basic ⇒ 需 ACL），
 * 而工作区选择的真实用途只在沙箱与用户文档/下载；撤销该权限后选择器不再有桌面 Tab
 * （见 `docs/ACL配置.md` §1）。
 */
export const ROOT_IDS = Object.freeze(['sandbox', 'documents', 'download'])

/** Fixed user directory names (`Constants.ets` USER_ROOT 下的真实目录名). */
export const USER_DIR_NAMES = Object.freeze({
  documents: 'Documents',
  download: 'Download',
})

/**
 * OHOS permissions consumed by each user root.
 *
 * 两项都是 `normal` + `user_grant`（**不需要 ACL**，安装即声明，运行期由用户授权），
 * 因此点 Tab 只做“查询”，授权动作由用户在对话框里点「请求权限」触发。
 */
export const ROOT_PERMISSIONS = Object.freeze({
  documents: 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  download: 'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
})

/** Environment variables set by the ArkTS runtime (`DshRuntime.ets:118-123`). */
export const WORKSPACE_ENV = 'DSH_OHOS_WORKSPACE'
export const USER_ROOT_ENV = 'DSH_OHOS_USER_ROOT'

/** Complete-result bound of one listing level (upstream browse default). */
export const MAX_ENTRIES = 1_000

/** Closed failure vocabulary (`packages/host/directory-picker/src/index.ts:75`). */
export const DIRECTORY_PICKER_ERROR_CODES = Object.freeze([
  'directory-unreadable',
  'directory-exists',
  'directory-create-failed',
])

/** Typed failure mirrored from the upstream seam (same `name`/`code`/`path`). */
export class DirectoryPickerError extends Error {
  /**
   * @param {'directory-unreadable'|'directory-exists'|'directory-create-failed'} code
   * @param {string} path
   * @param {string} message
   */
  constructor(code, path, message) {
    super(message)
    this.name = 'DirectoryPickerError'
    this.code = code
    this.path = path
  }
}

function trimmedRoot(value) {
  return value.replace(/[\\/]+$/, '')
}

/**
 * Resolve the four root descriptors from plugin config + runtime environment.
 * Absolute paths only; `process.cwd()` is never consulted (on device it is `/`).
 * @param {{ sandboxRoot?: string, userRoot?: string, roots?: string[] }} [config]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ id: string, name: string, path: string, kind: 'sandbox'|'user', permission?: string }>}
 */
export function resolveRoots(config = {}, env = process.env) {
  const sandboxRoot = config.sandboxRoot ?? env[WORKSPACE_ENV]
  if (typeof sandboxRoot !== 'string' || !isAbsolute(sandboxRoot)) {
    throw new Error(
      `workspace-picker: sandboxRoot must be an absolute path (config.sandboxRoot or ${WORKSPACE_ENV}); process.cwd() is never used`,
    )
  }
  // 默认只暴露有实际用途、且不需要 ACL 的两个用户目录（桌面已移除，见 ROOT_IDS 注释）。
  const requested = config.roots ?? ['documents', 'download']
  if (!Array.isArray(requested)) throw new Error('workspace-picker: roots must be an array of root ids')
  const userRoot = config.userRoot ?? env[USER_ROOT_ENV]
  const roots = [{ id: 'sandbox', name: 'Sandbox', path: trimmedRoot(sandboxRoot), kind: 'sandbox' }]
  for (const id of requested) {
    if (!Object.hasOwn(USER_DIR_NAMES, id)) {
      throw new Error(`workspace-picker: unknown root id ${JSON.stringify(id)}; expected one of ${Object.keys(USER_DIR_NAMES).join(', ')}`)
    }
    if (typeof userRoot !== 'string' || !isAbsolute(userRoot)) {
      throw new Error(`workspace-picker: userRoot must be an absolute path when user roots are requested (config.userRoot or ${USER_ROOT_ENV})`)
    }
    roots.push({
      id,
      name: USER_DIR_NAMES[id],
      path: join(trimmedRoot(userRoot), USER_DIR_NAMES[id]),
      kind: 'user',
      permission: ROOT_PERMISSIONS[id],
    })
  }
  return roots
}

/**
 * Reject relative paths and any `..` segment before the path is resolved.
 * @param {string} path
 * @returns {void}
 * @throws {DirectoryPickerError}
 */
export function assertNoTraversal(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    throw new DirectoryPickerError('directory-unreadable', String(path), `cannot use "${path}": not a fully qualified path`)
  }
  if (path.includes('\0')) {
    throw new DirectoryPickerError('directory-unreadable', path, 'cannot use a path containing NUL')
  }
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === '..') {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot use "${path}": parent traversal is not allowed (root fence)`)
    }
  }
}

/**
 * Lexical containment after `resolve()` (which collapses `.`/`..`).
 * @param {string} candidate
 * @param {string} root
 * @returns {boolean}
 */
export function isWithin(candidate, root) {
  if (typeof candidate !== 'string' || typeof root !== 'string' || candidate === '' || root === '') return false
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel))
}

function samePath(left, right) {
  const normalize = value => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
  return normalize(left) === normalize(right)
}

/**
 * Find the root that contains `path`.
 * @param {string} path
 * @param {Array<{ id: string, path: string }>} roots
 * @returns {{ id: string, name: string, path: string, kind: string, permission?: string } | undefined}
 */
export function findRoot(path, roots) {
  return roots.find(root => isWithin(path, root.path))
}

/**
 * Fence one input path against the roots.
 * @param {string} path
 * @param {ReturnType<typeof resolveRoots>} roots
 * @returns {{ root: Record<string, any>, path: string }}
 * @throws {DirectoryPickerError}
 */
export function fencePath(path, roots) {
  assertNoTraversal(path)
  const root = findRoot(path, roots)
  if (root === undefined) {
    throw new DirectoryPickerError('directory-unreadable', path, `cannot use "${path}": outside the allowed roots (root fence)`)
  }
  return { root, path: resolve(path) }
}

/**
 * Truncate a listing's ancestry to the root (breadcrumb fence).
 * @param {Array<{ name: string, path: string, hidden: boolean }>} crumbs
 * @param {string} rootPath
 * @returns {Array<{ name: string, path: string, hidden: boolean }>}
 */
export function truncateCrumbs(crumbs, rootPath) {
  if (!Array.isArray(crumbs)) return []
  const index = crumbs.findIndex(crumb => samePath(crumb.path, rootPath))
  if (index >= 0) return crumbs.slice(index)
  return [{ name: basename(rootPath) || rootPath, path: rootPath, hidden: false }]
}

function canonicalOr(value) {
  try {
    return realpathSync.native(value)
  } catch {
    return value
  }
}

function isPermissionFailure(error) {
  const code = error?.code ?? error?.errno
  return code === 'EACCES' || code === 'EPERM' || String(error?.message ?? '').includes('EACCES')
}

/**
 * `ctx.directoryPicker` for HarmonyOS.
 */
export class OhosDirectoryPicker extends Service {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ sandboxRoot?: string, userRoot?: string, roots?: string[] }} [config]
   */
  constructor(ctx, config) {
    super(ctx, 'directoryPicker')
    this.config = config ?? {}
    this.roots = resolveRoots(this.config)
    this.maxEntries = MAX_ENTRIES
    /** Lazily resolved browse primitives (stable for the service lifetime). */
    this.browseCapability = undefined
    this.capabilityObject = {
      kind: 'browse',
      list: (path, signal) => this.list(path, signal),
      createDirectory: (path, name) => this.createDirectory(path, name),
    }
    // 启动可见性：诊断「服务是否真的注册了」比猜 RPC 是否挂起更快（见 logs/20261019-1）。
    console.log(`[workspace-picker] registered ctx.directoryPicker roots=${this.roots.map((root) => root.id).join(',')}`)
  }

  /**
   * Public root descriptors for the client face.
   * @returns {Array<Record<string, unknown>>}
   */
  rootsDescriptor() {
    return this.roots.map(root => ({ ...root }))
  }

  /**
   * The stable `browse` capability.
   * @returns {{ kind: 'browse', list: Function, createDirectory: Function }}
   */
  capability() {
    return this.capabilityObject
  }

  /**
   * Resolve the browse primitives.
   *
   * 本包自实现（`node:fs` 的 readdir/mkdir），不再委派上游
   * `@deepseek-ai/dsh-host-directory-picker-browse`：上游那套必须在隔离作用域里
   * `isolate()` + 动态 `import()` 现挂，在 OHOS 宿主（`--expose-internals` +
   * app-boot 的解析钩子）上该 import 会把 RPC 永久挂住——客户端停在「加载中…」，
   * 服务端无错误、无响应（HAD-W32 实测）。这两个原语本身只是目录读写，
   * 自实现后同一份围栏逻辑同时约束 list 与 createDirectory。
   * @returns {Promise<{ list: Function, createDirectory: Function }>}
   */
  async browse() {
    if (this.browseCapability !== undefined) return this.browseCapability
    // 只有“别人的” browse 能力才采用。注意 cordis 的服务是**代理**（`existing !== this`
    // 恒真），因此必须比 capability 对象的身份：否则会把自己的 capability 当成外部后端，
    // list → capability.list → list 无限自递归（表现为 RPC 永久挂起，真机踩过这个形态）。
    const existing = this.ctx.get?.('directoryPicker')
    const capability = existing?.capability?.()
    if (
      capability !== undefined &&
      capability !== this.capabilityObject &&
      capability.kind === 'browse' &&
      typeof capability.list === 'function' &&
      typeof capability.createDirectory === 'function'
    ) {
      this.browseCapability = capability
      return capability
    }
    this.browseCapability = {
      kind: 'browse',
      list: (target, signal) => listDirectory(target, this.maxEntries, signal),
      createDirectory: async (parent, name) => {
        const target = join(parent, name)
        await mkdir(target)
        return target
      },
    }
    return this.browseCapability
  }

  /**
   * List one level inside a root.
   * @param {string} [path] - absolute directory; defaults to the sandbox root.
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async list(path, signal) {
    if (process.env.DSH_OHOS_PICKER_TRACE === '1') console.log(`[workspace-picker] list(${String(path)})`)
    const raw = path ?? this.roots[0].path
    const { root, path: target } = fencePath(raw, this.roots)
    signal?.throwIfAborted()
    if (root.id === 'sandbox') {
      try {
        await mkdir(root.path, { recursive: true })
      } catch (error) {
        throw new DirectoryPickerError('directory-unreadable', root.path, `cannot create the sandbox workspace ${root.path}: ${messageOf(error)}`)
      }
    }
    // 用 canonical 两侧比较：Windows 的 8.3 短名（ADMINI~1）会让单侧 realpath 与配置路径对不上。
    const canonicalRoot = canonicalOr(root.path)
    const canonical = canonicalOr(target)
    if (!isWithin(canonical, canonicalRoot) && !isWithin(canonical, root.path)) {
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list "${target}": resolves outside the ${root.id} root (root fence)`)
    }
    let info
    try {
      info = await stat(canonical)
    } catch (error) {
      const failure = new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
      failure.unavailable = true
      // 「设备上根本没这个目录」与「有目录但没授权」必须分开（姊妹工程在 TV 上被 403 误导过）：
      // ENOENT/ENOTDIR ⇒ missing；EACCES/EPERM ⇒ permissionRequired（不在这里申请权限）。
      const code = error?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') failure.missing = true
      if ((code === 'EACCES' || code === 'EPERM') && root.permission !== undefined) failure.permissionRequired = true
      if (root.permission !== undefined) failure.permission = root.permission
      throw failure
    }
    if (!info.isDirectory()) {
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: not a directory`)
    }
    const capability = await this.browse()
    try {
      const listing = await capability.list(canonical, signal)
      return this.normalizeListing(listing, root, canonicalRoot)
    } catch (error) {
      // 不在这里申请权限：点 Tab 只应“判断 + 渲染”。授权动作由对话框里的
      // 「请求权限」按钮显式触发（`requestPermission()`），见 docs/ACL配置.md §2。
      throw this.pickerError(error, target, root)
    }
  }

  /**
   * Create one child directory inside a root.
   * @param {string} path - absolute parent directory.
   * @param {string} name - single path segment.
   * @returns {Promise<string>}
   */
  async createDirectory(path, name) {
    if (process.env.DSH_OHOS_PICKER_TRACE === '1') console.log(`[workspace-picker] createDirectory(${String(path)}, ${String(name)})`)
    const { root, path: parent } = fencePath(path, this.roots)
    if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', resolve(parent, String(name)), `"${name}" is not a single path segment`)
    }
    const canonicalParent = canonicalOr(parent)
    const canonicalRoot = canonicalOr(root.path)
    if (!isWithin(canonicalParent, canonicalRoot) && !isWithin(canonicalParent, root.path)) {
      throw new DirectoryPickerError('directory-create-failed', parent, `cannot create under "${parent}": resolves outside the ${root.id} root (root fence)`)
    }
    if (root.id === 'sandbox') await mkdir(root.path, { recursive: true }).catch(() => {})
    const capability = await this.browse()
    try {
      const created = await capability.createDirectory(canonicalParent, name)
      const canonical = canonicalOr(created)
      if (!isWithin(canonical, canonicalRoot) && !isWithin(canonical, root.path)) {
        throw new DirectoryPickerError('directory-create-failed', created, `created path escapes the ${root.id} root (root fence)`)
      }
      return canonical
    } catch (error) {
      if (error instanceof DirectoryPickerError) throw error
      // 与 list 同口径：不自动弹授权窗，交给对话框的「请求权限」按钮。
      throw this.pickerError(error, canonicalParent, root, 'directory-create-failed')
    }
  }

  /**
   * 探测一个根的**真实可读性**（以文件系统为准，不看权限 API 的返回值）。
   *
   * 为什么以 `readdir` 为准：`checkAccessTokenSync` 在本平台存在**已知假阴性** ——
   * 授权成功后仍回 `-1`（姊妹工程 `perm.check` 的 hint 里记着这条；本工程 2026-10-20
   * 真机复验：`atm dump` 为 `grantStatus=0`、`list()` 能列出真实条目，而同一时刻
   * `perm.check` 仍报 `granted:false`）。权限 API 只用于归因与填空，
   * 「这个目录现在能不能读」只有读一次才知道。
   *
   * @param {Record<string, any>} root
   * @returns {Promise<'readable'|'denied'|'missing'|'unknown'>}
   */
  async probeAccess(root) {
    try {
      await readdir(root.path)
      return 'readable'
    } catch (error) {
      const code = error?.code
      // 目录不存在（设备没有用户主目录体系，如精简/非标准 OpenHarmony）
      // 与「存在但没授权」是两件事：授权成功也读不到不存在的路径（姊妹工程在 TV 上踩过）。
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
      if (code === 'EACCES' || code === 'EPERM') return 'denied'
      return 'unknown'
    }
  }

  /**
   * 授权对话框返回后，文件系统的生效**可能滞后**（真机实测：刚点完「允许」，
   * 紧接着的一次 `readdir` 仍是 `EACCES`，几百毫秒后才通过）。
   * 所以收尾探测要短轮询，而不是只探一次 —— 否则界面会误报「平台没生效」。
   *
   * @param {Record<string, any>} root
   * @param {{ attempts?: number, intervalMs?: number }} [options]
   * @returns {Promise<'readable'|'denied'|'missing'|'unknown'>}
   */
  async probeAccessSettled(root, options = {}) {
    const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 8
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 350
    let last = await this.probeAccess(root)
    for (let i = 1; i < attempts && last === 'denied'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      last = await this.probeAccess(root)
    }
    return last
  }

  /**
   * 查一个 root 的权限状态（**只查不申请**）。
   *
   * 判定顺序：目录缺失 ⇒ 无需权限 ⇒ **真实可读（即已授权）** ⇒ 才去问权限 API。
   * 最后一步只用于「不可读时给出归因」，不用于判定「已授权」（见 `probeAccess`）。
   *
   * @param {string} rootId - `sandbox` / `documents` / `download`
   * @returns {Promise<{ rootId: string, permission?: string, granted: boolean | null, result: string, detail: string }>}
   *   `granted === null` 表示无法判定（宿主桥不可用或目录缺失），调用方不得当作已授权。
   */
  async permission(rootId) {
    const root = this.roots.find((candidate) => candidate.id === rootId)
    if (root === undefined) {
      return { rootId, granted: null, result: 'unknown-root', detail: `unknown root ${JSON.stringify(rootId)}` }
    }
    const access = await this.probeAccess(root)
    if (access === 'missing') {
      return { rootId, permission: root.permission, granted: null, result: 'missing', path: root.path, detail: `root path does not exist: ${root.path}` }
    }
    if (root.permission === undefined) {
      return { rootId, granted: true, result: 'granted', detail: 'no permission required' }
    }
    if (access === 'readable') {
      return { rootId, permission: root.permission, granted: true, result: 'granted', path: root.path, detail: 'readable' }
    }
    try {
      const check = await invokeHost('perm.check', { name: root.permission }, { timeoutMs: 5_000 })
      const apiGranted = check?.granted === true
      return {
        rootId,
        permission: root.permission,
        granted: false,
        result: apiGranted ? 'granted-unreadable' : 'not-granted',
        path: root.path,
        apiGranted,
        detail: apiGranted
          ? '权限 API 报已授权，但目录仍不可读（EACCES/EPERM）：可尝试重新授权，或重启应用后再试'
          : access === 'denied'
            ? 'directory not readable (EACCES): permission not granted'
            : 'permission state undetermined (probe + perm.check both inconclusive)',
      }
    } catch (bridgeError) {
      return {
        rootId,
        permission: root.permission,
        granted: null,
        result: 'unavailable',
        detail: `permission gate unavailable: ${messageOf(bridgeError)}`,
      }
    }
  }

  /**
   * 判断一个根目录在当前设备上是否存在（**只看存在性，不看权限**）。
   * @param {Record<string, any>} root
   * @returns {Promise<'present'|'missing'|'unknown'>}
   */
  async rootAvailability(root) {
    if (root.kind === 'sandbox') return 'present'
    const access = await this.probeAccess(root)
    if (access === 'readable' || access === 'denied') return 'present'
    return access === 'missing' ? 'missing' : 'unknown'
  }

  /**
   * 申请一个 root 的权限（用户显式触发；会弹系统授权窗）。
   *
   * 三条纪律：
   * 1. **已经能读就不弹窗**（`perm.check` 的假阴性会让「已授权」看起来像未授权，
   *    照它弹窗只会重复打扰用户）；
   * 2. 平台可能**根本没有应答**（`authResults: []`；真机上 ATM 会记为
   *    `It does not need to request permission` 并直接 return），所以判定必须以
   *    「申请后再探一次目录」收尾，而不是以 `authResults` 收尾；
   * 3. `0/-1/2` 与「空数组」四种情况分别如实上报，文案不合并。
   *
   * @param {string} rootId
   * @returns {Promise<{ rootId: string, permission?: string, granted: boolean, result: string, detail: string }>}
   */
  async requestPermission(rootId) {
    const root = this.roots.find((candidate) => candidate.id === rootId)
    if (root === undefined) {
      return { rootId, granted: false, result: 'unknown-root', detail: `unknown root ${JSON.stringify(rootId)}` }
    }
    const before = await this.probeAccess(root)
    if (before === 'missing') {
      return { rootId, permission: root.permission, granted: false, result: 'missing', path: root.path, detail: `root path does not exist: ${root.path}` }
    }
    if (root.permission === undefined) return { rootId, granted: true, result: 'granted', detail: 'no permission required' }
    if (before === 'readable') {
      return {
        rootId,
        permission: root.permission,
        granted: true,
        result: 'granted',
        authResult: null,
        path: root.path,
        detail: 'already readable: directory lists successfully, no system prompt needed',
      }
    }
    try {
      const request = await invokeHost('perm.request', { names: [root.permission] }, { timeoutMs: USER_CHOICE_TIMEOUT_MS })
      const raw = Array.isArray(request?.authResults) ? request.authResults : []
      const authResult = raw.length > 0 ? raw[0] : undefined
      // 申请之后再探一次（短轮询：授权生效可能滞后几百毫秒）：这才是「现在能不能用」的唯一事实。
      const after = await this.probeAccessSettled(root)
      const readable = after === 'readable'
      // SDK 语义（`security/PermissionRequestResult.d.ts`）：0=已授予、-1=未授予（用户拒绝）、2=请求无效。
      const result = readable
        ? 'granted'
        : authResult === 0
          ? 'granted-unreadable'
          : authResult === -1
            ? 'denied'
            : authResult === 2
              ? 'invalid'
              : 'unknown'
      return {
        rootId,
        permission: root.permission,
        granted: readable,
        result,
        authResult: authResult ?? null,
        authResults: raw,
        path: root.path,
        detail:
          result === 'granted'
            ? `granted: directory readable (authResults=${JSON.stringify(raw)})`
            : result === 'granted-unreadable'
              ? 'authResult=0（平台报已授予）但目录仍不可读：多为授权态与实际 token 不一致，重启应用后再试'
              : result === 'denied'
                ? 'denied by user (authResult=-1); 系统在"曾被拒绝/已撤销"后不再弹窗，只能去系统设置里手动开启'
                : result === 'invalid'
                  ? 'request void (authResult=2); 平台不受理该运行时请求（常见于手机形态或应用不在前台）'
                  : `平台未受理本次申请（authResults=${JSON.stringify(raw)}，且目录仍不可读）：` +
                    '该权限的 grantFlag 已带 SYSTEM_GRANT（安装期由签名 profile 的 acls 写入）而 grantStatus 仍为 -1，' +
                    '系统既不弹窗也不授予。处置见 docs/ACL配置.md §5：复位授权态或重签 profile。',
      }
    } catch (bridgeError) {
      return {
        rootId,
        permission: root.permission,
        granted: false,
        result: 'unavailable',
        detail: `permission gate unavailable: ${messageOf(bridgeError)}`,
      }
    }
  }

  /**
   * Map a backend failure to the seam's typed error.
   * @param {unknown} error
   * @param {string} path
   * @param {Record<string, any>} root
   * @param {'directory-unreadable'|'directory-create-failed'} [fallbackCode]
   * @returns {DirectoryPickerError}
   */
  pickerError(error, path, root, fallbackCode = 'directory-unreadable') {
    if (error instanceof DirectoryPickerError) return error
    const code = DIRECTORY_PICKER_ERROR_CODES.includes(error?.code) ? error.code : fallbackCode
    const failure = new DirectoryPickerError(code, path, messageOf(error))
    const denied = error?.code === 'EACCES' || error?.code === 'EPERM'
    if (root.permission !== undefined) failure.permission = root.permission
    if (this.permissionHint !== undefined) {
      failure.hint = this.permissionHint
      this.permissionHint = undefined
    }
    if (denied) failure.denied = true
    // 客户端据此区分「没有权限」与「目录不存在/不可读」：只有 denied 才渲染授权按钮。
    if (denied && root.permission !== undefined) failure.permissionRequired = true
    return failure
  }

  /**
   * Truncate ancestry and enforce containment on every entry.
   * @param {Record<string, any>} listing
   * @param {Record<string, any>} root
   * @param {string} [rootPath] - root 的 canonical 形式（Windows 8.3 短名场景必需）
   * @returns {Record<string, any>}
   */
  normalizeListing(listing, root, rootPath = root.path) {
    const entries = []
    let fencedOut = 0
    const inside = (candidate) => isWithin(candidate, rootPath) || isWithin(candidate, root.path)
    for (const entry of listing.entries ?? []) {
      const canonical = canonicalOr(entry.path)
      if (!inside(entry.path) || !inside(canonical)) {
        fencedOut += 1
        continue
      }
      entries.push({ ...entry, path: canonical })
    }
    return {
      path: canonicalOr(listing.path),
      home: listing.home,
      crumbs: truncateCrumbs(listing.crumbs ?? [], rootPath),
      entries,
      truncated: listing.truncated === true,
      root: root.id,
      roots: this.rootsDescriptor(),
      ...(fencedOut > 0 ? { fencedOut } : {}),
    }
  }
}

/**
 * List one directory level with the shape the browser surface expects.
 * 只返回可进入的子目录（与上游 browse `directoryRow` 同口径），隐藏项打 `hidden`。
 * @param {string} target - 绝对目录路径
 * @param {number} maxEntries - 单层条目上限
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ path: string, home: string, crumbs: Array<{name: string, path: string, hidden: boolean}>, entries: Array<{name: string, path: string, hidden: boolean}>, truncated: boolean }>}
 */
async function listDirectory(target, maxEntries, signal) {
  signal?.throwIfAborted()
  const dirents = await readdir(target, { withFileTypes: true })
  const rows = []
  for (const dirent of dirents) {
    let enterable = dirent.isDirectory()
    if (!enterable && dirent.isSymbolicLink()) {
      // 设备上通常没有 symlink；有则按目标类型判定（失败即视为不可进入，不猜）。
      try {
        enterable = (await stat(join(target, dirent.name))).isDirectory()
      } catch {
        enterable = false
      }
    }
    if (!enterable) continue
    rows.push({ name: dirent.name, path: join(target, dirent.name), hidden: dirent.name.startsWith('.') })
  }
  rows.sort((left, right) => left.name.localeCompare(right.name))
  const truncated = rows.length > maxEntries
  return {
    path: target,
    home: target,
    crumbs: buildCrumbs(target),
    entries: truncated ? rows.slice(0, maxEntries) : rows,
    truncated,
  }
}

/**
 * Ancestry of an absolute path as crumbs（从 `/` 到自身）。
 * @param {string} target
 * @returns {Array<{ name: string, path: string, hidden: boolean }>}
 */
function buildCrumbs(target) {
  const crumbs = []
  let current = resolve(target)
  for (;;) {
    const name = basename(current) || current
    crumbs.unshift({ name, path: current, hidden: name.startsWith('.') })
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return crumbs
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cordis 插件名（函数式插件；`default` 导出本函数见文件末尾）。
 *
 * 刻意**不声明模块级 `inject`**：`ctx.directoryPicker` 必须在插件加载时立刻注册，
 * 否则上游 `directoryPickerController`（`static inject = ['directoryPicker']`）的 fiber
 * 会停在 PENDING，客户端 RPC 永久挂起。路由需要 `webServer`/`connection`，
 * 因此放在 `ctx.inject([...])` 的子 fiber 里注册。
 */
export const name = 'workspace-picker'

/**
 * 插件入口：先注册服务，再在子 fiber 里挂对话框用的 HTTP 路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ sandboxRoot?: string, userRoot?: string, roots?: string[] }} [config]
 */
export function apply(ctx, config) {
  const picker = new OhosDirectoryPicker(ctx, config ?? {})
  ctx.inject(['webServer', 'connection'], (scoped) => registerPickerRoutes(scoped, picker))
}

export default apply
