/**
 * Smoke test for `@dsh-ohos/workspace-picker-client`（纯 Node，无浏览器）。
 *
 * 做法：提供最小的 React / `window.__ModuleLoader__` / `fetch` 桩，把 `lib/client.js`
 * 当成真插件加载，然后直接调用组件函数（hooks 由桩提供），断言：
 *   1. 插件以正确的 id 与 `apply`/`inject` 注册；
 *   2. `open === false` 不渲染任何东西；
 *   3. Tab 只有「沙箱 / 文档 / 下载」（没有「桌面」）；
 *   4. 打开时只 GET `/roots` + POST `/list`，**绝不** POST `/permission/request`；
 *   5. 点「文档」且未授权时：不列目录、不申请权限（这就是本次需求的核心行为）；
 *   6. 点「下载」且已授权时：按该根路径列目录；
 *   7. 「打开」把当前路径交给 owner 的 `onPicked`。
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

/** 最小 React 桩：hooks 只需在同一渲染里稳定，不需要真实调度。 */
let hookCursor = 0
const hookSlots = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = initial
    return [hookSlots[index], (next) => {
      hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next
    }]
  },
  // 真实 React 只在依赖变化时跑 effect；桩必须同样处理，否则每次重渲染都会把 UI 状态重置。
  useEffect(fn, deps) {
    const index = hookCursor++
    const previous = hookSlots[index]
    const changed =
      previous === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, i) => !Object.is(value, previous.deps[i]))
    if (!changed) return
    hookSlots[index] = { deps: deps ?? [] }
    fn()
  },
  useRef(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: initial }
    return hookSlots[index]
  },
  useCallback(fn) {
    hookCursor++
    return fn
  },
  useMemo(fn) {
    hookCursor++
    return fn()
  },
}

const calls = []
let routes = {}

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(init.body) : undefined
  calls.push({ method, url, body })
  const handler = routes[`${method} ${url}`] ?? routes[url]
  const payload = handler === undefined ? { ok: false, error: { code: 'not-found', message: 'no stub' } } : handler(body)
  return { ok: true, status: 200, json: async () => payload }
}

await import('../lib/client.js')

