import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BUSY_MESSAGE,
  assertPnpmEngine,
  composeArgv,
  probeWorker,
  resolveEngineEntry,
  runPnpmInProcess,
} from '../lib/pnpm-inprocess.js'
import { launchedProfile, reconcileProfileBundles } from '../lib/index.js'

/** A throwaway profile directory with one fake pnpm engine entry. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'market-ohos-'))
  const profile = join(root, 'profiles', 'ohos')
  mkdirSync(profile, { recursive: true })
  const engine = join(root, 'pnpm.cjs')
  writeFileSync(engine, 'console.log("fake pnpm", process.argv.slice(2).join(" "))\n')
  return { root, profile, engine }
}

test('resolveEngineEntry reads DSH_PNPM_ENGINE and tolerates absence', () => {
  assert.equal(resolveEngineEntry({}), null)
  assert.equal(resolveEngineEntry({ DSH_PNPM_ENGINE: '' }), null)
  assert.equal(resolveEngineEntry({ DSH_PNPM_ENGINE: '/x/pnpm.cjs' }), '/x/pnpm.cjs')
})

test('assertPnpmEngine requires an existing non-empty file', () => {
  const { engine } = fixture()
  assert.equal(assertPnpmEngine(engine), true)
  assert.equal(assertPnpmEngine(join(engine, 'missing.cjs')), false)
  assert.equal(assertPnpmEngine(null), false)
})

test('composeArgv appends --dir so the profile is authoritative', () => {
  const argv = composeArgv('/e/pnpm.cjs', ['add', '-w', 'is-number@7.0.0'], '/profile', '/node')
  assert.deepEqual(argv, ['/node', '/e/pnpm.cjs', 'add', '-w', 'is-number@7.0.0', '--dir', '/profile'])
})

test('launchedProfile only accepts an absolute, existing directory', () => {
  const { profile } = fixture()
  assert.deepEqual(launchedProfile({ name: 'ohos', dir: profile }), { name: 'ohos', dir: profile })
  assert.equal(launchedProfile({ name: 'ohos', dir: 'profiles/ohos' }), null)
  assert.equal(launchedProfile({ name: 'ohos', dir: join(profile, 'nope') }), null)
  assert.equal(launchedProfile(undefined), null)
})

test('missing engine fails closed with 127 and a diagnosable message', async () => {
  const { profile } = fixture()
  const handle = runPnpmInProcess(['add', 'x@1.0.0'], {
    dir: profile,
    entry: join(profile, 'absent.cjs'),
  })
  let stderr = ''
  handle.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const outcome = await handle.done
  assert.equal(outcome.exitCode, 127)
  assert.match(stderr, /DSH_PNPM_ENGINE/)
})

test('a missing profile dir is refused before any worker starts', async () => {
  const { engine } = fixture()
  const handle = runPnpmInProcess(['add', 'x@1.0.0'], { dir: '   ', entry: engine })
  const outcome = await handle.done
  assert.equal(outcome.exitCode, 127)
})

test('worker probe reports ok on a worker-capable runtime', async () => {
  const result = await probeWorker()
  assert.equal(result.ok, true)
})

test('one operation at a time: the second call throws the market busy message', async () => {
  const { profile, engine } = fixture()
  const slow = join(profile, 'slow.mjs')
  writeFileSync(slow, 'await new Promise((resolve) => setTimeout(resolve, 600))\n')
  const first = runPnpmInProcess(['add', 'x@1.0.0'], { dir: profile, entry: slow })
  assert.throws(() => runPnpmInProcess(['add', 'y@1.0.0'], { dir: profile, entry: engine }), (error) => {
    assert.equal(error.message, BUSY_MESSAGE)
    return true
  })
  const outcome = await first.done
  assert.equal(outcome.exitCode, 0)
  // The gate is released once the first operation settles.
  const second = runPnpmInProcess(['add', 'y@1.0.0'], { dir: profile, entry: engine })
  assert.equal((await second.done).exitCode, 0)
})

test('cancel terminates the worker and reports a failure', async () => {
  const { profile } = fixture()
  const slow = join(profile, 'slow-cancel.mjs')
  writeFileSync(slow, 'await new Promise((resolve) => setTimeout(resolve, 5000))\n')
  const handle = runPnpmInProcess(['add', 'x@1.0.0'], { dir: profile, entry: slow })
  let stderr = ''
  handle.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  handle.cancel()
  const outcome = await handle.done
  assert.notEqual(outcome.exitCode, 0)
  assert.match(stderr, /cancelled/i)
})

test('reconcileProfileBundles adds installed bundle packages and drops unresolvable rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'market-bundles-'))
  const profile = join(root, 'profiles', 'ohos')
  const install = join(root, 'install', 'node_modules')
  mkdirSync(join(profile, 'node_modules', 'skin-plugin'), { recursive: true })
  mkdirSync(join(profile, 'node_modules', 'plain-plugin'), { recursive: true })
  mkdirSync(join(install, '@deepseek-ai', 'dsh'), { recursive: true })
  mkdirSync(join(install, '@deepseek-ai', 'dsh-base'), { recursive: true })
  writeFileSync(join(install, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  writeFileSync(join(install, '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base' }))
  writeFileSync(join(profile, 'node_modules', 'skin-plugin', 'package.json'), JSON.stringify({ name: 'skin-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(profile, 'node_modules', 'plain-plugin', 'package.json'), JSON.stringify({ name: 'plain-plugin' }))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'p',
    dependencies: { 'skin-plugin': '1.0.0', 'plain-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'gone-package'] } },
  }))
  const anchor = join(install, '@deepseek-ai', 'dsh', 'package.json')
  const first = reconcileProfileBundles(profile, anchor)
  assert.equal(first.changed, true)
  // base bundle resolves from the installation anchor and stays; the removed one is dropped;
  // only the bundle-declaring dependency is appended (a plain package never becomes a layer).
  assert.deepEqual(first.bundles, ['@deepseek-ai/dsh-base', 'skin-plugin'])
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'skin-plugin'])
  // idempotent
  assert.equal(reconcileProfileBundles(profile, anchor).changed, false)
})
