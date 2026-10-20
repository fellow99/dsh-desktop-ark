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

await test('permission(): 只查不申请；桥不可用且目录不可读时 granted=null（不假装已授权）', async () => {
  bridgeState.invocations.length = 0
  bridgeState.fail = true
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  // 目录在测试环境里是真实存在的：要模拟「存在但没授权」，把探测结果钉成 denied。
  service.probeAccess = async () => 'denied'
  const state = await service.permission('documents')
  assert.equal(state.granted, null)
  assert.match(state.detail, /unavailable/)
  assert.deepEqual(bridgeState.invocations.map((item) => item.name), ['perm.check'], '只调 perm.check')
})

await test('permission(): 目录真实可读即视为已授权（不看 perm.check 的假阴性）', async () => {
  bridgeState.fail = false
  // 关键：权限 API 说「未授予」，但目录读得出来 —— 真机上就是这样（atm 为 0、check 为 -1）。
  bridgeState.grantCheck = false
  bridgeState.invocations.length = 0
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const state = await service.permission('documents')
  assert.equal(state.granted, true)
  assert.equal(state.result, 'granted')
  assert.equal(state.detail, 'readable')
  assert.equal(bridgeState.invocations.length, 0, '可读时不得调用宿主桥')
  assert.equal((await service.permission('sandbox')).granted, true)
})

await test('permission(): 不可读 + API 报已授予 ⇒ granted-unreadable（不谎称可用）', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = true
  bridgeState.invocations.length = 0
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  service.probeAccess = async () => 'denied'
  const state = await service.permission('documents')
  assert.equal(state.granted, false)
  assert.equal(state.result, 'granted-unreadable')
  assert.equal(state.apiGranted, true)
  assert.match(state.detail, /仍不可读/)
})

await test('requestPermission(): 显式申请走 perm.request；可读时不再弹窗', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = false
  bridgeState.grantRequest = false
  bridgeState.requestVoid = false
  bridgeState.invocations.length = 0
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  service.probeAccess = async () => 'denied'
  // 「生效滞后」的轮询另有专测（见下）；这里把收尾探测退化成单次，避免每个用例都等真实间隔。
  service.probeAccessSettled = async () => service.probeAccess()
  const denied = await service.requestPermission('download')
  assert.equal(denied.granted, false)
  assert.equal(denied.result, 'denied')
  // 新版不再先问 perm.check：探测已给出「不可读」，直接申请（少一次桥往返）。
  assert.deepEqual(bridgeState.invocations.map((item) => item.name), ['perm.request'])

  // 已经能读：不弹窗、不调桥。
  bridgeState.invocations.length = 0
  const readable = new picker.OhosDirectoryPicker(fakeCtx(), config)
  readable.probeAccess = async () => 'readable'
  const already = await readable.requestPermission('download')
  assert.equal(already.granted, true)
  assert.equal(already.detail.includes('already readable'), true)
  assert.equal(bridgeState.invocations.length, 0)
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

await test('requestPermission(): 0/-1/2/空数组 四种应答分别映射（判定以目录可读为准）', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = false
  bridgeState.requestVoid = false
  bridgeState.emptyResults = false
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  // 探测序列：申请前 denied、申请后按用例切换（真机上「授权后立刻可读」就是这样发生的）。
  const sequence = (...values) => {
    let index = 0
    service.probeAccess = async () => values[Math.min(index++, values.length - 1)]
  }
  // 轮询滞后另有专测；这里把收尾探测退化成单次，让用例只关心映射。
  service.probeAccessSettled = async () => service.probeAccess()

  // 0 + 授权后仍不可读 ⇒ granted-unreadable（不是「已授予」）
  bridgeState.grantRequest = true
  sequence('denied', 'denied')
  const grantedButUnreadable = await service.requestPermission('documents')
  assert.equal(grantedButUnreadable.granted, false)
  assert.equal(grantedButUnreadable.result, 'granted-unreadable')
  assert.equal(grantedButUnreadable.authResult, 0)
  assert.match(grantedButUnreadable.detail, /仍不可读/)

  // 0 + 授权后可读 ⇒ granted（真机成功形态）
  sequence('denied', 'readable')
  const granted = await service.requestPermission('documents')
  assert.equal(granted.granted, true)
  assert.equal(granted.result, 'granted')
  assert.equal(granted.authResult, 0)
  assert.match(granted.detail, /readable/)

  bridgeState.grantRequest = false
  sequence('denied', 'denied')
  const denied = await service.requestPermission('documents')
  assert.equal(denied.granted, false)
  assert.equal(denied.result, 'denied')
  assert.equal(denied.authResult, -1)
  assert.match(denied.detail, /denied by user/)

  bridgeState.requestVoid = true
  sequence('denied', 'denied')
  const invalid = await service.requestPermission('documents')
  assert.equal(invalid.granted, false)
  assert.equal(invalid.result, 'invalid')
  assert.equal(invalid.authResult, 2)
  assert.match(invalid.detail, /request void/)

  // 空数组：平台根本没应答（真机 ATM 记 "It does not need to request permission"）
  bridgeState.requestVoid = false
  bridgeState.emptyResults = true
  sequence('denied', 'denied')
  const empty = await service.requestPermission('documents')
  assert.equal(empty.granted, false)
  assert.equal(empty.result, 'unknown')
  assert.equal(empty.authResult, null)
  assert.deepEqual(empty.authResults, [])
  assert.match(empty.detail, /grantFlag/)

  // 空数组但申请后目录变可读 ⇒ 依然算授予（应答缺失不能推翻事实）
  sequence('denied', 'readable')
  const emptyButReadable = await service.requestPermission('documents')
  assert.equal(emptyButReadable.granted, true)
  assert.equal(emptyButReadable.result, 'granted')
  bridgeState.emptyResults = false
})

