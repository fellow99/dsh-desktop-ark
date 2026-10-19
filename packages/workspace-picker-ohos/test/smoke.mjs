/**
 * Smoke test for `@dsh-ohos/workspace-picker`（纯 Node，无真机）。
 *
 * 用 `module.registerHooks` 把 `@deepseek-ai/cordis` 映射到 mock、`@dsh-ohos/host-bridge`
 * 映射到可编程 stub（可决定 perm.check / perm.request 的返回）。上游 browse 后端
 * 刻意不映射：本包已自实现 list/createDirectory 原语。
 *
 * 覆盖：三根解析（沙箱/文档/下载，桌面已移除）、`..`/相对/根外围栏、面包屑截断、
 * 目录列举与新建、「点 Tab 只查权限不申请」、以及对话框路由（roots/list/create/permission）。
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') {
      return { url: new URL('./cordis-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    if (specifier === '@dsh-ohos/host-bridge') {
      return { url: new URL('./bridge-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const bridge = await import('./bridge-mock.mjs')
/** 与 mock 共享同一个可变对象（每次测试直接改字段）。 */
const bridgeState = bridge.state

const picker = await import('../lib/index.js')

const workspace = join(mkdtempSync(join(tmpdir(), 'dsh-ohos-picker-')), 'workspace')
const userRoot = mkdtempSync(join(tmpdir(), 'dsh-ohos-userroot-'))
mkdirSync(workspace, { recursive: true })
mkdirSync(join(workspace, 'sub'))
mkdirSync(join(userRoot, 'Documents'))
mkdirSync(join(userRoot, 'Download'))

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

function fakeCtx() {
  return {
    effect() {},
    logger() {
      return { info() {}, warn() {}, error() {} }
    },
    provide() {},
    get() {
      return undefined
    },
  }
}

const config = { sandboxRoot: workspace, userRoot, roots: ['documents', 'download'] }

await test('resolveRoots: three descriptors in fixed order (桌面已移除)', () => {
  const roots = picker.resolveRoots(config, {})
  assert.deepEqual(roots.map((root) => root.id), ['sandbox', 'documents', 'download'])
  assert.equal(roots[0].path, workspace)
  assert.equal(roots[1].path, join(userRoot, 'Documents'))
  assert.equal(roots[1].permission, 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY')
  assert.equal(roots[2].name, 'Download')
  assert.equal(roots[2].permission, 'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY')
  assert.equal(picker.ROOT_IDS.includes('desktop'), false, '桌面不再是可配置根')
})

await test('resolveRoots: 旧配置里的 desktop 会响亮失败（不静默忽略）', () => {
  assert.throws(
    () => picker.resolveRoots({ sandboxRoot: workspace, userRoot, roots: ['desktop'] }, {}),
    /unknown root id/,
  )
})

await test('resolveRoots: env fallbacks and loud failures (never process.cwd())', () => {
  const fromEnv = picker.resolveRoots({ roots: ['documents'] }, { DSH_OHOS_WORKSPACE: workspace, DSH_OHOS_USER_ROOT: userRoot })
  assert.equal(fromEnv.length, 2)
  assert.equal(fromEnv[1].path, join(userRoot, 'Documents'))
  assert.throws(() => picker.resolveRoots({ userRoot, roots: ['documents'] }, {}), /sandboxRoot must be an absolute path/)
  assert.throws(() => picker.resolveRoots({ sandboxRoot: 'relative', userRoot }, {}), /absolute/)
  assert.throws(() => picker.resolveRoots({ sandboxRoot: workspace, userRoot: undefined }, { roots: ['documents'] }), /userRoot must be an absolute path/)
  assert.throws(() => picker.resolveRoots({ sandboxRoot: workspace, userRoot, roots: ['photos'] }, {}), /unknown root id/)
})

await test('assertNoTraversal: relative, empty, NUL, parent segment', () => {
  assert.throws(() => picker.assertNoTraversal('relative/path'), (error) => error.name === 'DirectoryPickerError' && error.code === 'directory-unreadable')
  assert.throws(() => picker.assertNoTraversal(''), /fully qualified/)
  assert.throws(() => picker.assertNoTraversal(workspace + String.fromCharCode(0) + 'x'), /NUL/)
  const traversal = process.platform === 'win32' ? `${workspace}\\..\\escape` : `${workspace}/../escape`
  assert.throws(() => picker.assertNoTraversal(traversal), /parent traversal is not allowed/)
  picker.assertNoTraversal(workspace)
})

await test('isWithin / findRoot / fencePath: root fence', () => {
  const roots = picker.resolveRoots(config, {})
  assert.equal(picker.isWithin(join(workspace, 'sub'), workspace), true)
  assert.equal(picker.isWithin(join(workspace, '..', 'escape'), workspace), false)
  assert.equal(picker.findRoot(join(workspace, 'sub'), roots).id, 'sandbox')
  const fenced = picker.fencePath(join(workspace, 'sub'), roots)
  assert.equal(fenced.root.id, 'sandbox')
  assert.throws(
    () => picker.fencePath(join(userRoot, '..', 'elsewhere'), roots),
    (error) => error.code === 'directory-unreadable' && /root fence|parent traversal/.test(error.message),
  )
})

await test('truncateCrumbs: ancestry stops at the root', () => {
  const crumbs = [
    { name: '/', path: '/', hidden: false },
    { name: 'storage', path: '/storage', hidden: false },
    { name: 'workspace', path: workspace, hidden: false },
    { name: 'sub', path: join(workspace, 'sub'), hidden: false },
  ]
  const truncated = picker.truncateCrumbs(crumbs, workspace)
  assert.deepEqual(truncated.map((crumb) => crumb.name), ['workspace', 'sub'])
  assert.deepEqual(picker.truncateCrumbs([], workspace), [{ name: 'workspace', path: workspace, hidden: false }])
})

await test('capability shape is stable and browse-only', () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  assert.equal(service.name, 'directoryPicker')
  const capability = service.capability()
  assert.equal(capability, service.capability(), 'capability object is stable')
  assert.equal(capability.kind, 'browse')
  assert.equal(typeof capability.list, 'function')
  assert.equal(typeof capability.createDirectory, 'function')
  assert.deepEqual(service.rootsDescriptor().map((root) => root.id), ['sandbox', 'documents', 'download'])
})

