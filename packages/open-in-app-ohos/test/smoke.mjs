/**
 * Smoke test for `@dsh-ohos/open-in-app` (pure Node).
 *
 * `@dsh-ohos/host-bridge` is mapped to `test/bridge-mock.mjs` via
 * `module.registerHooks`, so the whole plugin (routes, trust fence, wire
 * validation, launch) runs without a device.
 *
 * Covers: target classification (https / workspace file / rejections), body
 * parsing, all three routes, every validation status (401/405/415/413/400/404),
 * the success path's `file:` URI, and the 502 bridge-failure path.
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@dsh-ohos/host-bridge') {
      return { url: new URL('./bridge-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const plugin = await import('../lib/index.js')
const bridge = await import('@dsh-ohos/host-bridge')

const workspace = mkdtempSync(join(tmpdir(), 'dsh-ohos-open-'))
process.env.DSH_OHOS_WORKSPACE = workspace
const insideFile = join(workspace, 'note.txt')
writeFileSync(insideFile, 'hello')

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

function fakeContext() {
  const routes = new Map()
  const connection = { rejection: undefined, requestRejection() { return this.rejection } }
  return {
    routes,
    connection,
    webServer: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
    effect(fn) {
      fn()
    },
    logger() {
      return { info() {}, warn() {}, error() {} }
    },
  }
}

function makeRequest({ method = 'GET', url = '/', headers = {}, body = undefined }) {
  return {
    method,
    url,
    headers,
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk.toString()
    },
  }
}

async function call(routeKey, request) {
  const route = context.routes.get(routeKey)
  assert.ok(route, `route ${routeKey} is registered`)
  const response = makeResponse()
  await route.handler(request, response)
  return response
}

const context = fakeContext()
plugin.apply(context, { probeTimeoutMs: 1_000, iconTimeoutMs: 1_000, launchWatchMs: 500 })

await test('parseOpenBody: JSON object with string app/path only', () => {
  assert.deepEqual(plugin.parseOpenBody('{"app":"system","path":"/x"}'), { app: 'system', path: '/x' })
  assert.equal(plugin.parseOpenBody('not json'), null)
  assert.equal(plugin.parseOpenBody('[]'), null)
  assert.equal(plugin.parseOpenBody('{"app":1,"path":"/x"}'), null)
  assert.equal(plugin.parseOpenBody('{"app":"system"}'), null)
})

await test('classifyTarget: https allowed, other schemes/relative/outside rejected', () => {
  assert.deepEqual(plugin.classifyTarget('https://example.com/a', workspace), { kind: 'https', uri: 'https://example.com/a' })
  assert.equal(plugin.classifyTarget('http://example.com', workspace).kind, 'invalid')
  assert.equal(plugin.classifyTarget('javascript:alert(1)', workspace).kind, 'invalid')
  assert.equal(plugin.classifyTarget('file:///etc/passwd', workspace).kind, 'invalid')
  assert.equal(plugin.classifyTarget('relative/file.txt', workspace).kind, 'invalid')
  assert.equal(plugin.classifyTarget('', workspace).kind, 'invalid')
  assert.equal(plugin.classifyTarget(join(workspace, '..', 'escape.txt'), workspace).kind, 'invalid')
  assert.deepEqual(plugin.classifyTarget(insideFile, workspace), { kind: 'path', path: insideFile })
  const savedWorkspace = process.env.DSH_OHOS_WORKSPACE
  delete process.env.DSH_OHOS_WORKSPACE
  try {
    assert.equal(plugin.classifyTarget(insideFile).kind, 'invalid')
  } finally {
    process.env.DSH_OHOS_WORKSPACE = savedWorkspace
  }
})

await test('routes are registered at the upstream paths', () => {
  assert.deepEqual([...context.routes.keys()].sort(), [
    'exact:/open-in-app/apps',
    'exact:/open-in-app/open',
    'prefix:/open-in-app/icon',
  ])
})

await test('connection fence: rejection is written back before any work', async () => {
  context.connection.rejection = 401
  try {
    const response = await call('exact:/open-in-app/apps', makeRequest({}))
    assert.equal(response.statusCode, 401)
    assert.equal(response.body, '')
  } finally {
    context.connection.rejection = undefined
  }
})

await test('GET /open-in-app/apps: catalog and method guard', async () => {
  const response = await call('exact:/open-in-app/apps', makeRequest({ method: 'GET' }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { apps: ['system'] })
  const wrongMethod = await call('exact:/open-in-app/apps', makeRequest({ method: 'POST' }))
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')
})

await test('GET /open-in-app/icon/<id>: 404 with a JSON body', async () => {
  const response = await call('prefix:/open-in-app/icon', makeRequest({ method: 'GET', url: '/open-in-app/icon/finder' }))
  assert.equal(response.statusCode, 404)
  assert.equal(JSON.parse(response.body).code, 'not-found')
})

await test('POST /open-in-app/open: 415 for a non-JSON content type', async () => {
  const response = await call('exact:/open-in-app/open', makeRequest({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))
  assert.equal(response.statusCode, 415)
})

await test('POST /open-in-app/open: 413 for an oversized body', async () => {
  const response = await call('exact:/open-in-app/open', makeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"app":"system","path":"${'x'.repeat(70_000)}"}`,
  }))
  assert.equal(response.statusCode, 413)
})

await test('POST /open-in-app/open: 400 for bad JSON, unknown app, relative path, outside path', async () => {
  const post = body => call('exact:/open-in-app/open', makeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body }))
  assert.equal((await post('not json')).statusCode, 400)
  assert.equal((await post('{"app":"finder","path":"/x"}')).statusCode, 400)
  assert.equal((await post('{"app":"system","path":"relative"}')).statusCode, 400)
  assert.equal((await post(`{"app":"system","path":"${join(tmpdir(), 'outside.txt')}"}`)).statusCode, 400)
})

await test('POST /open-in-app/open: 404 for a missing workspace file', async () => {
  const response = await call('exact:/open-in-app/open', makeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'system', path: join(workspace, 'missing.txt') }),
  }))
  assert.equal(response.statusCode, 404)
})

await test('POST /open-in-app/open: 200 + shell.openExternal with a file: URI', async () => {
  bridge.calls.length = 0
  bridge.state.fail = undefined
  const response = await call('exact:/open-in-app/open', makeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'system', path: insideFile }),
  }))
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true })
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].name, 'shell.openExternal')
  assert.equal(bridge.calls[0].args.uri, pathToFileURL(insideFile).href)
})

await test('POST /open-in-app/open: https target reaches the bridge unchanged', async () => {
  bridge.calls.length = 0
  const response = await call('exact:/open-in-app/open', makeRequest({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'system', path: 'https://example.com/x' }),
  }))
  assert.equal(response.statusCode, 200)
  assert.equal(bridge.calls[0].args.uri, 'https://example.com/x')
})

await test('POST /open-in-app/open: bridge failure -> 502 with the ArkTS error/hint', async () => {
  bridge.state.fail = new bridge.HostBridgeError('host-rejected', 'host-bridge: shell.openExternal failed [not-implemented]: only https links are allowed', {
    hostError: 'not-implemented',
    hint: 'only https links are allowed in 000-scaffold',
  })
  try {
    const response = await call('exact:/open-in-app/open', makeRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'system', path: insideFile }),
    }))
    assert.equal(response.statusCode, 502)
    const payload = JSON.parse(response.body)
    assert.equal(payload.code, 'launch-failed')
    assert.equal(payload.error, 'not-implemented')
    assert.equal(payload.hint, 'only https links are allowed in 000-scaffold')
  } finally {
    bridge.state.fail = undefined
  }
})

await test('config validation: bounded millisecond values', () => {
  const fresh = fakeContext()
  assert.throws(() => plugin.apply(fresh, { launchWatchMs: 0 }), /launchWatchMs/)
  assert.throws(() => plugin.apply(fresh, { probeTimeoutMs: 1_000_000 }), /probeTimeoutMs/)
  const brokenConnection = fakeContext()
  brokenConnection.connection = undefined
  assert.throws(() => plugin.apply(brokenConnection, {}), /requestRejection/)
})

rmSync(workspace, { recursive: true, force: true })
if (failures > 0) {
  console.error(`open-in-app smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('open-in-app smoke: all checks passed')
}
