/**
 * Host half of `@dsh-ohos/market`: publishes the two services `dsh-market`
 * feature-detects — `desktopProfiles` and `desktopPnpm` — so every plugin
 * add/remove runs **in-process** (pure-JS pnpm inside a worker thread) instead
 * of spawning node/pnpm children, which this platform kills with SIGSYS.
 *
 * Contract sources (read-only, never patched):
 * - `dsh-market/src/index.ts` → `ctx.get('desktopProfiles')` then
 *   `hostCtx.inject(['desktopPnpm'], …)` and `createDesktopPluginRuntime(service, current.dir)`.
 * - `dsh-market/src/dsh-cli.ts` → `DesktopPnpmLike.runPlugin(args, invokingDir, signal)`
 *   returns `{ stdout, stderr, done, cancel }`.
 *
 * Named exports only: a default export makes the Loader discard `inject`.
 *
 * @module @dsh-ohos/market
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  assertPnpmEngine,
  getLastRun,
  probeWorker,
  resolveEngineEntry,
  runPnpmInProcess,
} from './pnpm-inprocess.js'

/** Plugin name used by Loader diagnostics. */
export const name = 'market-ohos'

/** Log prefix, matching the rest of the OHOS seam plugins. */
const LOG_PREFIX = '[dsh-ohos]'

/**
 * The launched profile, taken **only** from the launcher's `profileContext`
 * (provided by `@deepseek-ai/dsh/profile-boot` before any config-tree entry
 * mounts). No `DSH_HOME` fallback: this app keeps its profile inside the
 * payload generation, so a synthesized path would make pnpm "succeed" into an
 * empty directory the Loader never reads.
 *
 * @param {unknown} profileContext - `ctx.get('profileContext')`.
 * @returns {{ name: string, dir: string } | null} the profile facts, or null when unusable.
 */
export function launchedProfile(profileContext) {
  if (profileContext === null || typeof profileContext !== 'object') return null
  const shape = /** @type {{ name?: unknown, dir?: unknown }} */ (profileContext)
  const profileName = typeof shape.name === 'string' ? shape.name.trim() : ''
  const dir = typeof shape.dir === 'string' ? shape.dir.trim() : ''
  if (dir === '' || !isAbsolute(dir)) return null
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  return { name: profileName === '' ? 'ohos' : profileName, dir }
}

/**
 * Publish `desktopProfiles` / `desktopPnpm` on the host context before the
 * market bundle mounts.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context of this row.
 */
export function apply(ctx) {
  const log = (line) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('market') : undefined
      if (logger !== undefined && typeof logger.info === 'function') logger.info(line)
      else console.log(`${LOG_PREFIX} market: ${line}`)
    } catch {
      console.log(`${LOG_PREFIX} market: ${line}`)
    }
  }

  const launched = launchedProfile(ctx.get('profileContext'))
  if (launched === null) {
    // Fail closed and loud: without a real profile directory the market would
    // silently install into the wrong place. Not providing the services sends
    // it down its ordinary CLI branch, which reports its own failure.
    console.error(
      `${LOG_PREFIX} market: profileContext.dir unavailable; desktopProfiles/desktopPnpm NOT provided `
      + '(market install channel will fail closed)',
    )
    return
  }

  const engineEntry = resolveEngineEntry()
  const engineOk = assertPnpmEngine(engineEntry)

  const diagnostics = {
    profile: launched.name,
    profileDir: launched.dir,
    engineEntry,
    engineOk,
    worker: 'unknown',
    workerError: null,
    lastRun: null,
  }

  ctx.provide('desktopProfiles', { current: { name: launched.name, dir: launched.dir } })

  ctx.provide('desktopPnpm', {
    /**
     * Run one pnpm command in-process, per the market's `DesktopPnpmLike`.
     * @param {readonly string[]} args - pnpm argv, e.g. `['add', '-w', 'pkg@1.2.3']`.
     * @param {string} _invokingDir - ignored: the launched profile directory is authoritative.
     * @param {AbortSignal} [signal] - the market's abort signal.
     */
    runPlugin(args, _invokingDir, signal) {
      const argv = Array.isArray(args) ? args.map((value) => String(value)) : []
      const handle = runPnpmInProcess(argv, { dir: launched.dir, signal })
      handle.done
        .then((outcome) => {
          diagnostics.lastRun = { args: argv, exitCode: outcome.exitCode, at: Date.now() }
        })
        .catch(() => {})
      return handle
    },
    /** Engine readiness (the desktop branch never reads this; kept for diagnostics). */
    probePnpm() {
      return Promise.resolve(assertPnpmEngine(resolveEngineEntry()))
    },
  })

  try {
    globalThis.__dshOhosMarket = diagnostics
  } catch {
    // A frozen global is not worth failing startup over.
  }

  log(
    `desktopProfiles/desktopPnpm provided (profile=${launched.name} dir=${launched.dir}`
    + ` engine=${engineEntry ?? '(unset)'} engineOk=${engineOk})`,
  )

  // Worker capability probe: facts only, never blocks or fails startup.
  probeWorker()
    .then((result) => {
      diagnostics.worker = result.ok ? 'ok' : 'failed'
      diagnostics.workerError = result.ok ? null : result.detail
      diagnostics.lastRun = getLastRun() ?? diagnostics.lastRun
      log(`worker=${diagnostics.worker}${result.ok ? '' : ` (${result.detail})`}`)
    })
    .catch((error) => {
      diagnostics.worker = 'failed'
      diagnostics.workerError = error instanceof Error ? error.message : String(error)
      log(`worker=failed (${diagnostics.workerError})`)
    })
}
