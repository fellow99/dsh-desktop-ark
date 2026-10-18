/**
 * Smoke test for `@dsh-ohos/sandbox` (pure Node).
 *
 * `@deepseek-ai/cordis` is mapped to `test/cordis-mock.mjs` via
 * `module.registerHooks`. Covers: policy validation, derived writable roots
 * (mode + user dirs), the write check, the honest `confine()` result, and the
 * fail-closed `confineStrict()`.
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') {
      return { url: new URL('./cordis-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const sandbox = await import('../lib/index.js')

const workspace = mkdtempSync(join(tmpdir(), 'dsh-ohos-sandbox-'))
const userRoot = mkdtempSync(join(tmpdir(), 'dsh-ohos-user-'))
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

await test('validatePolicy: closed vocabulary + absolute root', () => {
  assert.deepEqual(sandbox.validatePolicy({ mode: 'workspace-write', workspaceRoot: workspace }), { mode: 'workspace-write', workspaceRoot: workspace })
  assert.throws(() => sandbox.validatePolicy({ mode: 'nope', workspaceRoot: workspace }), /unknown mode/)
  assert.throws(() => sandbox.validatePolicy({ mode: 'workspace-write', workspaceRoot: 'relative' }), /absolute/)
  assert.throws(() => sandbox.validatePolicy(null), /policy/)
})

await test('writableRoots: read-only is empty, workspace-write derives workspace + temp + user dirs', () => {
  assert.deepEqual(sandbox.writableRoots({ mode: 'read-only', workspaceRoot: workspace }), [])
  assert.deepEqual(sandbox.writableRoots({ mode: 'danger-full-access', workspaceRoot: workspace }), [])
  const roots = sandbox.writableRoots({ mode: 'workspace-write', workspaceRoot: workspace }, { userRoot })
  assert.ok(roots.some(root => root === sandbox.canonicalPath(workspace)), 'workspace root present')
  assert.ok(roots.includes(sandbox.canonicalPath(join(userRoot, 'Desktop'))))
  assert.ok(roots.includes(sandbox.canonicalPath(join(userRoot, 'Documents'))))
  assert.ok(roots.includes(sandbox.canonicalPath(join(userRoot, 'Download'))))
  assert.equal(new Set(roots).size, roots.length, 'deduplicated')
})

await test('isPathWritable: mode semantics and containment', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: workspace }
  assert.equal(sandbox.isPathWritable(join(workspace, 'a.txt'), policy), true)
  assert.equal(sandbox.isPathWritable(join(homedir(), 'dsh-ohos-outside-root'), policy), false, 'outside the derived roots')
  assert.equal(sandbox.isPathWritable(join(workspace, 'a.txt'), { mode: 'read-only', workspaceRoot: workspace }), false)
  assert.equal(sandbox.isPathWritable('/anything', { mode: 'danger-full-access', workspaceRoot: workspace }), true)
})

await test('confine(): argv unchanged, honest non-enforcement facts', async () => {
  const ctx = { effect() {}, logger() { return { info() {}, warn() {}, error() {} } }, provide() {}, get() { return undefined } }
  const provider = new sandbox.OhosSandboxProvider(ctx)
  assert.equal(provider.name, 'sandbox')
  const policy = { mode: 'workspace-write', workspaceRoot: workspace }
  const confined = await provider.confine(['/system/bin/sh', '-c', 'echo hi'], policy)
  assert.deepEqual(confined.argv, ['/system/bin/sh', '-c', 'echo hi'])
  assert.equal(confined.enforcement, 'partial')
  assert.equal(confined.isolation, 'none')
  assert.equal(confined.enforced, false)
  assert.deepEqual(confined.denialSignatures, [])
  assert.deepEqual(confined.runnerFailureRules, [])
  assert.equal(confined.mode, 'workspace-write')
  assert.equal(confined.workspaceRoot, sandbox.canonicalPath(workspace))
  assert.equal(provider.capabilities().sandbox, 'none')
  assert.equal(provider.capabilities().kernelIsolation, false)
  assert.equal(provider.isPathWritable(join(workspace, 'x'), policy), true)
  await assert.rejects(() => provider.confine([], policy), /non-empty argv/)
})

await test('confineStrict(): fail-closed for every confining mode', async () => {
  const ctx = { effect() {}, logger() { return { info() {}, warn() {}, error() {} } }, provide() {}, get() { return undefined } }
  const provider = new sandbox.OhosSandboxProvider(ctx)
  await assert.rejects(
    () => provider.confineStrict(['/system/bin/sh'], { mode: 'read-only', workspaceRoot: workspace }),
    error => error.code === sandbox.SANDBOX_UNAVAILABLE && error.mode === 'read-only',
  )
  const unbounded = await provider.confineStrict(['/system/bin/sh'], { mode: 'danger-full-access', workspaceRoot: workspace })
  assert.deepEqual(unbounded.argv, ['/system/bin/sh'])
})

rmSync(workspace, { recursive: true, force: true })
rmSync(userRoot, { recursive: true, force: true })
if (failures > 0) {
  console.error(`sandbox smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('sandbox smoke: all checks passed')
}
