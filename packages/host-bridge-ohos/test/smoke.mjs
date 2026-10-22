/**
 * Smoke test for `@dsh-ohos/host-bridge` (pure Node, no test framework).
 *
 * Covers: args serialization, id shape, mailbox discovery failures, the full
 * request/response protocol (`.done` / `.fail` / `ok:false` / timeout), response
 * file cleanup, and client-side serialization.
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TIMEOUT_MS,
  HostBridge,
  HostBridgeError,
  HostBridgeUnavailable,
  MAILBOX_ENV,
  USER_CHOICE_TIMEOUT_MS,
  nextRequestId,
  resolveMailboxDir,
  toArgsJson,
} from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-ohos-bridge-'))
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

function newMailbox(tag) {
  const dir = join(root, tag)
  mkdirSync(dir)
  return dir
}

/** Answer requests in `dir` with `respond(reqPath, id, concurrentReqs)` until stopped. */
async function serve(dir, respond) {
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.req')) continue
        const reqPath = join(dir, name)
        const id = name.slice(0, -4)
        const concurrentReqs = readdirSync(dir).filter(entry => entry.endsWith('.req')).length
        // The ArkTS pump renames a request to `.wip` before dispatch.
        const takenPath = join(dir, `${id}.wip`)
        renameSync(reqPath, takenPath)
        respond(takenPath, id, concurrentReqs)
        try {
          unlinkSync(join(dir, `${id}.wip`))
        } catch {
          // Already cleaned by the responder.
        }
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  })()
  return async () => {
    stopped = true
    await loop
  }
}

await test('toArgsJson: objects, undefined, pre-serialized strings, invalid strings', () => {
  assert.equal(toArgsJson(undefined), '{}')
  assert.equal(toArgsJson(null), '{}')
  assert.equal(toArgsJson({ name: 'x' }), '{"name":"x"}')
  assert.equal(toArgsJson('{"a":1}'), '{"a":1}')
  assert.throws(() => toArgsJson('not json'), TypeError)
})

await test('nextRequestId: only [A-Za-z0-9-] and unique enough', () => {
  const ids = new Set()
  for (let index = 0; index < 50; index += 1) {
    const id = nextRequestId()
    assert.match(id, /^[A-Za-z0-9-]+$/)
    assert.match(id, /^\d+-\d+-[0-9a-f]{8}$/)
    ids.add(id)
  }
  assert.equal(ids.size, 50)
})

await test('missing mailbox env -> host-unavailable (never a fake success)', async () => {
  const saved = process.env[MAILBOX_ENV]
  delete process.env[MAILBOX_ENV]
  try {
    assert.throws(() => resolveMailboxDir(), error => error instanceof HostBridgeUnavailable && error.code === 'host-unavailable')
    const bridge = new HostBridge({ pollIntervalMs: 5, defaultTimeoutMs: 50 })
    await assert.rejects(bridge.invoke('runtime.facts', {}), error => error.code === 'host-unavailable')
  } finally {
    if (saved === undefined) delete process.env[MAILBOX_ENV]
    else process.env[MAILBOX_ENV] = saved
  }
})

await test('missing mailbox directory -> host-unavailable', async () => {
  const bridge = new HostBridge({ mailbox: join(root, 'does-not-exist'), pollIntervalMs: 5 })
  assert.equal(bridge.isAvailable(), false)
  await assert.rejects(bridge.invoke('runtime.facts', {}), error => error.code === 'host-unavailable')
})

await test('.done round trip: request shape, args string, response cleanup', async () => {
  const dir = newMailbox('done')
  const bridge = new HostBridge({ mailbox: dir, pollIntervalMs: 5, defaultTimeoutMs: 2_000 })
  assert.equal(bridge.isAvailable(), true)
  let request
  let observedArgs
  const stop = await serve(dir, (reqPath, id) => {
    request = JSON.parse(readFileSync(reqPath, 'utf8'))
    observedArgs = JSON.parse(request.args)
    writeFileSync(join(dir, `${id}.done`), JSON.stringify({ ok: true, value: 42 }))
  })
  try {
    const response = await bridge.invoke('runtime.facts', { probe: true })
    assert.deepEqual(response, { ok: true, value: 42 })
    assert.equal(request.name, 'runtime.facts')
    assert.equal(typeof request.args, 'string')
    assert.deepEqual(observedArgs, { probe: true })
    assert.equal(readdirSync(dir).length, 0, 'request and response files are removed')
  } finally {
    await stop()
  }
})