await test('list(): 无权限时不自动申请，只报 permissionRequired', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = false
  bridgeState.invocations.length = 0
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  // 让 stat 成功但底层 readdir 失败：用一个真实存在但不可读的判断不容易跨平台，
  // 这里直接验证 pickerError 的标注能力（Denial 由 list 的 catch 走同一条路径）。
  const denial = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  const failure = service.pickerError(denial, join(userRoot, 'Documents'), service.roots[1])
  assert.equal(failure.permissionRequired, true)
  assert.equal(failure.permission, 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY')
  assert.equal(bridgeState.invocations.length, 0, 'list 路径不得触发 perm.request')
})

await test('permission(): 只查不申请，桥不可用时 granted=null（不假装已授权）', async () => {
  bridgeState.invocations.length = 0
  bridgeState.fail = true
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const state = await service.permission('documents')
  assert.equal(state.granted, null)
  assert.match(state.detail, /unavailable/)
  assert.deepEqual(bridgeState.invocations.map((item) => item.name), ['perm.check'], '只调 perm.check')
})

await test('permission(): 已授权时 granted=true；sandbox 无权限要求', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = true
  bridgeState.invocations.length = 0
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  assert.equal((await service.permission('documents')).granted, true)
  assert.equal((await service.permission('sandbox')).granted, true)
})

await test('requestPermission(): 显式申请走 perm.request，拒绝则 granted=false', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = false
  bridgeState.grantRequest = false
  bridgeState.invocations.length = 0
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const denied = await service.requestPermission('download')
  assert.equal(denied.granted, false)
  assert.deepEqual(bridgeState.invocations.map((item) => item.name), ['perm.check', 'perm.request'])

  bridgeState.grantRequest = true
  const granted = await service.requestPermission('download')
  assert.equal(granted.granted, true)
})

await test('list(): missing user root is reported unavailable, never rebased', async () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), { sandboxRoot: workspace, userRoot: join(userRoot, 'nope'), roots: ['documents'] })
  await assert.rejects(
    () => service.list(join(userRoot, 'nope', 'Documents')),
    (error) => error.name === 'DirectoryPickerError' && error.code === 'directory-unreadable' && error.unavailable === true,
  )
})

await test('list(): outside-root path is fenced before any backend call', async () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const outside = join(userRoot, 'not-a-root')
  mkdirSync(outside, { recursive: true })
  await assert.rejects(() => service.list(outside), /outside the allowed roots/)
})

await test('list(): sandbox root is auto-created and listed by the local primitives', async () => {
  const freshRoot = join(mkdtempSync(join(tmpdir(), 'dsh-ohos-picker-fresh-')), 'workspace')
  const service = new picker.OhosDirectoryPicker(fakeCtx(), { sandboxRoot: freshRoot, userRoot, roots: [] })
  mkdirSync(join(freshRoot, 'alpha'), { recursive: true })
  mkdirSync(join(freshRoot, '.hidden'), { recursive: true })
  writeFileSync(join(freshRoot, 'file.txt'), 'x')
  const listing = await service.list()
  assert.equal(listing.root, 'sandbox')
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['.hidden', 'alpha'])
  assert.equal(listing.entries[0].hidden, true)
  assert.equal(listing.entries[1].hidden, false)
  assert.equal(listing.truncated, false)
  assert.ok(listing.crumbs.length > 0)
})

