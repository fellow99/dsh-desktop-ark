/**
 * `@dsh-ohos/subprocess` — `ctx.subprocess` provider for HarmonyOS.
 *
 * Replaces `@deepseek-ai/dsh-subprocess-local` (service definition:
 * `packages/subprocess/subprocess/src/index.ts:117-162`). The seam is four
 * methods; this provider implements `resolveExecutable`, `terminalEnvironment`
 * and `spawn`, and reports `spawnTerminal` as unsupported because HarmonyOS has
 * no PTY (`/dev/ptmx` is absent).
 *
 * Platform fences (this is the enforcement point, not a convention):
 * - only `/system/bin/*`, `/system/bin/toybox`, and executable files inside the
 *   workspace may be spawned; every path is canonicalized (`realpath`) before
 *   the prefix check, so a symlink cannot smuggle another binary in;
 * - `cwd` must be absolute, exist as a directory, and live inside a writable
 *   root (workspace, `/tmp`, `os.tmpdir()`); `process.cwd()` is never used;
 * - the child environment is an allow-list (`PATH`/`HOME`/`TMPDIR`/`LANG` plus
 *   `DSH_*`), never the ambient parent environment; explicit `spec.env` entries
 *   merge last, like upstream;
 * - `graceMs ∈ (0, 2147483647]` and a pre-aborted signal fail synchronously,
 *   matching `validateSubprocessSpec`
 *   (`packages/subprocess/subprocess-local/src/spawn.ts:164-181`).
 *
 * Output semantics follow `OutputCollector` (upstream `output.ts:250-316`):
 * collect-mode readers are non-consuming and offset-based; `done` only reports
 * `{exitCode, signal}` and never classifies timeout/abort (that belongs to
 * `ctx.shell`); output stays readable after `done`.
 *
 * @module @dsh-ohos/subprocess
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { TailCollector, readerOf } from './output.js'

/** Largest delay Node schedules without clamping it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The one system directory whose binaries are executable in the app domain. */
export const SYSTEM_BIN_ROOT = '/system/bin'

/** The platform shell used by `@dsh-ohos/shell` and as the default `PATH` entry. */
export const SYSTEM_SHELL = '/system/bin/sh'

/** Toybox multi-call binary (explicitly allowed by the platform notes). */
export const TOYBOX = '/system/bin/toybox'

/** Default `PATH` handed to children: system binaries only. */
export const DEFAULT_PATH = `${SYSTEM_BIN_ROOT}:/system/xbin:/usr/bin:/bin`

/** Credential-shaped environment names are never inherited from the parent. */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** Ambient environment names forwarded to children (`DSH_*` is handled separately). */
export const ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG'])

/** Workspace seam variable set by the ArkTS runtime (`DshRuntime.ets:118-123`). */
export const WORKSPACE_ENV = 'DSH_OHOS_WORKSPACE'

/** Executable lookup completed without finding an allowed executable. */
export class SubprocessExecutableNotFoundError extends Error {
  /**
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message, options)
    this.name = 'SubprocessExecutableNotFoundError'
  }
}

/** A requested primitive (PTY) is not available on this platform. */
export class SubprocessUnsupportedError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'SubprocessUnsupportedError'
    this.code = 'not-supported'
  }
}

/**
 * Canonical path (symlinks resolved). A missing path is returned as written —
 * it matches nothing until it exists, which is the conservative outcome.
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Containment check on canonical paths.
 * @param {string} child
 * @param {string} root
 * @returns {boolean}
 */
