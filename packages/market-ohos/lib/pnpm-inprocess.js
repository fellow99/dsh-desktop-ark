/**
 * In-process pnpm runner: runs the materialized pure-JS pnpm CLI inside a
 * worker thread and adapts it to the market's `DesktopPnpmLike.runPlugin`
 * handle (`{ stdout, stderr, done, cancel }`).
 *
 * No node/pnpm child process is ever spawned: a worker thread is the same OS
 * process, so the platform rule that kills forked JIT children does not apply.
 *
 * Design notes (see `docs/pnpm+dsh-market.md` §3.3):
 * - Completion signal is the **worker exit code**. pnpm's CLI is
 *   fire-and-forget: `import(entry)` resolves long before an install finishes
 *   and the success path never calls `process.exit`, so an in-thread run has no
 *   decidable completion condition. There is deliberately **no in-thread
 *   fallback**; a worker that cannot start fails with 127.
 * - One operation at a time. A second concurrent call throws synchronously:
 *   `dsh-market` classifies a thrown `/another desktop pnpm operation is already running/i`
 *   as `busy`, and a returned handle would be reported as an ordinary failure instead.
 *
 * @module @dsh-ohos/market/pnpm-inprocess
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Worker } from 'node:worker_threads'

/** Worker entry, resolved relative to this module so it ships beside it. */
const WORKER_URL = new URL('./pnpm-worker.mjs', import.meta.url)

/** Busy message the market matches on (`dsh-market/src/dsh-cli.ts:1395-1405`). */
export const BUSY_MESSAGE = 'another desktop pnpm operation is already running'

/** Token of the operation currently holding the single-flight gate. */
let activeOperation = null

/** Facts of the most recent operation, for `--inspect` diagnostics. */
let lastRun = null

/**
 * The materialized pnpm engine entry, from `DSH_PNPM_ENGINE` (set by the Host
 * before `runProfile`).
 * @param {NodeJS.ProcessEnv} [env] - environment, injectable for tests.
 * @returns {string | null} the entry path, or null when unset.
 */
export function resolveEngineEntry(env = process.env) {
  const entry = env.DSH_PNPM_ENGINE
  return typeof entry === 'string' && entry !== '' ? entry : null
}

/**
 * Whether a path is a usable pnpm engine entry: an existing, non-empty file.
 * Never throws.
 * @param {string | null} entry - candidate path.
 * @returns {boolean} true when usable.
 */
export function assertPnpmEngine(entry) {
  if (typeof entry !== 'string' || entry === '') return false
  try {
    const stat = statSync(entry)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/** Facts of the most recent operation (or null). */
export function getLastRun() {
  return lastRun
}

/** Whether an operation is running right now. */
export function isRunning() {
  return activeOperation !== null
}

/**
 * Compose the argv pnpm's CLI expects. The second element is ignored by pnpm;
 * `--dir` makes the launched profile authoritative regardless of `process.cwd()`
 * (which is `/` on device).
 * @param {string} entry - engine entry path.
 * @param {readonly string[]} args - market argv.
 * @param {string} dir - absolute profile directory.
 * @param {string} execPath - value for `argv[0]`.
 * @returns {string[]} argv for the worker realm.
 */
export function composeArgv(entry, args, dir, execPath) {
  return [execPath, entry, ...args.map((value) => String(value)), '--dir', dir]
}

/**
 * Probe whether a worker thread can start and post a message.
 * @param {number} [timeoutMs] - budget; the probe never outlives it.
 * @returns {Promise<{ ok: boolean, detail?: string }>} probe facts, never throws.
 */
export function probeWorker(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let worker
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        void worker?.terminate()
      } catch {
        // The worker may already be gone; the probe result is what matters.
      }
      resolve(result)
    }
    timer = setTimeout(() => finish({ ok: false, detail: `probe timed out after ${timeoutMs} ms` }), timeoutMs)
    timer.unref?.()
    try {
      // `eval: true` compiles the first argument as the worker's source.
      worker = new Worker('require("node:worker_threads").parentPort.postMessage(1)', { eval: true })
    } catch (error) {
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) })
      return
    }
    worker.once('message', () => finish({ ok: true }))
    worker.once('error', (error) => finish({ ok: false, detail: error instanceof Error ? error.message : String(error) }))
    worker.once('exit', (code) => finish(code === 0 ? { ok: true } : { ok: false, detail: `probe exited early (code ${String(code)})` }))
  })
}

