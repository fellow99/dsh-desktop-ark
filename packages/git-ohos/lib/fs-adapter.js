/**
 * The `fs` adapter handed to every isomorphic-git call.
 *
 * isomorphic-git needs plain POSIX-ish file semantics (`readFile`/`writeFile`/`unlink`/
 * `readdir`/`mkdir`/`rmdir`/`stat`/`lstat` + optional `readlink`/`symlink`/`chmod`), which the
 * `ctx.fs` seam does not expose — the seam has no mkdir/rmdir/unlink/rename/symlink at all.
 * So this adapter talks to `node:fs/promises` directly, and pays for it by enforcing the one
 * boundary the whole design rests on:
 *
 * > **Every path is resolved against a single repository root and must stay inside it.**
 *
 * The root comes from `fence.js` (already resolved through `ctx.fs` and, when it lies outside
 * the session workspace, already approved through the sandbox-escalation channel). Containment
 * is re-checked on **every** call, so a `..` segment, an absolute path, or a symlink that
 * escapes the root is refused before any I/O happens — see `../dsh-desktop-hos/docs/204-插件-GIT.md` §8.
 *
 * @module @dsh-ohos/git/fs-adapter
 */

import { promises as nodeFs, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** Error thrown when a request would leave the repository root. */
export class PathOutsideRepositoryError extends Error {
  /**
   * @param requestPath - the offending path as requested.
   * @param root - the repository root it had to stay inside.
   */
  constructor(requestPath, root) {
    super(
      `@dsh-ohos/git: refusing "${requestPath}" because it resolves outside the repository root `
      + `"${root}". Git operations are confined to one repository.`,
    )
    this.name = 'PathOutsideRepositoryError'
  }
}

/**
 * Resolve one request path against the repository root and prove it stays inside — **through
 * symbolic links too**.
 *
 * The lexical half catches `..` segments, absolute paths, and sibling directories that merely
 * share a name prefix (`/repo-evil` vs `/repo`). It is necessary but **not sufficient**: a
 * repository can carry a *tracked* symlink, and isomorphic-git hands that link's path straight
 * back to this adapter, so a lexically-clean `root/link/secret` can still name a file outside
 * the root. One tracked symlink in an untrusted clone is all that takes — and on the write side
 * the same trick would turn `git_checkout` into a write outside the fence.
 *
 * The realpath half closes it, and the value returned is the **resolved** path rather than the
 * requested spelling, so the `node:fs` call that follows cannot traverse the link either.
 *
 * @param root - absolute repository root, already vetted by the fence.
 * @param requestPath - the path isomorphic-git asked for.
 * @returns the absolute resolved path to hand to `node:fs`.
 * @throws PathOutsideRepositoryError when the path escapes the root, lexically or through a link.
 */
export function resolveWithin(root, requestPath) {
  const base = normalize(resolve(root))
  const candidate = isAbsolute(requestPath) ? normalize(resolve(requestPath)) : normalize(join(base, requestPath))
  if (candidate !== base) {
    const rel = relative(base, candidate)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new PathOutsideRepositoryError(requestPath, base)
  }

  const realBase = realpathDeepest(base).real
  const { real, tail } = realpathDeepest(candidate)
  // `real` must sit inside the root. The second clause covers "nothing under the root exists
  // yet": both sides then collapse to a common existing ancestor, and the reconstructed path
  // contains no link at all, so it is inside by construction.
  const inside = isWithin(realBase, real) || (tail.length > 0 && isWithin(real, realBase))
  if (!inside) throw new PathOutsideRepositoryError(requestPath, base)
  return tail.length === 0 ? real : join(real, ...tail)
}

/**
 * Realpath of the deepest **existing** ancestor of `target`, plus the trailing segments that do
 * not exist yet.
 *
 * `realpath` answers `ENOENT` for an absent path, and absence is the normal case here: git
 * creates `.git/objects/…` constantly, so a resolver that demanded existence would be unusable.
 * Walking up to the first existing ancestor keeps the check meaningful — that ancestor is what
 * `node:fs` would actually traverse — without inventing a second failure mode.
 *
 * @param target - the absolute path to resolve.
 * @returns the resolved ancestor, and the not-yet-existing segments below it.
 */
function realpathDeepest(target) {
  const tail = []
  let current = target
  for (;;) {
    try {
      return { real: realpathSync(current), tail }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Build the `{ promises }` object isomorphic-git expects, bound to one repository root.
 *
 * The optional trio (`readlink`/`symlink`/`chmod`) is provided on purpose: this platform's
 * filesystems refuse symlink creation with `EACCES`, and `chmod` is silently ignored on
 * hmdfs. Providing the real calls means a repository that needs them fails with the honest
 * underlying error instead of an "unsupported operation" invented here.
 *
 * @param root - absolute repository root, already vetted by the fence.
 * @returns an `fs` object for isomorphic-git, confined to `root`.
 */
export function createRepositoryFs(root) {
  const at = requestPath => resolveWithin(root, requestPath)

  // **Every method below is declared `async` on purpose — it is a hard contract, not a style
  // choice.** isomorphic-git decides whether an `fs` speaks promises or callbacks by *calling
  // `readFile()` with no arguments* and asking whether the result is promise-like
  // (`isPromiseFs` / `isPromiseLike` in its `FileSystem`); a **synchronous** throw counts as
  // "callbacks". Declared as plain arrows returning a promise, `readFile()` threw synchronously
  // (`path.isAbsolute(undefined)`) the moment it was probed, so the library concluded "callback
  // fs", wrapped all eleven commands in `pify`, and then waited for a callback nothing would ever
  // call: every git operation hung forever while the Node event loop stayed healthy — measured on
  // device as `git_init` never returning, with the Electron main thread blocked and the window
  // stuck on "reconnecting". An `async` function cannot throw synchronously: it converts the bad
  // call into a rejected promise, the probe sees a promise, and the library uses these methods
  // directly.
  return {
    promises: {
      /** @param {string} path - path resolved by the repository root. @param {unknown} [options] - node fs options. */
      readFile: async (path, options) => nodeFs.readFile(at(path), options),
      /**
       * @param {string} file - destination path.
       * @param {unknown} data - bytes or text to write.
       * @param {unknown} [options] - node fs options.
       */
      writeFile: async (file, data, options) => nodeFs.writeFile(at(file), data, options),
      /** @param {string} path - path to remove. */
      unlink: async path => nodeFs.unlink(at(path)),
      /** @param {string} path - directory to list. @param {unknown} [options] - node fs options. */
      readdir: async (path, options) => nodeFs.readdir(at(path), options),
      /** @param {string} path - directory to create. @param {unknown} [options] - mode or node fs options. */
      mkdir: async (path, options) => nodeFs.mkdir(at(path), options),
      /** @param {string} path - empty directory to remove. */
      rmdir: async path => nodeFs.rmdir(at(path)),
      /** @param {string} path - path to stat. @param {unknown} [options] - node fs options. */
      stat: async (path, options) => nodeFs.stat(at(path), options),
      /** @param {string} path - path to lstat. @param {unknown} [options] - node fs options. */
      lstat: async (path, options) => nodeFs.lstat(at(path), options),
      /** @param {string} path - symlink to read. @param {unknown} [options] - node fs options. */
      readlink: async (path, options) => nodeFs.readlink(at(path), options),
      /**
       * `rm` is outside isomorphic-git's required eleven, but it is the first thing its `bindFs`
       * looks for when it needs a recursive delete: providing the platform's own implementation
       * avoids falling back to the library's `_readdir` + `_unlink` walk.
       * @param {string} path - path to remove.
       * @param {unknown} [options] - node fs options (for example `{ recursive: true }`).
       */
      rm: async (path, options) => nodeFs.rm(at(path), options),
      /**
       * The link itself must land inside the root; a relative target stays inside by
       * construction, while an absolute target is checked too.
       * @param {string} target - link target.
       * @param {string} path - link path.
       * @param {unknown} [type] - node fs symlink type.
       */
      symlink: async (target, path, type) => {
        const linkPath = at(path)
        // A relative target is resolved against the link's own directory, so `../../..` escapes
        // exactly as an absolute target does — vet the resolved form either way.
        resolveWithin(root, isAbsolute(target) ? target : join(dirname(linkPath), target))
        return await nodeFs.symlink(target, linkPath, type)
      },
      /** @param {string} path - path whose mode to change. @param {number} mode - requested mode bits. */
      chmod: async (path, mode) => nodeFs.chmod(at(path), mode),
    },
  }
}

/**
 * Whether a candidate path lies inside a root, on a path-segment boundary.
 * Shared with the fence so the "is this repository inside the workspace?" question and the
 * per-call containment check use one predicate.
 * @param root - absolute root path.
 * @param candidate - absolute candidate path.
 * @returns true when `candidate` is `root` or below it.
 */
export function isWithin(root, candidate) {
  // Windows paths compare case-insensitively; folding keeps a lexically-correct path from being
  // refused as if it were outside (fail-closed, but a false rejection is still a bug).
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value)
  const base = fold(normalize(resolve(root)))
  const other = fold(normalize(resolve(candidate)))
  if (base === other) return true
  return other.startsWith(base.endsWith(sep) ? base : base + sep)
}