export function isPathUnder(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string' || child === '' || root === '') return false
  const rel = relative(canonicalPath(root), canonicalPath(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Workspace root from the environment. Never `process.cwd()`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function workspaceRoot(env = process.env) {
  const value = env[WORKSPACE_ENV]
  return typeof value === 'string' && isAbsolute(value) ? value : undefined
}

/**
 * Roots a child process may run inside. Mirrors the upstream derivation
 * (`packages/sandbox/sandbox/src/roots.ts:52-55`) with no `/` fallback.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function writableRoots(env = process.env) {
  const roots = [workspaceRoot(env), '/tmp', tmpdir()].filter(root => typeof root === 'string' && isAbsolute(root))
  return [...new Set(roots.map(canonicalPath))]
}

/**
 * Build a child environment: ambient allow-list (credentials and `DSH_*`
 * secrets dropped), then explicit caller entries merged last.
 * @param {Readonly<Record<string, string | undefined>>} [explicit]
 * @param {NodeJS.ProcessEnv} [ambient]
 * @returns {Record<string, string>}
 */
export function buildChildEnv(explicit, ambient = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (value === undefined) continue
    if (!ENV_ALLOWLIST.includes(key) && !key.startsWith('DSH_')) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    env[key] = value
  }
  env.PATH ??= DEFAULT_PATH
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = String(value)
  }
  return env
}

/**
 * Validate the synchronous portion of a spawn request (upstream parity).
 * @param {import('./types.js').SubprocessSpawnSpec} spec
 * @returns {void}
 * @throws {Error}
 */
export function validateSubprocessSpec(spec) {
  if (spec === null || typeof spec !== 'object') throw new Error('subprocess-ohos: spawn spec must be an object')
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess-ohos: graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (spec.signal?.aborted) {
    let reason = 'aborted'
    try {
      reason = String(spec.signal.reason ?? reason)
    } catch {
      // Caller-owned reasons cannot escape the stable Error boundary.
    }
    throw new Error(`aborted before spawn: ${reason}`)
  }
  if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }
  for (const part of spec.argv) {
    if (typeof part !== 'string' || part.length === 0) throw new Error('invalid argv: every argv entry must be a non-empty string')
  }
  if (typeof spec.cwd !== 'string' || !isAbsolute(spec.cwd)) {
    throw new Error(`invalid cwd: expected an absolute path, got ${JSON.stringify(spec.cwd)}`)
  }
  const stdio = spec.stdio
  if (stdio === null || typeof stdio !== 'object' || stdio.stdin === undefined || stdio.stdout === undefined || stdio.stderr === undefined) {
    throw new Error('invalid stdio: stdin, stdout and stderr dispositions are required')
  }
}

/**
 * True when `path` is an allowed executable location after canonicalization.
 * @param {string} path - absolute path.
 * @param {string} [workspace]
 * @returns {boolean}
 */
export function isAllowedExecutable(path, workspace = workspaceRoot()) {
  const canonical = canonicalPath(path)
  if (canonical === TOYBOX || canonical.startsWith(`${SYSTEM_BIN_ROOT}/`)) return true
  if (workspace === undefined) return false
  return isPathUnder(canonical, workspace)
}

function assertExecutable(path, command) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('not a regular file')
    accessSync(path, fsConstants.X_OK)
  } catch (error) {
    throw new SubprocessExecutableNotFoundError(
      `subprocess-ohos: "${command}" does not resolve to an executable file inside the allowed roots (${path})`,
      { cause: error },
    )
  }
}

/**
 * Resolve one command to an allowed absolute executable.
 * Bare names use the scrubbed `PATH`; relative paths with separators are
 * rejected (the resolution base would be the process cwd, which is `/` on
 * device and therefore meaningless).
 * @param {string} command
 * @param {Readonly<Record<string, string>>} [env]
 * @param {AbortSignal} [signal]
 * @returns {string}
 * @throws {SubprocessExecutableNotFoundError}
 */
export function resolveProgram(command, env, signal) {
  signal?.throwIfAborted()
  if (typeof command !== 'string' || command.length === 0) {
    throw new SubprocessExecutableNotFoundError('subprocess-ohos: executable name must be a non-empty string')
  }
  const workspace = workspaceRoot()
  if (command.includes('/')) {
    if (!isAbsolute(command)) {
      throw new SubprocessExecutableNotFoundError(`subprocess-ohos: relative executable paths are rejected (got "${command}")`)
    }
    if (!isAllowedExecutable(command, workspace)) {
      throw new SubprocessExecutableNotFoundError(
        `subprocess-ohos: "${command}" is outside the allowed executable roots (${SYSTEM_BIN_ROOT}/**, ${TOYBOX}, workspace scripts)`,
      )
    }
    assertExecutable(canonicalPath(command), command)
    return canonicalPath(command)
  }
  const searchPath = typeof env?.PATH === 'string' ? env.PATH : DEFAULT_PATH
  for (const directory of searchPath.split(':').filter(entry => entry !== '' && isAbsolute(entry))) {
    const candidate = resolve(directory, command)
    let exists = false
    try {
      accessSync(candidate, fsConstants.X_OK)
      exists = true
    } catch {
      exists = false
    }
    if (!exists) continue
    if (!isAllowedExecutable(candidate, workspace)) continue
    return canonicalPath(candidate)
  }
  throw new SubprocessExecutableNotFoundError(`subprocess-ohos: "${command}" was not found in the allowed PATH (${searchPath})`)
}

