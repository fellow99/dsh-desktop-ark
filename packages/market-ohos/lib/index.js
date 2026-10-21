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

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
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
 * 读一个 package.json（读不到/坏 JSON 返回 null，不抛）。
 * @param {string} file - absolute path.
 * @returns {any} parsed manifest or null.
 */
function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把 profile 的 `dsh.profile.bundles` 与它自己的依赖对齐 —— 这是「宿主负责激活」里
 * **持久化**的那一半（我们在 `pluginActivation.activate()` 里调用它）。
 *
 * 规则：
 * 1. 依赖里声明了 `dsh.bundle` 且已装进 profile 的包，追加到 bundles 末尾（保持既有顺序）；
 * 2. 一行只有在「装进了 profile」或「能从安装锚点解析」时才保留 —— 卸载后既不在 profile 里、
 *    也不在安装闭包里的行必须移除，否则下次启动会打一行 “cannot resolve profile bundle”
 *    （`@deepseek-ai/dsh-base` 这类安装态 bundle 走第二条保留）；
 * 3. 其它行原样保留。
 *
 * @param {string} profileDir - absolute profile directory.
 * @param {string} [installAnchor] - absolute path of the running dsh's package.json.
 * @returns {{ changed: boolean, bundles: string[] }} what happened.
 */
export function reconcileProfileBundles(profileDir, installAnchor = '') {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = readManifest(manifestPath)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { changed: false, bundles: [] }

  const dependencies = Object.keys(manifest.dependencies ?? {})
  const installed = (name) => existsSync(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
  // 安装闭包里的 bundle（dsh-base / dsh-web-app / @dsh-ohos/bundle / dshmarket）从这条锚点解析。
  let resolveFromAnchor = () => false
  if (installAnchor !== '') {
    try {
      const anchorRequire = createRequire(installAnchor)
      resolveFromAnchor = (name) => {
        try {
          anchorRequire.resolve(`${name}/package.json`)
          return true
        } catch {
          return false
        }
      }
    } catch {
      resolveFromAnchor = () => false
    }
  }
  const next = [...bundles]
  for (const name of dependencies) {
    if (next.includes(name) || !installed(name)) continue
    const pkg = readManifest(join(profileDir, 'node_modules', ...name.split('/'), 'package.json'))
    if (pkg?.dsh?.bundle === undefined) continue
    next.push(name)
  }
  const kept = next.filter((name) => installed(name) || resolveFromAnchor(name))
  if (JSON.stringify(kept) === JSON.stringify(bundles)) return { changed: false, bundles: kept }
  manifest.dsh.profile.bundles = kept
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { changed: true, bundles: kept }
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

  const profileContext = ctx.get('profileContext')
  const launched = launchedProfile(profileContext)
  const installAnchor = typeof profileContext?.installAnchor === 'string' ? profileContext.installAnchor : ''
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

  ctx.provide('desktopProfiles', {
    current: { name: launched.name, dir: launched.dir },
    /**
     * 本宿主**不能**在线重放组合：`node::Start` 每进程一次、ArkWeb 的客户端模块图在页面加载时
     * 固定，热挂载只会在“当前进程里多挂一份”，客户端那一半要刷新页面才可能出现，而刷新期间
     * 任何一个子资源 404 都会让外壳显示整页错误（看起来像崩溃）。
     *
     * 因此如实声明“激活由宿主负责，但本宿主只支持重启生效”：市场会改走这条路径，
     * 不再自己 hot-mount，安装/卸载后提示重启应用（这也是真机上唯一稳定生效的方式）。
     */
    pluginActivation: {
      async activate() {
        // 持久化由宿主负责：先把 bundles 与本 profile 的依赖对齐（装载/卸载都要），
        // 再如实回答「本宿主不能在线重放，需重启」。
        try {
          const result = reconcileProfileBundles(launched.dir, installAnchor)
          diagnostics.bundles = result.bundles
          if (result.changed) log(`bundles reconciled: ${result.bundles.join(', ')}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`bundle reconcile failed: ${message}`)
          return { ok: false, error: `profile bundles 写入失败：${message}` }
        }
        return {
          ok: false,
          error: '插件已写入 profile；本宿主不支持在线重放，请退出并重新打开应用后生效'
            + ' (installed into the profile; restart the app to activate — this host cannot replay the composition in place)',
        }
      },
    },
  })

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
