/**
 * Lazy loader for the plugin's two third-party runtimes: `isomorphic-git` (the pure-JS git
 * implementation, materialized into the plugin's **own** `node_modules/` by `collectGitRuntime()`)
 * and `diff` (jsdiff, used to render unified diffs — **not** shipped here: it comes from the host
 * dependency closure).
 *
 * Both are resolved by Node from `node_modules` as usual. Loading is deliberately **lazy and on
 * first use**: a missing or
 * broken dependency must surface as a clear per-call error, never as a boot-time failure of
 * the whole host plugin tree (a host-plane row that throws during `apply()` leaves no
 * `__hostError` trace and is very hard to attribute — see `../dsh-desktop-hos/docs/204-插件-GIT.md` F11).
 *
 * @module @dsh-ohos/git/runtime
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** Pinned isomorphic-git version. Keep in sync with `collectGitRuntime()` in `scripts/collect-dsh.mjs`. */
export const ISOMORPHIC_GIT_VERSION = '1.44.2'

/**
 * The jsdiff **major** this plugin's diff rendering is written against. The exact version is the
 * host closure's business (dsh declares `diff ^9.0.0`); only the major is a contract, and
 * {@link loadDiff} asserts it.
 */
export const SUPPORTED_JSDIFF_MAJOR = 9

/** @type {Promise<{ git: object, http: object }> | undefined} */
let gitBundle

/** @type {Promise<object> | undefined} */
let diffModule

/**
 * The remedy text for a dependency this plugin vendors itself (currently only isomorphic-git).
 * @type {string}
 */
const VENDORED_REMEDY = 'It is materialized into the payload by collectGitRuntime() in '
  + 'scripts/assemble-payload.mjs (node_modules/@dsh-ohos/git/node_modules); a payload assembled '
  + 'before that step, or a re-installed HAP whose payload was not re-extracted, produces this error.'

/**
 * The remedy text for `diff`, which is **not** vendored — it comes from the host closure.
 * @type {string}
 */
const HOST_DIFF_REMEDY = 'It is provided by the host dependency closure (dsh itself depends on '
  + 'diff ^9.0.0) and routed into profile packages by app-boot profile resolution; a dsh-dist whose '
  + 'closure lacks it produces this error.'

/**
 * Wrap a missing/broken dependency in a message that names the exact remedy.
 * @param name - the package that failed to load.
 * @param error - the underlying load error.
 * @param remedy - the sentence naming where that package is supposed to come from.
 * @returns an error the model can act on.
 */
function unavailable(name, error, remedy = VENDORED_REMEDY) {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`@dsh-ohos/git: the dependency "${name}" is not loadable in this deployment (${detail}). ${remedy}`)
}

/**
 * Load isomorphic-git together with its Node HTTP client.
 * @returns the git namespace and the `http/node` client, with the version asserted.
 */
export async function loadGit() {
  gitBundle ??= (async () => {
    let git
    let http
    try {
      git = await import('isomorphic-git')
    } catch (error) {
      throw unavailable('isomorphic-git', error)
    }
    try {
      http = await import('isomorphic-git/http/node')
    } catch (error) {
      throw unavailable('isomorphic-git/http/node', error)
    }
    // `version()` reports the runtime version of the loaded package itself, so a drifted
    // closure cannot pass silently.
    const actual = typeof git.version === 'function' ? await git.version() : 'unknown'
    if (actual !== ISOMORPHIC_GIT_VERSION && actual !== 'unknown') {
      throw new Error(
        `@dsh-ohos/git: isomorphic-git ${actual} is loaded but this plugin is written against `
        + `${ISOMORPHIC_GIT_VERSION}. Re-run collectGitRuntime() or update ISOMORPHIC_GIT_VERSION and `
        + 're-verify docs/204-插件-GIT.md.',
      )
    }
    return { git, http, version: actual }
  })()
  return gitBundle
}

/**
 * Load jsdiff **from the host closure** — this plugin does not vendor it.
 *
 * `diff@^9.0.0` is a declared dependency of dsh's own packages (`fs/tool-fs`,
 * `deliverables/workspace-changes`, `client/ui-trajectory`, `client/ui-primitives`), and dsh's
 * `app-boot` profile resolution routes a profile package's bare requests into the host closure
 * (`dsh-dist/node_modules`). Reuse is therefore the intended pattern, and it avoids shipping a
 * second, shadowing copy of a library already in the image. Verified on device: resolving
 * `diff` from this plugin's own directory answers `dsh-dist/node_modules/diff@9.0.0`.
 *
 * The reuse is guarded rather than assumed: only `createTwoFilesPatch` is consumed, that entry
 * point is asserted outright, and the host's major version is checked whenever it can be read — a
 * host upgrade can move the major without touching this plugin, while an unreadable manifest is not
 * treated as evidence of a mismatch.
 *
 * @returns the jsdiff module namespace.
 * @throws when `diff` is unresolvable, its major version moved, or the entry point is missing.
 */
export async function loadDiff() {
  diffModule ??= (async () => {
    let mod
    try {
      mod = await import('diff')
    } catch (error) {
      throw unavailable('diff', error, HOST_DIFF_REMEDY)
    }
    const actual = readPackageVersion('diff')
    // A host that stops exporting `./package.json` makes the version unreadable. That is not
    // evidence of a wrong major, and the entry-point assertion below still proves the API this
    // plugin consumes — so an unreadable version warns instead of disabling every diff tool, which
    // is what an unconditional major check did.
    const major = Number.parseInt(String(actual).split('.')[0], 10)
    if (Number.isNaN(major)) {
      console.warn(`@dsh-ohos/git: the host's diff version could not be read (${actual}); this `
        + `plugin renders unified diffs against major ${SUPPORTED_JSDIFF_MAJOR}, and the `
        + 'createTwoFilesPatch assertion below is the check that still holds.')
    } else if (major !== SUPPORTED_JSDIFF_MAJOR) {
      throw new Error(
        `@dsh-ohos/git: the host provides diff ${actual}, but this plugin renders unified diffs `
        + `against major ${SUPPORTED_JSDIFF_MAJOR} (docs/204-插件-GIT.md §7.3). Either keep the host `
        + 'dependency on that major, or re-verify the diff rendering against the new one and update '
        + 'SUPPORTED_JSDIFF_MAJOR.',
      )
    }
    if (typeof mod.createTwoFilesPatch !== 'function') {
      throw new Error(
        `@dsh-ohos/git: the host's diff ${actual} exposes no createTwoFilesPatch, so unified diffs `
        + 'cannot be rendered. Re-check that the host dependency closure still ships diff.',
      )
    }
    return mod
  })()
  return diffModule
}

/**
 * Read an installed dependency's version from its own manifest, so the assertions above report the
 * version that is actually on disk rather than the one this plugin hoped for.
 * @param name - the package whose manifest to read.
 * @returns the version string, or `'unknown'` when the manifest cannot be read.
 */
function readPackageVersion(name) {
  try {
    const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`)
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
