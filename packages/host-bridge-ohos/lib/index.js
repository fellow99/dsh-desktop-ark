/**
 * `@dsh-ohos/host-bridge` — shared Node → ArkTS host-capability client.
 *
 * This is NOT a cordis seam service: it is the one transport every OHOS plugin
 * shares. The wire is the file mailbox implemented on the ArkTS side by
 * `@fellow99/node-bridge` (`HostBridge.startMailbox`):
 *
 *   request  -> `<dir>/<id>.req`   `{"name":"<capability>","args":"<JSON string>"}`
 *   success  <- `<dir>/<id>.done`  `{"ok":true,...capability payload...}`
 *   failure  <- `<dir>/<id>.fail`  `{"ok":false,"error":"...","hint":"..."}`
 *
 * Rules copied from the ArkTS pump (see `HostBridge.d.ets`, `mailboxTick`):
 * - `args` is a STRING even when the capability wants an object.
 * - the host processes ONE request at a time (`mailboxInflight`), so the client
 *   serializes invocations through a single queue.
 * - request/response publication is `write <id>.tmp` then `rename` (atomic).
 * - a `.fail`, a `.done` carrying `ok:false`, or a timeout is a failure with a
 *   `code`; the ArkTS `error`/`hint` text is preserved verbatim.
 * - a missing/empty mailbox is `host-unavailable` — never a fake success.
 *
 * Zero dependencies: `node:*` only.
 *
 * @module @dsh-ohos/host-bridge
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Environment variable carrying the mailbox directory (set by the ArkTS runtime). */
export const MAILBOX_ENV = 'DSH_OHOS_MAILBOX'

/** Default per-invocation timeout (matches `host.js#MAILBOX_TIMEOUT_MS`). */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Timeout for capabilities whose duration is decided by the user (folder/file pickers). */
export const USER_CHOICE_TIMEOUT_MS = 600_000

/** Poll cadence; the ArkTS pump runs at 100 ms, 50 ms polling keeps latency low. */
export const POLL_INTERVAL_MS = 50

/** Largest delay Node schedules without clamping it to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * v1 capability names frozen by `HostCapabilities.ets:104-119`.
 * The last eight are registered placeholders that answer
 * `{"ok":false,"error":"not-implemented","hint":...}` — callers must fail.
 */
export const HOST_CAPABILITIES = Object.freeze([
  'runtime.facts',
  'log.hilog',
  'perm.check',
  'perm.request',
  'perm.openAppInfo',
  'shell.openExternal',
  'fs.pickFolder',
  'fs.pickFiles',
  'fs.saveFile',
  'notify.show',
  'clipboard.readImage',
  'clipboard.writeText',
  'image.normalize',
  'power.keepAwake',
])

/** Error codes thrown by this module. */
export const HOST_BRIDGE_ERROR_CODES = Object.freeze({
  unavailable: 'host-unavailable',
  timeout: 'host-timeout',
  rejected: 'host-rejected',
  aborted: 'host-aborted',
})

/** Structured host failure; carries the ArkTS `error`/`hint` text unchanged. */
export class HostBridgeError extends Error {
  /**
   * @param {'host-unavailable'|'host-timeout'|'host-rejected'|'host-aborted'} code
   * @param {string} message
   * @param {{ capability?: string, hostError?: string, hint?: string, detail?: unknown, id?: string, raw?: string, cause?: unknown }} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'HostBridgeError'
    /** Machine-readable failure class. */
    this.code = code
    for (const key of ['capability', 'hostError', 'hint', 'detail', 'id', 'raw']) {
      if (details[key] !== undefined) this[key] = details[key]
    }
  }
}

