/**
 * `@dsh-ohos/notify` — OS notifications for turn completion and approval
 * requests.
 *
 * Upstream has NO notification service (`report B.6:378-409`: there is no
 * `ctx.notify`/`ctx.notifications`; the only OS `Notification` use lives in the
 * Electron shell and is not reusable). The two honest hooks are therefore the
 * events themselves:
 * - `agent/status` (emit): `{ agent, status: 'idle' | 'running' }`
 *   (`packages/core/agent/src/runtime-types.ts:280`) — an `idle` after
 *   `running` means "this turn finished";
 * - `approval/request` (waterfall):
 *   `(request, next) => Promise<ApprovalOutcome>`
 *   (`packages/interaction/user-approval/src/types.ts:87-92`). This listener
 *   NEVER answers: it always calls `next()` so the real answerer keeps its
 *   authority (a notifier that returned an outcome would silently approve).
 *
 * Delivery is `notify.show` through the host bridge. Notifications are not a
 * critical path: a bridge failure is logged and swallowed. The plugin also
 * stays quiet while the app is in the foreground
 * (`DSH_OHOS_FOREGROUND === '1'`) and throttles/deduplicates per session.
 *
 * @module @dsh-ohos/notify
 */

import { invoke as invokeHost } from '@dsh-ohos/host-bridge'

/** Cordis function-plugin name (matches the bundle row id). */
export const name = 'notify-ohos'

/** No hard service dependency: the two events are the whole contract. */
export const inject = []

/** Foreground flag exported by the ArkTS shell while the page is visible. */
export const FOREGROUND_ENV = 'DSH_OHOS_FOREGROUND'

/** Minimum distance between any two notifications of one session. */
export const DEFAULT_THROTTLE_MS = 30_000

/** Minimum distance between identical (kind, session) notifications. */
export const DEFAULT_DEDUPE_MS = 120_000

/** Notification delivery is best-effort and must not hold a turn. */
export const NOTIFY_TIMEOUT_MS = 5_000

/** Whether the app is visible; a visible app must not be disturbed. */
export function foregroundEnabled(env = process.env) {
  return env[FOREGROUND_ENV] === '1'
}

/**
 * Session identity from an agent payload (agent and session share the id,
 * `packages/core/agent/src/index.ts:463-464`).
 * @param {Record<string, any>} agent
 * @returns {string}
 */
export function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' && id !== '' ? id : 'unknown'
}

/**
 * Per-session throttle + per-(kind, session) dedupe window.
 */
export class NotificationThrottle {
  /**
   * @param {{ throttleMs?: number, dedupeMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
    this.dedupeMs = options.dedupeMs ?? DEFAULT_DEDUPE_MS
    this.now = options.now ?? Date.now
    this.perKind = new Map()
    this.perSession = new Map()
  }

  /**
   * @param {'turn-idle'|'approval'} kind
   * @param {string} sessionId
   * @returns {boolean} whether the notification may be sent now.
   */
  allow(kind, sessionId) {
    const at = this.now()
    const kindKey = `${kind}:${sessionId}`
    const lastKind = this.perKind.get(kindKey)
    if (lastKind !== undefined && at - lastKind < this.dedupeMs) return false
    const lastSession = this.perSession.get(sessionId)
    if (lastSession !== undefined && at - lastSession < this.throttleMs) return false
    this.perKind.set(kindKey, at)
    this.perSession.set(sessionId, at)
    return true
  }

  /** Drop all memory (tests / session teardown). */
  reset() {
    this.perKind.clear()
    this.perSession.clear()
  }
}

function logFailure(ctx, message, detail) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('notify-ohos') : undefined
    if (logger?.warn) {
      logger.warn(message, detail)
      return
    }
  } catch {
    // A logger failure must not turn a best-effort notification into a turn error.
  }
  console.error(`[notify-ohos] ${message}`, detail ?? '')
}

/**
 * Short, non-sensitive session label for the notification body.
 * @param {string} sessionId
 * @returns {string}
 */
export function shortSession(sessionId) {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8)
}

/**
 * Register the listeners.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ throttleMs?: number, dedupeMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const throttle = new NotificationThrottle({
    throttleMs: config.throttleMs ?? DEFAULT_THROTTLE_MS,
    dedupeMs: config.dedupeMs ?? DEFAULT_DEDUPE_MS,
  })
  const statuses = new Map()

  /**
   * @param {'turn-idle'|'approval'} kind
   * @param {string} sessionId
   * @param {string} title
   * @param {string} body
   */
  const notify = (kind, sessionId, title, body) => {
    if (foregroundEnabled()) return
    if (!throttle.allow(kind, sessionId)) return
    invokeHost('notify.show', { title, body, sessionId, kind }, { timeoutMs: NOTIFY_TIMEOUT_MS }).catch(error => {
      logFailure(ctx, `notify.show failed (${kind}): ${error instanceof Error ? error.message : String(error)}`, {
        code: error?.code,
        hint: error?.hint,
      })
    })
  }

  ctx.on('agent/status', payload => {
    const agent = payload?.agent
    const status = payload?.status
    if (status !== 'idle' && status !== 'running') return
    const sessionId = sessionIdOf(agent)
    const previous = statuses.get(sessionId)
    statuses.set(sessionId, status)
    if (status === 'idle' && previous === 'running') {
      notify('turn-idle', sessionId, 'dsh · 回合完成', `会话 ${shortSession(sessionId)} 已空闲`)
    }
  })

  ctx.on('approval/request', (request, next) => {
    try {
      const sessionId = sessionIdOf(request?.agent)
      const toolName = typeof request?.toolName === 'string' && request.toolName !== '' ? request.toolName : '未知工具'
      const reason = typeof request?.reason === 'string' && request.reason !== '' ? `：${request.reason}` : ''
      notify('approval', sessionId, 'dsh · 等待授权', `${toolName}${reason}`)
    } catch (error) {
      logFailure(ctx, `approval notification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Never answer the approval here: the composed answerer chain owns it.
    return next()
  })
}

