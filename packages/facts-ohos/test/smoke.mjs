/**
 * Smoke test for `@dsh-ohos/facts` (pure Node).
 *
 * `@dsh-ohos/host-bridge` is mapped to `test/bridge-mock.mjs` via
 * `module.registerHooks`.
 *
 * Covers: disabled-by-default registration, the exact route, the connection
 * fence (401/403), the GET-only guard, the payload (node/profile/port/rows/
 * env/shims/capabilities), and the hard rule that a token value never appears
 * (only its name in `redactedEnv`).
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

const facts = await import('../lib/index.js')

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

function fakeContext({ rejection = undefined, loader = undefined } = {}) {
  const routes = new Map()
  const logs = []
  return {
    routes,
    logs,
    connection: { rejection, requestRejection() { return this.rejection } },
    webServer: {
      port: 41234,
      getOrigin() {
        return 'http://127.0.0.1:41234'
      },
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
    get(name) {
      return name === 'loader' ? loader : undefined
    },
    effect(fn) {
      fn()
    },
    logger() {
      return { info: message => logs.push(message), warn() {}, error() {} }
    },
  }
}

function makeRequest({ method = 'GET' }) {
  return { method, headers: {}, url: facts.FACTS_PATH }
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

await test('metadata: plugin name, inject, path, capability split', () => {
  assert.equal(facts.name, 'facts-ohos')
  assert.deepEqual(facts.inject, ['webServer', 'connection'])
  assert.equal(facts.FACTS_PATH, '/_ohos/facts')
  assert.equal(facts.IMPLEMENTED_CAPABILITIES.length, 6)
  assert.equal(facts.PLACEHOLDER_CAPABILITIES.length, 8)
  assert.ok(facts.PLACEHOLDER_CAPABILITIES.includes('image.normalize'))
})

await test('dshOhosEnv: only DSH_OHOS_* names, sensitive names redacted (value never read)', () => {
  const { values, redacted } = facts.dshOhosEnv({
    DSH_OHOS_WORKSPACE: '/data/workspace',
    DSH_OHOS_MAILBOX: '/data/mailbox',
    DSH_OHOS_TOKEN: 'super-secret',
    DSH_OHOS_API_KEY: 'super-secret',
    DSH_OHOS_AUTH_COOKIE: 'super-secret',
    DSH_PROFILE: 'ohos',
    PATH: '/system/bin',
  })
  assert.deepEqual(values, { DSH_OHOS_WORKSPACE: '/data/workspace', DSH_OHOS_MAILBOX: '/data/mailbox' })
  assert.deepEqual(redacted, ['DSH_OHOS_API_KEY', 'DSH_OHOS_AUTH_COOKIE', 'DSH_OHOS_TOKEN'])
  assert.equal(JSON.stringify({ values, redacted }).includes('super-secret'), false)
})

await test('readShims: env channel, global channel, honest unavailable note', () => {
  assert.deepEqual(facts.readShims({ DSH_OHOS_SHIMS: 'DSH_OHOS_SHIM fs.link, DSH_OHOS_SHIM sharp' }, {}), {
    source: 'env:DSH_OHOS_SHIMS',
    markers: ['DSH_OHOS_SHIM fs.link', 'DSH_OHOS_SHIM sharp'],
  })
  const global = facts.readShims({}, { __DSH_OHOS_SHIMS__: ['DSH_OHOS_SHIM flock', { marker: 'DSH_OHOS_SHIM sharp' }] })
  assert.equal(global.source, 'global:__DSH_OHOS_SHIMS__')
  assert.deepEqual(global.markers, ['DSH_OHOS_SHIM flock', 'DSH_OHOS_SHIM sharp'])
  const absent = facts.readShims({}, {})
  assert.equal(absent.source, 'unavailable')
  assert.deepEqual(absent.markers, [])
  assert.match(absent.note, /no shim registry/)
})

await test('readBundleRows: loader store projection, sorted, tolerant of a missing loader', () => {
  const loader = {
    store: {
      b: { id: 'shell-ohos', options: { name: '@dsh-ohos/shell', disabled: false } },
      a: { options: { id: 'facts-ohos', name: '@dsh-ohos/facts', disabled: true } },
    },
  }
  assert.deepEqual(facts.readBundleRows(fakeContext({ loader })), [
    { id: 'facts-ohos', name: '@dsh-ohos/facts', disabled: true },
    { id: 'shell-ohos', name: '@dsh-ohos/shell', disabled: false },
  ])
  assert.deepEqual(facts.readBundleRows(fakeContext()), [])
})

await test('collectFacts: node/profile/port/rows/env/shims/capabilities, no tokens', () => {
  const env = {
    DSH_PROFILE: 'ohos',
    DSH_OHOS_WORKSPACE: '/data/workspace',
    DSH_OHOS_TOKEN: 'never-print-me',
    DSH_OHOS_SHIMS: 'DSH_OHOS_SHIM fs.link',
  }
  const loader = { store: { row: { id: 'row', options: { name: '@dsh-ohos/x', disabled: false } } } }
  const payload = facts.collectFacts(fakeContext({ loader }), env, {})
  assert.equal(payload.schema, 1)
  assert.equal(payload.node.version, process.version)
  assert.equal(payload.profile, 'ohos')
  assert.equal(payload.webServer.port, 41234)
  assert.equal(payload.webServer.origin, 'http://127.0.0.1:41234')
  assert.deepEqual(payload.bundleRows, [{ id: 'row', name: '@dsh-ohos/x', disabled: false }])
  assert.equal(payload.env.DSH_OHOS_WORKSPACE, '/data/workspace')
  assert.deepEqual(payload.redactedEnv, ['DSH_OHOS_TOKEN'])
  assert.deepEqual(payload.shims.markers, ['DSH_OHOS_SHIM fs.link'])
  assert.equal(payload.capabilities.sandbox, 'none')
  assert.equal(payload.capabilities.pty, false)
  assert.equal(payload.capabilities.hostBridge.available, false)
  assert.equal(payload.capabilities.hostBridge.capabilities.length, 14)
  assert.equal(JSON.stringify(payload).includes('never-print-me'), false)
  assert.match(payload.honesty.tokens, /never included/)
})

await test('apply(): disabled by default registers nothing and says so', () => {
  const ctx = fakeContext()
  facts.apply(ctx, { enabled: false })
  assert.equal(ctx.routes.size, 0)
  assert.ok(ctx.logs.some(line => /disabled/.test(line)))
  facts.apply(ctx, {})
  assert.equal(ctx.routes.size, 0)
})

await test('apply(): enabled registers the exact route, fences 401 and 405', async () => {
  const ctx = fakeContext({ rejection: 403 })
  facts.apply(ctx, { enabled: true })
  const route = ctx.routes.get(`exact:${facts.FACTS_PATH}`)
  assert.ok(route)
  const rejected = makeResponse()
  route.handler(makeRequest({ method: 'GET' }), rejected)
  assert.equal(rejected.statusCode, 403)
  assert.equal(rejected.body, '')

  ctx.connection.rejection = undefined
  const wrongMethod = makeResponse()
  route.handler(makeRequest({ method: 'POST' }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')
})

await test('apply(): GET returns the JSON snapshot with no token value', () => {
  const saved = process.env.DSH_OHOS_TOKEN
  process.env.DSH_OHOS_TOKEN = 'endpoint-secret'
  process.env.DSH_OHOS_WORKSPACE = '/data/workspace'
  const ctx = fakeContext()
  facts.apply(ctx, { enabled: true })
  try {
    const route = ctx.routes.get(`exact:${facts.FACTS_PATH}`)
    const response = makeResponse()
    route.handler(makeRequest({ method: 'GET' }), response)
    assert.equal(response.statusCode, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.capabilities.hostBridge.placeholders.length, 8)
    assert.ok(payload.redactedEnv.includes('DSH_OHOS_TOKEN'))
    assert.equal(response.body.includes('endpoint-secret'), false)
  } finally {
    if (saved === undefined) delete process.env.DSH_OHOS_TOKEN
    else process.env.DSH_OHOS_TOKEN = saved
  }
})

if (failures > 0) {
  console.error(`facts smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('facts smoke: all checks passed')
}