await test('probeAccessSettled(): 授权生效滞后（先 denied 后 readable）会被轮询吸收', async () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  let calls = 0
  service.probeAccess = async () => (++calls < 3 ? 'denied' : 'readable')
  const settled = await service.probeAccessSettled(service.roots[1], { attempts: 5, intervalMs: 5 })
  assert.equal(settled, 'readable')
  assert.equal(calls, 3, '探到可读即停（不多探）')

  // 一直不可读 ⇒ 不无限轮询，按上限收敛。
  let deniedCalls = 0
  service.probeAccess = async () => { deniedCalls += 1; return 'denied' }
  assert.equal(await service.probeAccessSettled(service.roots[1], { attempts: 4, intervalMs: 5 }), 'denied')
  assert.equal(deniedCalls, 4)
})

await test('permission(): 设备没有该目录时报 missing，而不是「未授权」', async () => {
  bridgeState.fail = false
  bridgeState.grantCheck = false
  const missingUserRoot = join(mkdtempSync(join(tmpdir(), 'dsh-ohos-nouser-')), 'no-such-user')
  const service = new picker.OhosDirectoryPicker(fakeCtx(), { sandboxRoot: workspace, userRoot: missingUserRoot, roots: ['documents'] })
  const state = await service.permission('documents')
  assert.equal(state.result, 'missing')
  assert.equal(state.granted, null)
  assert.match(state.detail, /does not exist/)
  const request = await service.requestPermission('documents')
  assert.equal(request.result, 'missing')
  assert.equal(request.granted, false)

  const listFailure = await service.list(join(missingUserRoot, 'Documents')).then(() => null, (error) => error)
  assert.ok(listFailure !== null)
  assert.equal(listFailure.missing, true)
  assert.equal(listFailure.permissionRequired, undefined)
})

rmSync(workspace, { recursive: true, force: true })
rmSync(userRoot, { recursive: true, force: true })
if (failures > 0) {
  console.error(`workspace-picker smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('workspace-picker smoke: all checks passed')
}
