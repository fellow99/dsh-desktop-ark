/**
 * Worker entry: run the materialized pure-JS pnpm CLI in a **new realm**.
 *
 * Why a worker (see `docs/pnpm+dsh-market.md` §3.3/§3.4):
 * - pnpm's CLI is fire-and-forget: importing it resolves long before the
 *   install finishes and the success path never calls `process.exit`. A worker
 *   stays alive while pnpm's own work is pending, and its exit code is the
 *   completion signal.
 * - It isolates pnpm's global mutations (`process.argv`, `process.exit`,
 *   `process.execPath`) from the host realm, which runs the whole dsh Host.
 *
 * This realm needs its own platform shims because V8 flags and Node module
 * globals are per-thread: with `--jitless`, `WebAssembly` is undefined here too,
 * so `node:http`'s lazy undici getter must be sealed again before pnpm's network
 * stack (`make-fetch-happen` → `minipass-fetch` → `node:http`) touches it.
 *
 * @module @dsh-ohos/market/pnpm-worker
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

/** Post one captured chunk, tolerating a closed port during teardown. */
function post(type, text) {
  try {
    parentPort.postMessage({ type, text: String(text) })
  } catch {
    // Port closed: the operation is being torn down; nothing left to report to.
  }
}

const entry = String(workerData?.entry ?? '')
const args = Array.isArray(workerData?.args) ? workerData.args.map((value) => String(value)) : []
const cacheDir = typeof workerData?.cacheDir === 'string' ? workerData.cacheDir : ''
const compatEntry = typeof workerData?.compatEntry === 'string' ? workerData.compatEntry : ''

// 1) Platform compatibility layer for THIS realm. A no-op when WASM is available.
//    A failure here is fatal for the run: pnpm's HTTP stack would then die deep inside
//    `WebAssembly is not defined`, one layer away from the root cause.
if (typeof WebAssembly === 'undefined') {
  if (compatEntry === '') {
    post('stderr', '\n[market-pnpm] WebAssembly is unavailable and DSH_OHOS_JITLESS_ENTRY is unset; refusing to run pnpm\n')
    process.exitCode = 1
    throw new Error('jitless realm without a compat entry')
  }
  try {
    const requireFromHere = createRequire(import.meta.url)
    const { installIfNeeded } = requireFromHere(compatEntry)
    const facts = installIfNeeded((line) => post('stderr', `\n[market-pnpm] ${line}\n`))
    post(
      'stderr',
      `\n[market-pnpm] compat active=${String(facts.active)} httpLazy=${String(facts.httpLazy)} fetch=${String(facts.fetch)}\n`,
    )
  } catch (error) {
    post(
      'stderr',
      `\n[market-pnpm] compat layer failed to install: ${error && error.message ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
    throw error
  }
}

// 2) Non-interactive environment, and every cache inside the profile sandbox.
process.env.CI = 'true'
if (cacheDir !== '') {
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    process.env.XDG_CACHE_HOME = cacheDir
    process.env.XDG_DATA_HOME = cacheDir
    process.env.XDG_STATE_HOME = cacheDir
  } catch (error) {
    post('stderr', `\n[market-pnpm] cache dir unavailable (${cacheDir}): ${error && error.message ? error.message : String(error)}\n`)
  }
}

// 3) pnpm assigns `process.execPath` during startup; Electron-style read-only
//    properties throw there. Keep the real value and accept the write.
try {
  const realExecPath = process.execPath
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    get: () => realExecPath,
    set: () => {},
  })
} catch (error) {
  post('stderr', `\n[market-pnpm] execPath workaround failed: ${error && error.message ? error.message : String(error)}\n`)
}

// 4) pnpm's CLI reads process.argv; element 1 is ignored by it.
process.argv = [process.execPath, entry, ...args]

// 5) The platform refuses symlinks; pnpm still creates them for dependency
//    binaries in `node_modules/.bin`. Copy the (tiny) target instead.
const LINK_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOSYS', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])

function isLinkError(error) {
  return Boolean(error) && LINK_ERROR_CODES.has(error.code)
}

function resolveLinkTarget(target, linkPath) {
  const value = String(target)
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(String(linkPath)), value)
}

function copyInsteadOfLink(target, linkPath) {
  const source = resolveLinkTarget(target, linkPath)
  const stat = fs.statSync(source)
  if (stat.isDirectory()) fs.cpSync(source, linkPath, { recursive: true })
  else {
    fs.copyFileSync(source, linkPath)
    try {
      fs.chmodSync(linkPath, 0o755)
    } catch {
      // The executable bit is not required for a plugin install to succeed.
    }
  }
}

function patchSymlink() {
  const originalPromise = fsp.symlink
  const patchedPromise = async (target, linkPath, type) => {
    try {
      return await originalPromise(target, linkPath, type)
    } catch (error) {
      if (isLinkError(error)) {
        copyInsteadOfLink(target, linkPath)
        return
      }
      throw error
    }
  }
  const originalSync = fs.symlinkSync
  const patchedSync = (target, linkPath, type) => {
    try {
      return originalSync.call(fs, target, linkPath, type)
    } catch (error) {
      if (isLinkError(error)) {
        copyInsteadOfLink(target, linkPath)
        return
      }
      throw error
    }
  }
  const define = (object, name, value) => {
    if (object === undefined || object === null) return
    try {
      Object.defineProperty(object, name, { value, configurable: true, writable: true })
    } catch {
      try {
        object[name] = value
      } catch {
        // Left unpatched; the install then surfaces the original platform error.
      }
    }
  }
  define(fsp, 'symlink', patchedPromise)
  if (fs.promises !== fsp) define(fs.promises, 'symlink', patchedPromise)
  define(fs, 'symlinkSync', patchedSync)
}

patchSymlink()

// 6) Tee stdout/stderr into messages so the parent can stream them to the market.
//    Decode per stream: a multi-byte UTF-8 character can straddle two writes, and the
//    market classifies failures by matching stderr text (a broken character loses the match).
const stdoutDecoder = new StringDecoder('utf8')
const stderrDecoder = new StringDecoder('utf8')
process.stdout.write = (chunk, encoding, callback) => {
  const text = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk)
  if (text !== '') post('stdout', text)
  const cb = typeof encoding === 'function' ? encoding : callback
  if (typeof cb === 'function') cb()
  return true
}
process.stderr.write = (chunk, encoding, callback) => {
  const text = typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk)
  if (text !== '') post('stderr', text)
  const cb = typeof encoding === 'function' ? encoding : callback
  if (typeof cb === 'function') cb()
  return true
}

try {
  await import(pathToFileURL(entry).href)
} catch (error) {
  post('stderr', `\n[market-pnpm] pnpm engine import failed: ${error && error.stack ? error.stack : String(error)}\n`)
  process.exitCode = 1
}
// Falling off the end lets the worker exit once pnpm's own pending work drains;
// a pnpm `process.exit()` ends only this worker, never the host.
