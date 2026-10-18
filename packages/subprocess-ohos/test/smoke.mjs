/**
 * Smoke test for `@dsh-ohos/subprocess` (pure Node).
 *
 * `@deepseek-ai/cordis` is mapped to `test/cordis-mock.mjs` via
 * `module.registerHooks` because this repository installs no dependencies.
 *
 * Covers: spec validation (graceMs / pre-aborted / argv / cwd), executable
 * allow-list (system root + workspace scripts + relative rejection), cwd
 * containment, environment allow-list + credential scrub, collect-mode reader
 * offset/lossy/spill semantics, and the honest `spawnTerminal` rejection.
 * A live POSIX spawn is exercised when the host is POSIX.
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') {
      return { url: new URL('./cordis-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const subprocess = await import('../lib/index.js')
const { TailCollector } = await import('../lib/output.js')

const root = mkdtempSync(join(tmpdir(), 'dsh-ohos-subprocess-'))
const workspace = join(root, 'workspace')
mkdirSync(workspace)
process.env.DSH_OHOS_WORKSPACE = workspace

const fakeCtx = {
  disposers: [],
  effect(fn) {
    const disposer = fn()
    this.disposers.push(disposer)
    return () => disposer?.()
  },
  logger() {
    return { info() {}, warn() {}, error() {} }
  },
  get() {
    return undefined
  },
  on() {
    return () => {}
  },
  provide() {},
}

const runtime = new subprocess.OhosSubprocessRuntime(fakeCtx)
assert.equal(runtime.name, 'subprocess', 'service is registered as ctx.subprocess')

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

await test('service surface: resolveExecutable / terminalEnvironment / spawnTerminal', async () => {
  assert.equal(typeof runtime.spawn, 'function')
  assert.deepEqual(await runtime.terminalEnvironment(), { platform: 'posix', defaultShell: '/system/bin/sh' })
  await assert.rejects(runtime.spawnTerminal({}), error => error.code === 'not-supported' && error.name === 'SubprocessUnsupportedError')
})

await test('validateSubprocessSpec rejects bad grace, pre-aborted signal, empty argv, relative cwd', () => {
  const base = { argv: ['/system/bin/sh', '-c', 'true'], cwd: workspace, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 3_000 }
  subprocess.validateSubprocessSpec(base)
  assert.throws(() => subprocess.validateSubprocessSpec({ ...base, graceMs: 0 }), /graceMs/)
  assert.throws(() => subprocess.validateSubprocessSpec({ ...base, graceMs: 2_147_483_648 }), /graceMs/)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  assert.throws(() => subprocess.validateSubprocessSpec({ ...base, signal: controller.signal }), /aborted before spawn/)
  assert.throws(() => subprocess.validateSubprocessSpec({ ...base, argv: [] }), /argv/)
  assert.throws(() => subprocess.validateSubprocessSpec({ ...base, argv: [''] }), /argv/)
  assert.throws(() => subprocess.validateSubprocessSpec({ ...base, cwd: 'relative/dir' }), /absolute/)
  assert.throws(() => subprocess.validateSubprocessSpec({ ...base, stdio: { stdin: 'ignore' } }), /stdio/)
})

await test('executable allow-list: workspace script allowed, outside path rejected, relative rejected', () => {
  const script = join(workspace, 'hello.sh')
  writeFileSync(script, '#!/system/bin/sh\necho hello\n')
  assert.equal(subprocess.isAllowedExecutable(script), true)
  assert.equal(subprocess.isAllowedExecutable('/system/bin/sh'), true)
  assert.equal(subprocess.isAllowedExecutable('/system/bin/toybox'), true)
  assert.equal(subprocess.isAllowedExecutable('/data/local/tmp/evil'), false)
  assert.equal(subprocess.resolveProgram(script), subprocess.canonicalPath(script))
  assert.throws(() => subprocess.resolveProgram('./hello.sh'), /relative executable paths are rejected/)
  assert.throws(() => subprocess.resolveProgram('/etc/passwd'), /outside the allowed executable roots/)
  assert.throws(() => subprocess.resolveProgram('definitely-not-a-command'), /not found in the allowed PATH/)
})

await test('cwd must be absolute, exist, and live inside a writable root', () => {
  assert.equal(subprocess.assertCwdAllowed(workspace), subprocess.canonicalPath(workspace))
  assert.throws(() => subprocess.assertCwdAllowed('relative'), /absolute/)
  assert.throws(() => subprocess.assertCwdAllowed(join(root, 'missing')), /does not exist/)
  assert.throws(() => subprocess.assertCwdAllowed('/'), /outside the writable roots/)
})

await test('child environment: allow-list + credential scrub + explicit merge', () => {
  const ambient = {
    PATH: '/system/bin',
    HOME: '/home/u',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    DSH_PROFILE: 'ohos',
    DSH_API_TOKEN: 'super-secret',
    SHOULD_NOT_LEAK: '1',
    AWS_SECRET_ACCESS_KEY: 'nope',
  }
  const env = subprocess.buildChildEnv({ NO_COLOR: '1', DSH_SHELL: '1' }, ambient)
  assert.equal(env.PATH, '/system/bin')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.DSH_PROFILE, 'ohos')
  assert.equal(env.DSH_SHELL, '1')
  assert.equal(env.NO_COLOR, '1')
  assert.equal('SHOULD_NOT_LEAK' in env, false)
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false)
  assert.equal('DSH_API_TOKEN' in env, false, 'DSH_* credentials are scrubbed too')
})

await test('collect reader: non-consuming offsets, lossy flag, spill path', () => {
  const spillDir = join(root, 'spill')
  const collector = new TailCollector(8, 'stdout', { maxBytes: 1024, dir: spillDir })
  collector.push(Buffer.from('hello'))
  const first = collector.readFrom(0)
  assert.equal(first.text, 'hello')
  assert.equal(first.nextOffset, 5)
  assert.equal(first.lossy, false)
  const second = collector.readFrom(0)
  assert.equal(second.text, 'hello', 'reads never consume')
  collector.push(Buffer.from(' world'))
  const latest = collector.readFrom(5)
  assert.equal(latest.text, ' world')
  const stale = collector.readFrom(0)
  assert.equal(stale.lossy, true, 'offset slid out of the tail window')
  assert.equal(stale.text, 'lo world', 'lossy reads return the whole retained tail')
  const spill = collector.readFrom(0).spillPath
  assert.ok(spill, 'complete stream fits under the spill cap')
  assert.equal(readFileSync(spill, 'utf8'), 'hello world')
  collector.finalize()
})

await test('spawn validation is synchronous: bad grace, outside cwd, relative program', () => {
  const spec = {
    argv: [join(workspace, 'hello.sh')],
    cwd: workspace,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3_000,
  }
  assert.throws(() => runtime.spawn({ ...spec, graceMs: -1 }), /graceMs/)
  assert.throws(() => runtime.spawn({ ...spec, cwd: '/nonexistent-dir' }), /does not exist/)
  assert.throws(() => runtime.spawn({ ...spec, argv: ['./hello.sh'] }), /relative executable paths/)
})

await test('live spawn (POSIX only): collect output, exit facts, done shape', async () => {
  if (process.platform === 'win32') {
    console.log('  (skipped: live process spawn requires POSIX; /system/bin/sh is absent on win32)')
    return
  }
  const handle = runtime.spawn({
    argv: ['/system/bin/sh', '-c', 'echo hi'],
    cwd: workspace,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 1_000,
  })
  const outcome = await handle.done
  assert.deepEqual(Object.keys(outcome).sort(), ['exitCode', 'signal'])
  assert.equal(outcome.exitCode, 0)
  assert.equal(handle.collected.stdout.readFrom(0).text, 'hi\n')
})

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`subprocess smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('subprocess smoke: all checks passed')
}