await test('.done envelope: result JSON string is unwrapped (ArkTS mailboxSettle shape)', async () => {
  const dir = newMailbox('envelope')
  const bridge = new HostBridge({ mailbox: dir, pollIntervalMs: 5, defaultTimeoutMs: 2_000 })
  const stop = await serve(dir, (_reqPath, id) => {
    // @fellow99/node-bridge 的 mailboxSettle 固定写这个形状；handler 的载荷在 result（字符串）
    writeFileSync(join(dir, `${id}.done`), JSON.stringify({ ok: true, result: JSON.stringify({ ok: true, data: 'abc', width: 3 }) }))
  })
  try {
    const response = await bridge.invoke('image.normalize', {})
    assert.deepEqual(response, { ok: true, data: 'abc', width: 3 })
  } finally {
    await stop()
  }
})

await test('.fail -> host-rejected with the ArkTS error/hint preserved', async () => {
  const dir = newMailbox('fail')
  const bridge = new HostBridge({ mailbox: dir, pollIntervalMs: 5 })
  const stop = await serve(dir, (_reqPath, id) => {
    writeFileSync(join(dir, `${id}.fail`), JSON.stringify({ ok: false, error: 'not-implemented', hint: 'image.normalize is P2' }))
  })
  try {
    await assert.rejects(bridge.invoke('image.normalize', {}), error => {
      assert.ok(error instanceof HostBridgeError)
      assert.equal(error.code, 'host-rejected')
      assert.equal(error.hostError, 'not-implemented')
      assert.equal(error.hint, 'image.normalize is P2')
      assert.match(error.message, /not-implemented/)
      return true
    })
    assert.equal(readdirSync(dir).length, 0)
  } finally {
    await stop()
  }
})

await test('.done with ok:false is a failure (host settle rule)', async () => {
  const dir = newMailbox('ok-false')
  const bridge = new HostBridge({ mailbox: dir, pollIntervalMs: 5 })
  const stop = await serve(dir, (_reqPath, id) => {
    writeFileSync(join(dir, `${id}.done`), JSON.stringify({ ok: false, error: 'handler-threw', hint: 'boom' }))
  })
  try {
    await assert.rejects(bridge.invoke('log.hilog', { msg: 'x' }), error => error.code === 'host-rejected' && error.hostError === 'handler-threw')
  } finally {
    await stop()
  }
})

await test('timeout -> host-timeout and the request file is cleaned up', async () => {
  const dir = newMailbox('timeout')
  const bridge = new HostBridge({ mailbox: dir, pollIntervalMs: 5 })
  await assert.rejects(bridge.invoke('notify.show', {}, { timeoutMs: 60 }), error => {
    assert.equal(error.code, 'host-timeout')
    assert.match(error.message, /notify\.show timed out after 60ms/)
    return true
  })
  assert.deepEqual(readdirSync(dir), [])
})

await test('abort -> host-aborted', async () => {
  const dir = newMailbox('abort')
  const bridge = new HostBridge({ mailbox: dir, pollIntervalMs: 5 })
  const controller = new AbortController()
  const pending = bridge.invoke('fs.pickFolder', {}, { timeoutMs: 5_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, error => error.code === 'host-aborted')
})

await test('invocations are serialized: one .req in the mailbox at a time', async () => {
  const dir = newMailbox('serial')
  const bridge = new HostBridge({ mailbox: dir, pollIntervalMs: 5, defaultTimeoutMs: 2_000 })
  const seen = []
  let maxConcurrentReqs = 0
  const stop = await serve(dir, (_reqPath, id, concurrentReqs) => {
    seen.push(id)
    maxConcurrentReqs = Math.max(maxConcurrentReqs, concurrentReqs)
    setTimeout(() => writeFileSync(join(dir, `${id}.done`), JSON.stringify({ ok: true, id })), 15)
  })
  try {
    const [first, second] = await Promise.all([bridge.invoke('log.hilog', { msg: 'a' }), bridge.invoke('log.hilog', { msg: 'b' })])
    assert.equal(seen.length, 2)
    assert.equal(maxConcurrentReqs, 1)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
  } finally {
    await stop()
  }
})

await test('timeouts: defaults and the user-choice budget', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000)
  assert.equal(USER_CHOICE_TIMEOUT_MS, 600_000)
})

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`host-bridge smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('host-bridge smoke: all checks passed')
}