/**
 * Validate and canonicalize `cwd`: absolute, existing directory, inside a
 * writable root.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function assertCwdAllowed(cwd, env = process.env) {
  if (!isAbsolute(cwd)) throw new Error(`subprocess-ohos: cwd must be absolute, got ${JSON.stringify(cwd)}`)
  const canonical = canonicalPath(cwd)
  let stat
  try {
    stat = statSync(canonical)
  } catch (error) {
    throw new Error(`subprocess-ohos: cwd does not exist: ${cwd}`, { cause: error })
  }
  if (!stat.isDirectory()) throw new Error(`subprocess-ohos: cwd is not a directory: ${cwd}`)
  const roots = writableRoots(env)
  if (!roots.some(root => isPathUnder(canonical, root))) {
    throw new Error(`subprocess-ohos: cwd is outside the writable roots (${roots.join(', ')}): ${cwd}`)
  }
  return canonical
}

function spillDirectory(env) {
  return typeof env?.TMPDIR === 'string' && isAbsolute(env.TMPDIR) ? env.TMPDIR : tmpdir()
}

/**
 * Map one stdio disposition to a spawn stdio slot and optional collector.
 * @param {'pipe'|'inherit'|{maxBytes: number, spill?: {maxBytes: number}}} mode
 * @param {string} label
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ slot: 'ignore'|'inherit'|'pipe', collector?: TailCollector }}
 */
function outputMode(mode, label, env) {
  if (mode === 'pipe' || mode === 'inherit') return { slot: mode }
  if (mode !== null && typeof mode === 'object' && Number.isFinite(mode.maxBytes)) {
    const spill = mode.spill === undefined
      ? undefined
      : { maxBytes: mode.spill.maxBytes, dir: spillDirectory(env) }
    return { slot: 'pipe', collector: new TailCollector(mode.maxBytes, label, spill) }
  }
  throw new Error(`subprocess-ohos: invalid ${label} output mode`)
}

/**
 * OHOS subprocess runtime (`ctx.subprocess`).
 */