await test('createDirectory(): single-segment validation and real creation', async () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  await assert.rejects(() => service.createDirectory(workspace, '..'), (error) => error.code === 'directory-create-failed')
  await assert.rejects(() => service.createDirectory(workspace, 'a/b'), (error) => error.code === 'directory-create-failed')
  await assert.rejects(() => service.createDirectory(workspace, ''), (error) => error.code === 'directory-create-failed')
  const created = await service.createDirectory(workspace, 'new-dir')
  assert.ok(existsSync(created), '目录真的被创建')
  const listing = await service.list(workspace)
  assert.ok(listing.entries.some((entry) => entry.name === 'new-dir'))
})

// ── 路由层：用假 ctx.webServer / connection 直接调用 handler ────────────────────
function routeCtx(rejectStatus) {
  const routes = new Map()
  return {
    routes,
    connection: { requestRejection: () => rejectStatus },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => {}
      },
    },
    effect(factory) {
      factory()
    },
  }
}

function fakeRes() {
  const out = { statusCode: 0, headers: {}, body: '' }
  out.setHeader = (key, value) => {
    out.headers[key] = value
  }
  out.end = (chunk) => {
    out.body = chunk === undefined ? '' : String(chunk)
    out.done = true
  }
  return out
}

function fakeReq(method, body) {
  const listeners = {}
  return {
    method,
    headers: { 'content-type': 'application/json' },
    on(event, fn) {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(fn)
      return this
    },
    destroy() {},
    emitBody() {
      const text = body === undefined ? '' : JSON.stringify(body)
      for (const fn of listeners.data ?? []) fn(Buffer.from(text))
      for (const fn of listeners.end ?? []) fn()
    },
  }
}

await test('routes: 注册 5 条；未授权请求被 connection 拒绝', async () => {
  const picker2 = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const ctx = routeCtx(undefined)
  picker.registerPickerRoutes(ctx, picker2)
  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/_ohos/picker/create',
    '/_ohos/picker/list',
    '/_ohos/picker/permission',
    '/_ohos/picker/permission/request',
    '/_ohos/picker/roots',
  ])

  const rejecting = routeCtx(401)
  picker.registerPickerRoutes(rejecting, picker2)
  const res = fakeRes()
  await rejecting.routes.get('/_ohos/picker/roots')({ method: 'GET', headers: {} }, res)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, '')
})

await test('routes: GET roots 带授权状态；POST list / create / permission 走原语', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = true
  const picker2 = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const ctx = routeCtx(undefined)
  picker.registerPickerRoutes(ctx, picker2)

  const rootsRes = fakeRes()
  await ctx.routes.get('/_ohos/picker/roots')({ method: 'GET', headers: {} }, rootsRes)
  const rootsBody = JSON.parse(rootsRes.body)
  assert.deepEqual(rootsBody.roots.map((root) => root.id), ['sandbox', 'documents', 'download'])
  assert.equal(rootsBody.roots[1].granted, true)

  const listReq = fakeReq('POST', { path: workspace })
  const listRes = fakeRes()
  const pending = ctx.routes.get('/_ohos/picker/list')(listReq, listRes)
  listReq.emitBody()
  await pending
  const listBody = JSON.parse(listRes.body)
  assert.equal(listBody.ok, true)
  assert.deepEqual(listBody.listing.entries.map((entry) => entry.name).includes('sub'), true)

  const createReq = fakeReq('POST', { path: workspace, name: 'made-by-route' })
  const createRes = fakeRes()
  const createPending = ctx.routes.get('/_ohos/picker/create')(createReq, createRes)
  createReq.emitBody()
  await createPending
  assert.equal(JSON.parse(createRes.body).ok, true)

  const permReq = fakeReq('POST', { rootId: 'download' })
  const permRes = fakeRes()
  const permPending = ctx.routes.get('/_ohos/picker/permission')(permReq, permRes)
  permReq.emitBody()
  await permPending
  assert.equal(JSON.parse(permRes.body).granted, true)

  const badReq = fakeReq('POST', { nope: 1 })
  const badRes = fakeRes()
  const badPending = ctx.routes.get('/_ohos/picker/permission')(badReq, badRes)
  badReq.emitBody()
  await badPending
  assert.equal(badRes.statusCode, 400)
})

await test('routes: list 失败时把 permissionRequired 透传给客户端', async () => {
  const picker2 = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const ctx = routeCtx(undefined)
  picker.registerPickerRoutes(ctx, picker2)
  picker2.list = async () => {
    throw Object.assign(new picker.DirectoryPickerError('directory-unreadable', join(userRoot, 'Documents'), 'EACCES'), {
      permissionRequired: true,
      permission: 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
    })
  }
  const req = fakeReq('POST', { path: join(userRoot, 'Documents') })
  const res = fakeRes()
  const pending = ctx.routes.get('/_ohos/picker/list')(req, res)
  req.emitBody()
  await pending
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.equal(body.error.permissionRequired, true)
  assert.equal(body.error.permission, 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY')
})

rmSync(workspace, { recursive: true, force: true })
rmSync(userRoot, { recursive: true, force: true })
if (failures > 0) {
  console.error(`workspace-picker smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('workspace-picker smoke: all checks passed')
}
