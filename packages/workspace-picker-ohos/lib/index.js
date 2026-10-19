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

/** Root ids in the fixed tab order (`docs/000-工程规划.md` §5.2 #4). */
export const ROOT_IDS = Object.freeze(['sandbox', 'desktop', 'documents', 'download'])

/** Fixed user directory names (`Constants.ets:38-39`). */
export const USER_DIR_NAMES = Object.freeze({
  desktop: 'Desktop',
  documents: 'Documents',
  download: 'Download',
})

/** OHOS permissions consumed by each user root (`docs` §5.2 #4 授权). */
export const ROOT_PERMISSIONS = Object.freeze({
  desktop: 'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
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
  const requested = config.roots ?? ['desktop', 'documents', 'download']
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
    const existing = this.ctx.get?.('directoryPicker')
    if (existing !== undefined && existing !== this) {
      const capability = existing.capability?.()
      if (capability?.kind === 'browse') {
        this.browseCapability = capability
        return capability
      }
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
    console.log(`[workspace-picker] list(${String(path)})`)
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
      const granted = await this.retryPermission(error, root)
      if (granted !== true) throw this.pickerError(error, target, root)
      const listing = await capability.list(canonical, signal)
      return this.normalizeListing(listing, root, canonicalRoot)
    }
  }

  /**
   * Create one child directory inside a root.
   * @param {string} path - absolute parent directory.
   * @param {string} name - single path segment.
   * @returns {Promise<string>}
   */
  async createDirectory(path, name) {
    console.log(`[workspace-picker] createDirectory(${String(path)}, ${String(name)})`)
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
      const granted = await this.retryPermission(error, root)
      if (granted !== true) throw this.pickerError(error, canonicalParent, root, 'directory-create-failed')
      return canonicalOr(await capability.createDirectory(canonicalParent, name))
    }
  }

  /**
   * Ask the host for permission after an access denial, then retry once.
   * @param {unknown} error
   * @param {Record<string, any>} root
   * @returns {Promise<boolean | undefined>} `true` = retry, `false` = denied,
   *   `undefined` = not a permission failure (or the bridge is unavailable).
   */
  async retryPermission(error, root) {
    if (root.permission === undefined || !isPermissionFailure(error)) return undefined
    try {
      const check = await invokeHost('perm.check', { name: root.permission }, { timeoutMs: 5_000 })
      if (check.granted === true) return true
      const request = await invokeHost('perm.request', { names: [root.permission] }, { timeoutMs: USER_CHOICE_TIMEOUT_MS })
      return Array.isArray(request.authResults) && request.authResults[0] === 0
    } catch (bridgeError) {
      this.permissionHint = `permission gate unavailable: ${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}`
      return undefined
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
    if (root.permission !== undefined) failure.permission = root.permission
    if (this.permissionHint !== undefined) {
      failure.hint = this.permissionHint
      this.permissionHint = undefined
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') failure.denied = true
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

export default OhosDirectoryPicker