/** The mailbox (or its parent) is missing: the host bridge was never wired. */
export class HostBridgeUnavailable extends HostBridgeError {
  /**
   * @param {string} message
   * @param {{ capability?: string, hint?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(HOST_BRIDGE_ERROR_CODES.unavailable, message, details)
    this.name = 'HostBridgeUnavailable'
  }
}

let sequence = 0

/**
 * Build a mailbox id: `<epochMs>-<seq>-<rand>`.
 * Only `[A-Za-z0-9-]` characters, so the name is safe on every filesystem and
 * unambiguous in the mailbox listing.
 * @returns {string}
 */
export function nextRequestId() {
  sequence = (sequence + 1) % 1_000_000
  return `${Date.now()}-${sequence}-${randomBytes(4).toString('hex')}`
}

/**
 * Normalize capability arguments to the protocol's `args` string.
 * A string is accepted when it already parses as JSON (pre-serialized payloads);
 * anything else is `JSON.stringify`-ed. `undefined`/`null` become `{}`.
 * @param {unknown} args
 * @returns {string}
 */
export function toArgsJson(args) {
  if (args === undefined || args === null) return '{}'
  if (typeof args === 'string') {
    try {
      JSON.parse(args)
    } catch (error) {
      throw new TypeError(`host-bridge: args string is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    return args
  }
  const text = JSON.stringify(args)
  if (typeof text !== 'string') throw new TypeError('host-bridge: args are not JSON-serializable')
  return text
}

/**
 * Resolve and validate the mailbox directory.
 * @param {string} [explicit] - test/plugin override; defaults to `process.env[MAILBOX_ENV]`.
 * @returns {string} an existing directory.
 * @throws {HostBridgeUnavailable}
 */
export function resolveMailboxDir(explicit) {
  const raw = explicit ?? process.env[MAILBOX_ENV]
  const dir = typeof raw === 'string' ? raw.trim() : ''
  if (dir === '') {
    throw new HostBridgeUnavailable(
      `host-bridge: ${MAILBOX_ENV} is not set; the ArkTS host bridge is unavailable (no capability can be called)`,
      { hint: 'set DSH_OHOS_MAILBOX to the mailbox directory created by Constants.mailboxDir(context)' },
    )
  }
  let stat
  try {
    stat = statSync(dir)
  } catch (error) {
    throw new HostBridgeUnavailable(`host-bridge: mailbox directory does not exist: ${dir}`, {
      hint: 'the ArkTS side creates <filesDir>/node-bridge/mailbox at startup (Constants.ensureDirs)',
      cause: error,
    })
  }
  if (!stat.isDirectory()) {
    throw new HostBridgeUnavailable(`host-bridge: mailbox path is not a directory: ${dir}`, { hint: 'DSH_OHOS_MAILBOX must name a directory' })
  }
  return dir
}

function assertTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`host-bridge: timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function unlinkQuietly(path) {
  try {
    unlinkSync(path)
  } catch {
    // ENOENT (already consumed or never written) is the normal case.
  }
}

function readResponseFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw new HostBridgeError(HOST_BRIDGE_ERROR_CODES.rejected, `host-bridge: cannot read response ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return text
}

/**
 * Serialized mailbox client.
 *
 * One instance = one queue. The default module-level instance is what plugins
 * import, so two plugins calling at once still produce one in-flight `.req`,
 * matching the host pump's single-slot dispatch.
 */
export class HostBridge {
  /**
   * @param {{ mailbox?: string, pollIntervalMs?: number, defaultTimeoutMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    /** Explicit mailbox override (tests); `undefined` reads the environment each call. */
    this.mailbox = options.mailbox
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    /** Default timeout for one invocation. */
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
    /** Tail of the serialization chain. */
    this.tail = Promise.resolve()
    /** Diagnostics: calls currently queued or in flight. */
    this.queueDepth = 0
  }

  /** @returns {boolean} whether a usable mailbox is configured right now. */
  isAvailable() {
    try {
      resolveMailboxDir(this.mailbox)
      return true
    } catch {
      return false
    }
  }

  /** @returns {string} the mailbox directory, or throws `host-unavailable`. */
  mailboxDir() {
    return resolveMailboxDir(this.mailbox)
  }

  /**
   * Invoke one host capability.
   * @param {string} name - capability name (see {@link HOST_CAPABILITIES}).
   * @param {unknown} [args] - object (or pre-serialized JSON string) for the capability.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<Record<string, unknown>>} the host response body (`ok:true`).
   * @throws {HostBridgeError} `host-unavailable` | `host-timeout` | `host-rejected` | `host-aborted`.
   */
  invoke(name, args, options = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      return Promise.reject(new TypeError('host-bridge: capability name must be a non-empty string'))
    }
    const capability = name.trim()
    let argsJson
    try {
      argsJson = toArgsJson(args)
    } catch (error) {
      return Promise.reject(error)
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    try {
      assertTimeout(timeoutMs)
    } catch (error) {
      return Promise.reject(error)
    }
    const operation = () => this.dispatch(capability, argsJson, timeoutMs, options.signal)
    this.queueDepth += 1
    const run = this.tail.then(operation, operation)
    this.tail = run.then(
      () => {},
      () => {},
    )
    return run.finally(() => {
      this.queueDepth -= 1
    })
  }

  /**
   * One mailbox round trip. Never called concurrently by {@link invoke}; public
   * so diagnostics and tests can bypass the queue deliberately.
   * @param {string} capability
   * @param {string} argsJson
   * @param {number} timeoutMs
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async dispatch(capability, argsJson, timeoutMs, signal) {
    const dir = this.mailboxDir()
    const id = nextRequestId()
    const reqPath = join(dir, `${id}.req`)
    const tmpPath = join(dir, `${id}.tmp`)
    const donePath = join(dir, `${id}.done`)
    const failPath = join(dir, `${id}.fail`)
    const deadline = this.now() + timeoutMs
    let malformed = 0

    const payload = JSON.stringify({ name: capability, args: argsJson })
    try {
      writeFileSync(tmpPath, payload, 'utf8')
      renameSync(tmpPath, reqPath)
    } catch (error) {
      unlinkQuietly(tmpPath)
      throw new HostBridgeUnavailable(
        `host-bridge: cannot publish a request into ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        { capability, hint: 'the mailbox must be writable by the Node runtime', cause: error },
      )
    }

    const cleanup = () => {
      unlinkQuietly(tmpPath)
      unlinkQuietly(reqPath)
      unlinkQuietly(donePath)
      unlinkQuietly(failPath)
    }

    for (;;) {
      if (signal?.aborted) {
        cleanup()
        throw new HostBridgeError(HOST_BRIDGE_ERROR_CODES.aborted, `host-bridge: ${capability} was aborted while waiting for the host`, {
          capability,
          hint: 'the caller cancelled; the host may still process the request file',
        })
      }

      const response = this.takeResponse(donePath, failPath, capability, id)
      if (response !== undefined) {
        if (response.kind === 'malformed') {
          malformed += 1
          if (malformed >= 5) {
            unlinkQuietly(donePath)
            unlinkQuietly(failPath)
            throw new HostBridgeError(HOST_BRIDGE_ERROR_CODES.rejected, `host-bridge: malformed response for ${capability} (${id}): ${response.raw}`, {
              capability,
              id,
              raw: response.raw,
            })
          }
        } else {
          return response.body
        }
      }

      const remaining = deadline - this.now()
      if (remaining <= 0) {
        cleanup()
        throw new HostBridgeError(HOST_BRIDGE_ERROR_CODES.timeout, `host-bridge: ${capability} timed out after ${timeoutMs}ms (id ${id})`, {
          capability,
          id,
          hint: `no response file appeared in ${dir}; the host pump may be stopped or the capability may be blocked`,
        })
      }
      await delay(Math.min(this.pollIntervalMs, remaining))
    }
  }

  /**
   * Read and consume one response file.
   * `.done` wins over `.fail` when both exist (the pump writes exactly one, but
   * a reaper race must not turn a success into a failure).
   * @param {string} donePath
   * @param {string} failPath
   * @param {string} capability
   * @param {string} id
   * @returns {{ kind: 'done', body: Record<string, unknown> } | { kind: 'fail', body: Record<string, unknown> } | { kind: 'malformed', raw: string } | undefined}
   */
  takeResponse(donePath, failPath, capability, id) {
    for (const [kind, path] of [['done', donePath], ['fail', failPath]]) {
      const text = readResponseFile(path)
      if (text === undefined) continue
      let body
      try {
        body = JSON.parse(text)
      } catch {
        return { kind: 'malformed', raw: text }
      }
      if (typeof body !== 'object' || body === null) return { kind: 'malformed', raw: text }
      unlinkQuietly(path)
      if (kind === 'fail' || body.ok === false) {
        const hostError = typeof body.error === 'string' ? body.error : undefined
        const hint = typeof body.hint === 'string' ? body.hint : undefined
        throw new HostBridgeError(
          HOST_BRIDGE_ERROR_CODES.rejected,
          `host-bridge: ${capability} failed${hostError === undefined ? '' : ` [${hostError}]`}${hint === undefined ? '' : `: ${hint}`}`,
          {
            capability,
            id,
            hostError: hostError ?? (kind === 'fail' ? 'host-dispatch-failed' : 'host-reported-failure'),
            hint,
            detail: body.detail,
            raw: text,
          },
        )
      }
      return { kind: 'done', body: unwrapMailboxEnvelope(body) }
    }
    return undefined
  }
}

/**
 * Unwrap the mailbox success envelope.
 *
 * ArkTS `HostBridge.mailboxSettle()` 写成功结果时固定是
 * `{"ok":true,"result":"<handler 返回的 JSON 字符串>"}`（见 ohos-node-bridge
 * `HostBridge.ets` 的 `mailboxSettle`）；handler 的**结构化载荷**在 `result` 里，
 * 而且是**二次编码的字符串**。
 *
 * 不解包时所有消费方都只能看到 `{ok,result}`：`perm.check.granted` 恒为 undefined
 * （曾被误记为“平台假阴性”）、`perm.request.authResults` 恒为空（曾被误记为
 * “平台不应答”）、`image.normalize.data` 恒为 undefined（图片准入直接判 INVALID_IMAGE）。
 *
 * 规则保守：只有「ok===true 且 result 是字符串」才尝试解析；解析失败或结果不是对象
 * 时保持原样（不把合法业务字段吞掉）。
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function unwrapMailboxEnvelope(body) {
  if (body === null || typeof body !== 'object') return body
  const result = body.result
  if (body.ok === true && typeof result === 'string' && result !== '') {
    try {
      const inner = JSON.parse(result)
      if (inner !== null && typeof inner === 'object') return inner
    } catch {
      /* 不是 JSON：保持原样 */
    }
  }
  if (body.ok === true && result !== null && typeof result === 'object') return result
  return body
}

/** Shared instance used by plugin packages. */
const shared = new HostBridge()

/**
 * Invoke a capability through the shared serialized client.
 * @param {string} name
 * @param {unknown} [args]
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export function invoke(name, args, options) {
  return shared.invoke(name, args, options)
}

/** @returns {boolean} whether the shared client's mailbox is usable. */
export function isAvailable() {
  return shared.isAvailable()
}

/** @returns {string} the shared client's mailbox directory. */
export function mailboxDir() {
  return shared.mailboxDir()
}

/**
 * Invoke a capability whose duration is decided by the user (picker / dialog).
 * @param {string} name
 * @param {unknown} [args]
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export function invokeUserChoice(name, args, options = {}) {
  return invoke(name, args, { timeoutMs: USER_CHOICE_TIMEOUT_MS, ...options })
}

/** Diagnostics snapshot (no payload contents). */
export function stats() {
  return { mailbox: process.env[MAILBOX_ENV] ?? '', available: shared.isAvailable(), queueDepth: shared.queueDepth }
}

export default HostBridge