export class OhosSubprocessRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'subprocess')
    /** Live handles retained for teardown. */
    this.live = new Set()
    ctx.effect(() => {
      const onHostExit = () => {
        for (const handle of this.live) {
          try {
            handle.terminateForHostExit()
          } catch {
            // Host exit cannot await one target; continue with the rest.
          }
        }
      }
      process.prependListener('exit', onHostExit)
      return async () => {
        onHostExit()
        const pending = [...this.live].map(handle => handle.done.catch(() => {}))
        await Promise.allSettled(pending)
        this.live.clear()
        process.off('exit', onHostExit)
      }
    }, 'subprocess-ohos teardown')
  }

  /**
   * Resolve one configured executable in this execution world.
   * @param {string} command
   * @param {Readonly<Record<string, string>>} [env]
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async resolveExecutable(command, env, signal) {
    return resolveProgram(command, buildChildEnv(env), signal)
  }

  /**
   * Inspect shell-selection facts. The platform has one shell and no PTY.
   * @returns {Promise<{ platform: 'posix', defaultShell: string }>}
   */
  async terminalEnvironment() {
    return { platform: 'posix', defaultShell: SYSTEM_SHELL }
  }

  /**
   * Start one managed child process.
   * @param {import('./types.js').SubprocessSpawnSpec} spec
   * @returns {import('./types.js').SubprocessHandle}
   */
  spawn(spec) {
    validateSubprocessSpec(spec)
    const env = buildChildEnv(spec.env)
    const program = resolveProgram(spec.argv[0], env, spec.signal)
    const cwd = assertCwdAllowed(spec.cwd)

    const stdinMode = spec.stdio.stdin
    const out = outputMode(spec.stdio.stdout, 'stdout', env)
    const err = outputMode(spec.stdio.stderr, 'stderr', env)
    const stdinSlot = stdinMode === 'ignore' ? 'ignore' : 'pipe'

    let child
    try {
      child = nodeSpawn(program, spec.argv.slice(1), {
        cwd,
        env,
        stdio: [stdinSlot, out.slot, err.slot],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      throw new Error(`subprocess-ohos: spawn failed for ${program}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }

    if (stdinMode !== 'ignore' && stdinMode !== 'pipe' && typeof stdinMode === 'object' && child.stdin !== null) {
      child.stdin.end(stdinMode.data, 'utf8')
    }

    if (out.collector !== undefined && child.stdout !== null) child.stdout.on('data', chunk => out.collector.push(chunk))
    if (err.collector !== undefined && child.stderr !== null) child.stderr.on('data', chunk => err.collector.push(chunk))

    let settled = false
    let terminating = false
    let killTimer
    let exitInfo = { exitCode: null, signal: null }

    const signalTree = signal => {
      const pid = child.pid
      if (pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-pid, signal)
          return
        } catch {
          // Group already gone or not a group leader: fall back to the child.
        }
      }
      try {
        child.kill(signal)
      } catch {
        // Delivery races exit; teardown stays idempotent.
      }
    }
    const terminate = () => {
      if (terminating || settled) return
      terminating = true
      signalTree('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) signalTree('SIGKILL')
      }, spec.graceMs)
      killTimer.unref?.()
    }
    const onAbort = () => terminate()
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    const done = new Promise((resolveDone, rejectDone) => {
      child.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        spec.signal?.removeEventListener('abort', onAbort)
        resolveStreams()
        rejectDone(error)
      })
      child.once('exit', (exitCode, signal) => {
        if (settled) return
        settled = true
        exitInfo = { exitCode, signal }
        clearTimeout(killTimer)
        spec.signal?.removeEventListener('abort', onAbort)
        resolveStreams()
        resolveDone(exitInfo)
      })
    })
    const resolveStreams = () => {
      out.collector?.seal()
      err.collector?.seal()
      this.live.delete(handle)
    }

    const collected = {}
    if (out.collector !== undefined) collected.stdout = readerOf(out.collector)
    if (err.collector !== undefined) collected.stderr = readerOf(err.collector)

    const handle = {
      stdin: child.stdin ?? undefined,
      stdout: child.stdout ?? undefined,
      stderr: child.stderr ?? undefined,
      control: undefined,
      collected,
      done,
      terminate,
      /**
       * Wait until this managed child exits.
       * @param {AbortSignal} [signal]
       * @returns {Promise<boolean>} `false` when the signal aborted first.
       */
      waitForExit: signal => new Promise((resolveWait, rejectWait) => {
        if (settled) {
          resolveWait(true)
          return
        }
        if (signal?.aborted) {
          resolveWait(false)
          return
        }
        let finished = false
        const finish = value => {
          if (finished) return
          finished = true
          signal?.removeEventListener('abort', onSignal)
          resolveWait(value)
        }
        const onSignal = () => finish(false)
        signal?.addEventListener('abort', onSignal, { once: true })
        done.then(
          () => finish(true),
          error => {
            if (finished) return
            finished = true
            signal?.removeEventListener('abort', onSignal)
            rejectWait(error)
          },
        )
      }),
      /** Synchronous final termination for host exit (not part of the seam). */
      terminateForHostExit: () => {
        if (settled) return
        terminating = true
        signalTree('SIGKILL')
      },
    }
    this.live.add(handle)
    return handle
  }

  /**
   * Terminal allocation is unavailable: HarmonyOS has no PTY.
   * @returns {Promise<never>}
   */
  async spawnTerminal() {
    throw new SubprocessUnsupportedError(
      'subprocess-ohos: spawnTerminal is not supported on HarmonyOS (no /dev/ptmx); use spawn with a pipe-based shell',
    )
  }
}

export default OhosSubprocessRuntime
