/**
 * Smoke test for `@dsh-ohos/notify` (pure Node).
 *
 * `@dsh-ohos/host-bridge` is mapped to `test/bridge-mock.mjs` via
 * `module.registerHooks`.
 *
 * Covers: throttle/dedupe windows, session identity, `agent/status`
 * `running → idle` notification, approval notification with a mandatory
 * `next()` call, foreground suppression, and the best-effort failure policy.
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@dsh-ohos/host-bridge') {
      return { url: new URL('./bridge-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const notify = await import('../lib/index.js')
const bridge = await import('@dsh-ohos/host-bridge')

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fakeContext() {
  const listeners = new Map()
  const warnings = []
  return {
    listeners,
    warnings,
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    logger() {
      return {
        info() {},
        warn(message, detail) {
          warnings.push({ message, detail })
        },
        error() {},
      }
    },
    effect() {},
  }
}

const agent = id => ({ session: { id } })

await test('instrumentation: plugin name, inject, session id, foreground flag', () => {
  assert.equal(notify.name, 'notify-ohos')
  assert.deepEqual(notify.inject, [])
  assert.equal(notify.sessionIdOf(agent('s-1')), 's-1')
  assert.equal(notify.sessionIdOf({ id: 's-2' }), 's-2')
  assert.equal(notify.sessionIdOf(undefined), 'unknown')
  assert.equal(notify.foregroundEnabled({ DSH_OHOS_FOREGROUND: '1' }), true)
  assert.equal(notify.foregroundEnabled({}), false)
})

await test('NotificationThrottle: per-kind dedupe and per-session throttle', () => {
  let now = 1_000
  const throttle = new notify.NotificationThrottle({ throttleMs: 100, dedupeMs: 1_000, now: () => now })
  assert.equal(throttle.allow('turn-idle', 's'), true)
  assert.equal(throttle.allow('turn-idle', 's'), false, 'deduped within the kind window')
  assert.equal(throttle.allow('approval', 's'), false, 'per-session throttle applies across kinds')
  now += 150
  assert.equal(throttle.allow('approval', 's'), true)
  now += 150
  assert.equal(throttle.allow('turn-idle', 's'), false, 'still inside the kind dedupe window')
  now += 1_000
  assert.equal(throttle.allow('turn-idle', 's'), true)
  throttle.reset()
  assert.equal(throttle.allow('turn-idle', 's'), true)
})

await test('agent/status: running -> idle notifies once, repeats are deduped', async () => {
  const ctx = fakeContext()
  delete process.env.DSH_OHOS_FOREGROUND
  notify.apply(ctx, { throttleMs: 0, dedupeMs: 60_000 })
  bridge.calls.length = 0
  const handler = ctx.listeners.get('agent/status')
  assert.equal(typeof handler, 'function')
  handler({ agent: agent('session-a'), status: 'running' })
  handler({ agent: agent('session-a'), status: 'idle' })
  await tick()
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].name, 'notify.show')
  assert.equal(bridge.calls[0].args.kind, 'turn-idle')
  assert.match(bridge.calls[0].args.body, /会话 session-/)
  assert.ok(bridge.calls[0].args.sessionId === 'session-a')
  handler({ agent: agent('session-a'), status: 'idle' })
  await tick()
  assert.equal(bridge.calls.length, 1, 'duplicate idle is deduped')
  handler({ agent: agent('session-a'), status: 'running' })
  handler({ agent: agent('session-a'), status: 'idle' })
  await tick()
  assert.equal(bridge.calls.length, 1, 'second completion is inside the dedupe window')
})

await test('approval/request: always calls next(), notifies, returns the real outcome', async () => {
  const ctx = fakeContext()
  notify.apply(ctx, { throttleMs: 0, dedupeMs: 60_000 })
  bridge.calls.length = 0
  const handler = ctx.listeners.get('approval/request')
  let nextCalls = 0
  const outcome = await handler({ agent: agent('session-b'), toolName: 'bash', reason: '写入工作区' }, async () => {
    nextCalls += 1
    return 'allowed-once'
  })
  assert.equal(nextCalls, 1, 'next() must be called exactly once')
  assert.equal(outcome, 'allowed-once')
  await tick()
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].args.kind, 'approval')
  assert.match(bridge.calls[0].args.body, /bash/)
})

await test('foreground: DSH_OHOS_FOREGROUND=1 suppresses every notification', async () => {
  const ctx = fakeContext()
  notify.apply(ctx, { throttleMs: 0, dedupeMs: 0 })
  bridge.calls.length = 0
  process.env.DSH_OHOS_FOREGROUND = '1'
  try {
    ctx.listeners.get('agent/status')({ agent: agent('foreground'), status: 'running' })
    ctx.listeners.get('agent/status')({ agent: agent('foreground'), status: 'idle' })
    await ctx.listeners.get('approval/request')({ agent: agent('foreground'), toolName: 'bash' }, async () => 'rejected')
    await tick()
    assert.equal(bridge.calls.length, 0)
  } finally {
    delete process.env.DSH_OHOS_FOREGROUND
  }
})

await test('bridge failure is logged, never thrown into the turn', async () => {
  const ctx = fakeContext()
  notify.apply(ctx, { throttleMs: 0, dedupeMs: 0 })
  bridge.state.fail = new Error('host bridge offline')
  try {
    const outcome = await ctx.listeners.get('approval/request')({ agent: agent('failing'), toolName: 'bash' }, async () => 'cancelled')
    assert.equal(outcome, 'cancelled')
    await tick()
    assert.ok(ctx.warnings.length >= 1, 'failure is logged')
  } finally {
    bridge.state.fail = undefined
  }
})

if (failures > 0) {
  console.error(`notify smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('notify smoke: all checks passed')
}