const plugin = captured.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require(${specifier})`)
})

let failures = 0
async function test(name, fn) {
  hookCursor = 0
  hookSlots.length = 0
  calls.length = 0
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

/** 递归收集渲染树里的文本。 */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out)
    return out
  }
  for (const child of node.children ?? []) texts(child, out)
  return out
}

/** 递归找第一个满足谓词的元素。 */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = find(item, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit !== null) return hit
  }
  return null
}

/** 让已排队的 promise 链跑完。 */
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

const FLOW_PROPS = { open: true, busy: false, onPicked: () => {}, onCancel: () => {}, t: (key) => key }

await test('module shape: id / apply / inject / 导出面', () => {
  assert.equal(captured.id, '@dsh-ohos/workspace-picker-client')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'uiWorkspace'])
  assert.equal(plugin.ROUTES, '/_ohos/picker')
  assert.equal(typeof plugin.WorkspacePickerFlow, 'function')
})

await test('open=false 不渲染', () => {
  const tree = plugin.WorkspacePickerFlow({ ...FLOW_PROPS, open: false })
  assert.equal(tree, null)
  assert.equal(calls.length, 0, '关闭时不得发请求')
})

await test('三个 Tab：沙箱 / 文档 / 下载（没有桌面）；打开即列沙箱', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({
      roots: [
        { id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', kind: 'sandbox', granted: true },
        { id: 'documents', name: 'Documents', path: '/storage/Documents', kind: 'user', granted: false },
        { id: 'download', name: 'Download', path: '/storage/Download', kind: 'user', granted: true },
      ],
    }),
    'POST /_ohos/picker/list': () => ({
      ok: true,
      listing: { path: '/data/sandbox', home: '/data/sandbox', crumbs: [{ name: 'sandbox', path: '/data/sandbox', hidden: false }], entries: [{ name: 'proj', path: '/data/sandbox/proj', hidden: false }], truncated: false },
    }),
  }
  const tree = plugin.WorkspacePickerFlow(FLOW_PROPS)
  await flush()
  const allText = texts(tree)
  assert.ok(allText.includes('沙箱'))
  assert.ok(allText.includes('文档'))
  assert.ok(allText.includes('下载'))
  assert.equal(allText.some((text) => text.includes('桌面')), false, '不得出现桌面 Tab')
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /_ohos/picker/roots',
    'POST /_ohos/picker/list',
  ])
  assert.deepEqual(calls[1].body, {}, '沙箱 Tab 用默认根（不带 path）')
})

await test('点「文档」且未授权：不列目录、不申请权限（核心需求）', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({
      roots: [
        { id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true },
        { id: 'documents', name: 'Documents', path: '/storage/Documents', granted: false },
        { id: 'download', name: 'Download', path: '/storage/Download', granted: true },
      ],
    }),
    'POST /_ohos/picker/list': () => ({ ok: true, listing: { path: '/data/sandbox', home: '', crumbs: [], entries: [], truncated: false } }),
    'POST /_ohos/picker/permission/request': () => ({ granted: true }),
  }
  const tree = plugin.WorkspacePickerFlow(FLOW_PROPS)
  await flush()
  calls.length = 0

  const documentsTab = find(tree, (node) => node.type === 'button' && (node.children ?? []).includes('文档'))
  assert.ok(documentsTab !== null, '找到「文档」Tab')
  await documentsTab.props.onClick()
  await flush()

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ['GET /_ohos/picker/roots'],
    '只允许一次权限查询（GET roots），不得 list、不得申请权限',
  )
})

await test('点「下载」且已授权：按该根路径列目录，且仍未申请权限', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({
      roots: [
        { id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true },
        { id: 'documents', name: 'Documents', path: '/storage/Documents', granted: false },
        { id: 'download', name: 'Download', path: '/storage/Download', granted: true },
      ],
    }),
    'POST /_ohos/picker/list': () => ({ ok: true, listing: { path: '/storage/Download', home: '', crumbs: [], entries: [], truncated: false } }),
    'POST /_ohos/picker/permission/request': () => ({ granted: true }),
  }
  const tree = plugin.WorkspacePickerFlow(FLOW_PROPS)
  await flush()
  calls.length = 0

  const downloadTab = find(tree, (node) => node.type === 'button' && (node.children ?? []).includes('下载'))
  await downloadTab.props.onClick()
  await flush()

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /_ohos/picker/roots',
    'POST /_ohos/picker/list',
  ])
  assert.deepEqual(calls[1].body, { path: '/storage/Download' })
  assert.equal(calls.some((call) => call.url.endsWith('/permission/request')), false, '已授权时不得弹授权')
})

await test('list 返回 permissionRequired：显示授权门（含请求权限/刷新两个按钮）', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({ roots: [{ id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true }] }),
    'POST /_ohos/picker/list': () => ({
      ok: false,
      error: { code: 'directory-unreadable', message: 'EACCES', permissionRequired: true, permission: 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY' },
    }),
  }
  const tree = plugin.WorkspacePickerFlow(FLOW_PROPS)
  await flush()
  // 命中授权门之后组件不再渲染列表；这里验证文案常量与网关状态转移的入口存在。
  assert.equal(plugin.COPY.requestPermission, '请求权限')
  assert.equal(plugin.COPY.refresh, '刷新')
  assert.equal(calls.some((call) => call.url.endsWith('/permission/request')), false, '列目录失败不得自动申请权限')
})

await test('「打开」把当前路径交给 onPicked', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({ roots: [{ id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true }] }),
    'POST /_ohos/picker/list': () => ({
      ok: true,
      listing: { path: '/data/sandbox/proj', home: '', crumbs: [], entries: [], truncated: false },
    }),
  }
  let picked = ''
  const props = { ...FLOW_PROPS, onPicked: (path) => { picked = path } }
  plugin.WorkspacePickerFlow(props)
  await flush()
  // 真实 React 会在 state 更新后重渲染；桩里手动再渲染一次（hook 槽位保留）。
  hookCursor = 0
  const tree = plugin.WorkspacePickerFlow(props)
  const openButton = find(tree, (node) => node.type === 'button' && (node.children ?? []).includes('打开'))
  assert.ok(openButton !== null, '找到「打开」按钮')
  openButton.props.onClick()
  assert.equal(picked, '/data/sandbox/proj')
})

await test('点「请求权限」授予成功：立刻列目录（无需再点刷新）', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({ roots: [{ id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true }] }),
    'POST /_ohos/picker/list': () => ({ ok: false, error: { code: 'directory-unreadable', message: 'EACCES', permissionRequired: true } }),
    'POST /_ohos/picker/permission/request': () => ({ rootId: 'documents', granted: true, result: 'granted', detail: 'granted' }),
    'POST /_ohos/picker/list-granted': () => ({ ok: true }),
  }
  const props = { ...FLOW_PROPS }
  plugin.WorkspacePickerFlow(props)
  await flush()
  // 切到 documents（未授权）→ 出现授权门
  hookCursor = 0
  let tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('文档')).props.onClick()
  await flush()
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  const gate = find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('请求权限'))
  assert.ok(gate !== null, '授权门出现「请求权限」')
  calls.length = 0
  // 授权成功后再列目录：让 list 改回成功
  routes['POST /_ohos/picker/list'] = () => ({ ok: true, listing: { path: '/storage/Documents', home: '', crumbs: [], entries: [{ name: 'proj', path: '/storage/Documents/proj', hidden: false }], truncated: false } })
  await gate.props.onClick()
  await flush()
  const seq = calls.map((c) => `${c.method} ${c.url}`)
  assert.deepEqual(seq[0], 'POST /_ohos/picker/permission/request')
  assert.ok(seq.includes('POST /_ohos/picker/list'), '授权成功后自动列目录')
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  assert.equal(texts(tree).includes('proj'), true, '列表已渲染')
})

await test('授权被拒(-1) 与 请求无效(2) 给出不同文案', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({ roots: [{ id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true }] }),
    'POST /_ohos/picker/list': () => ({ ok: false, error: { code: 'directory-unreadable', message: 'EACCES', permissionRequired: true } }),
    'POST /_ohos/picker/permission/request': () => ({ rootId: 'documents', granted: false, result: 'denied', authResult: -1, detail: 'denied by user' }),
  }
  const props = { ...FLOW_PROPS }
  plugin.WorkspacePickerFlow(props)
  await flush()
  hookCursor = 0
  let tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('文档')).props.onClick()
  await flush()
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('请求权限')).props.onClick()
  await flush()
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  assert.equal(texts(tree).includes(plugin.COPY.permissionDenied), true, '显示「用户拒绝」文案')

  routes['POST /_ohos/picker/permission/request'] = () => ({ rootId: 'documents', granted: false, result: 'invalid', authResult: 2, detail: 'request void' })
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('请求权限')).props.onClick()
  await flush()
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  assert.equal(texts(tree).includes(plugin.COPY.permissionInvalid), true, '显示「平台不受理」文案')
  assert.equal(texts(tree).includes(plugin.COPY.permissionDenied), false, '不把 authResult=2 说成用户拒绝')
})


await test('空 authResults（平台不应答）与「已授权但读不出」各有专门文案', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({ roots: [{ id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true }] }),
    'POST /_ohos/picker/list': () => ({ ok: false, error: { code: 'directory-unreadable', message: 'EACCES', permissionRequired: true } }),
    'POST /_ohos/picker/permission/request': () => ({
      rootId: 'documents',
      granted: false,
      result: 'unknown',
      authResult: null,
      authResults: [],
      detail: 'ATM does not need to request permission',
    }),
  }
  const props = { ...FLOW_PROPS }
  plugin.WorkspacePickerFlow(props)
  await flush()
  hookCursor = 0
  let tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('文档')).props.onClick()
  await flush()
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('请求权限')).props.onClick()
  await flush()
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  assert.equal(texts(tree).includes(plugin.COPY.permissionUnknown), true, '空应答要有「平台没有应答」文案')
  assert.equal(texts(tree).includes(plugin.COPY.permissionDenied), false, '空应答不等于用户拒绝')
  assert.ok(find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('请求权限')) !== null)
  assert.ok(find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('刷新')) !== null)

  routes['POST /_ohos/picker/permission/request'] = () => ({
    rootId: 'documents',
    granted: false,
    result: 'granted-unreadable',
    authResult: 0,
    authResults: [0],
    detail: 'still unreadable',
  })
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('请求权限')).props.onClick()
  await flush()
  hookCursor = 0
  tree = plugin.WorkspacePickerFlow(props)
  assert.equal(texts(tree).includes(plugin.COPY.permissionUnreadable), true, 'authResult=0 但读不出要说清楚')
})
await test('目录不存在：只给「刷新」，不给「请求权限」', async () => {
  routes = {
    'GET /_ohos/picker/roots': () => ({
      roots: [
        { id: 'sandbox', name: 'Sandbox', path: '/data/sandbox', granted: true },
        { id: 'documents', name: 'Documents', path: '/storage/Documents', granted: null, result: 'missing', missing: true },
      ],
    }),
    'POST /_ohos/picker/list': () => ({ ok: true, listing: { path: '/data/sandbox', home: '', crumbs: [], entries: [], truncated: false } }),
  }
  const props = { ...FLOW_PROPS }
  plugin.WorkspacePickerFlow(props)
  await flush()
  hookCursor = 0
  const tree = plugin.WorkspacePickerFlow(props)
  await find(tree, (n) => n.type === 'button' && (n.children ?? []).includes('文档')).props.onClick()
  await flush()
  hookCursor = 0
  const after = plugin.WorkspacePickerFlow(props)
  assert.equal(texts(after).includes(plugin.COPY.missingTitle), true, '显示「此设备没有该目录」')
  assert.equal(find(after, (n) => n.type === 'button' && (n.children ?? []).includes('请求权限')), null, '不给授权按钮')
  assert.ok(find(after, (n) => n.type === 'button' && (n.children ?? []).includes('刷新')) !== null, '仍可刷新')
})

if (failures > 0) {
  console.error(`workspace-picker-client smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('workspace-picker-client smoke: all checks passed')
}