/**
 * Run one pnpm command in-process (worker thread).
 *
 * @param {readonly string[]} args - pnpm argv, e.g. `['add', '-w', 'pkg@1.2.3']`.
 * @param {{ dir?: string, entry?: string, signal?: AbortSignal }} [options]
 *   `dir` is the launched profile directory.
 * @returns {{ stdout: import('node:stream').PassThrough, stderr: import('node:stream').PassThrough,
 *   done: Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>, cancel: () => void }}
 * @throws {Error} when another operation is already running (market reads this as `busy`).
 */
export function runPnpmInProcess(args, options = {}) {
  if (activeOperation !== null) {
    throw new Error(BUSY_MESSAGE)
  }

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const entry = options.entry ?? resolveEngineEntry()
  const dir = options.dir
  const token = Symbol('pnpm operation')
  let settled = false
  let cancelled = false
  let resolveDone
  let onAbort
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  const finish = (result) => {
    if (settled) return
    settled = true
    if (activeOperation === token) activeOperation = null
    if (options.signal !== undefined && onAbort !== undefined) options.signal.removeEventListener('abort', onAbort)
    lastRun = { args: args.map((value) => String(value)), dir: dir ?? null, exitCode: result.exitCode, at: Date.now() }
    stdout.end()
    stderr.end()
    resolveDone(result)
  }

  /**
   * Fail without starting a worker but let the caller attach stream listeners
   * first: the write and settlement are deferred to a microtask.
   */
  const failNow = (code, message) => {
    queueMicrotask(() => {
      stderr.write(message)
      finish({ exitCode: code, signal: null })
    })
    return { stdout, stderr, done, cancel() {} }
  }

  if (typeof dir !== 'string' || dir.trim() === '') {
    return failNow(127, '[market-pnpm] no profile directory; refusing to run pnpm\n')
  }
  if (!assertPnpmEngine(entry)) {
    return failNow(
      127,
      `[market-pnpm] pnpm engine entry not found: ${entry ?? '(unset)'} (DSH_PNPM_ENGINE)\n`
      + '[market-pnpm] the engine is materialized by scripts/assemble-payload.mjs (collectMarketPNPM)\n',
    )
  }

  const argv = composeArgv(entry, args, dir, process.execPath)
  activeOperation = token

  let worker
  try {
    worker = new Worker(WORKER_URL, {
      workerData: {
        entry,
        args: argv.slice(2),
        cacheDir: join(dir, '.pnpm-cache'),
        compatEntry: process.env.DSH_OHOS_JITLESS_ENTRY ?? '',
      },
    })
  } catch (error) {
    activeOperation = null
    const detail = error instanceof Error ? error.message : String(error)
    return failNow(127, `[market-pnpm] worker could not start: ${detail}\n`)
  }

  worker.on('message', (message) => {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'stdout') stdout.write(String(message.text))
    else if (message.type === 'stderr') stderr.write(String(message.text))
  })
  worker.on('error', (error) => {
    stderr.write(`[market-pnpm] worker error: ${error && error.stack ? error.stack : String(error)}\n`)
  })
  worker.on('exit', (code) => {
    if (cancelled) {
      stderr.write('[market-pnpm] cancelled: the pnpm operation was terminated\n')
      finish({ exitCode: code === 0 || code === null ? 1 : code, signal: null })
      return
    }
    finish({ exitCode: code ?? 0, signal: null })
  })

  onAbort = () => {
    cancelled = true
    void worker.terminate()
  }
  if (options.signal !== undefined) {
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  return {
    stdout,
    stderr,
    done,
    cancel() {
      cancelled = true
      void worker.terminate()
    },
  }
}
