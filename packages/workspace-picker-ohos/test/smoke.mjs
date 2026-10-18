/**
 * Smoke test for `@dsh-ohos/workspace-picker` (pure Node).
 *
 * Uses `module.registerHooks` to map `@deepseek-ai/cordis` to a mock and
 * `@dsh-ohos/host-bridge` to a failing stub. The upstream browse backend is
 * intentionally NOT mapped, so the `directory-picker/unavailable` path is the
 * one exercised here.
 *
 * Covers: root resolution/config validation, `..`/relative/outside fences,
 * breadcrumb truncation, entry canonicalization, and the capability shape.
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

const picker = await import('../lib/index.js')

const workspace = join(mkdtempSync(join(tmpdir(), 'dsh-ohos-picker-')), 'workspace')
const userRoot = mkdtempSync(join(tmpdir(), 'dsh-ohos-userroot-'))
mkdirSync(workspace, { recursive: true })
mkdirSync(join(workspace, 'sub'))
mkdirSync(join(userRoot, 'Desktop'))

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

const config = { sandboxRoot: workspace, userRoot, roots: ['desktop', 'documents', 'download'] }

await test('resolveRoots: four descriptors with fixed order, names, permissions', () => {
  const roots = picker.resolveRoots(config, {})
  assert.deepEqual(roots.map(root => root.id), ['sandbox', 'desktop', 'documents', 'download'])
  assert.equal(roots[0].path, workspace)
  assert.equal(roots[1].path, join(userRoot, 'Desktop'))
  assert.equal(roots[1].permission, 'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY')
  assert.equal(roots[2].name, 'Documents')
  assert.equal(roots[3].name, 'Download')
})

await test('resolveRoots: env fallbacks and loud failures (never process.cwd())', () => {
  const fromEnv = picker.resolveRoots({ roots: ['desktop'] }, { DSH_OHOS_WORKSPACE: workspace, DSH_OHOS_USER_ROOT: userRoot })
  assert.equal(fromEnv.length, 2)
  assert.throws(() => picker.resolveRoots({ userRoot, roots: ['desktop'] }, {}), /sandboxRoot must be an absolute path/)
  assert.throws(() => picker.resolveRoots({ sandboxRoot: 'relative', userRoot }, {}), /absolute/)
  assert.throws(() => picker.resolveRoots({ sandboxRoot: workspace, userRoot: undefined }, { roots: ['desktop'] }), /userRoot must be an absolute path/)
  assert.throws(() => picker.resolveRoots({ sandboxRoot: workspace, userRoot, roots: ['photos'] }, {}), /unknown root id/)
})

await test('assertNoTraversal: relative, empty, NUL, parent segment', () => {
  assert.throws(() => picker.assertNoTraversal('relative/path'), error => error.name === 'DirectoryPickerError' && error.code === 'directory-unreadable')
  assert.throws(() => picker.assertNoTraversal(''), /fully qualified/)
  assert.throws(() => picker.assertNoTraversal(`${workspace}\0x`), /NUL/)
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
    error => error.code === 'directory-unreadable' && /root fence|parent traversal/.test(error.message),
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
  assert.deepEqual(truncated.map(crumb => crumb.name), ['workspace', 'sub'])
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
  assert.deepEqual(service.rootsDescriptor().map(root => root.id), ['sandbox', 'desktop', 'documents', 'download'])
})

await test('list(): missing user root is reported unavailable, never rebased', async () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  await assert.rejects(
    () => service.list(join(userRoot, 'Documents')),
    error => error.name === 'DirectoryPickerError' && error.code === 'directory-unreadable' && error.unavailable === true,
  )
})

await test('list(): outside-root path is fenced before any backend call', async () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  const outside = join(userRoot, 'not-a-root')
  mkdirSync(outside, { recursive: true })
  await assert.rejects(() => service.list(outside), /outside the allowed roots/)
})

await test('list(): sandbox root is auto-created, then the backend is unavailable', async () => {
  const freshRoot = join(mkdtempSync(join(tmpdir(), 'dsh-ohos-picker-fresh-')), 'workspace')
  const service = new picker.OhosDirectoryPicker(fakeCtx(), { sandboxRoot: freshRoot, userRoot, roots: [] })
  await assert.rejects(
    () => service.list(),
    error => error.name === 'DirectoryPickerError' && /directory-picker\/unavailable/.test(error.message),
  )
})

await test('createDirectory(): single-segment validation and backend unavailability', async () => {
  const service = new picker.OhosDirectoryPicker(fakeCtx(), config)
  await assert.rejects(() => service.createDirectory(workspace, '..'), error => error.code === 'directory-create-failed')
  await assert.rejects(() => service.createDirectory(workspace, 'a/b'), error => error.code === 'directory-create-failed')
  await assert.rejects(() => service.createDirectory(workspace, ''), error => error.code === 'directory-create-failed')
  await assert.rejects(() => service.createDirectory(workspace, 'new-dir'), /directory-picker\/unavailable/)
})

rmSync(workspace, { recursive: true, force: true })
rmSync(userRoot, { recursive: true, force: true })
if (failures > 0) {
  console.error(`workspace-picker smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('workspace-picker smoke: all checks passed')
}
