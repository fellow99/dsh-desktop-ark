/**
 * Smoke test for `@dsh-ohos/shell` (pure Node).
 *
 * `@deepseek-ai/cordis` is mapped to `test/cordis-mock.mjs` via
 * `module.registerHooks` (no dependencies are installed in this repository).
 * `ctx.subprocess` is a fake in-process shell built from `node:stream`
 * PassThroughs, so the sentinel protocol, result classification, serialization,
 * and output readers are exercised without a device.
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') {
      return { url: new URL('./cordis-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const shell = await import('../lib/index.js')
const framing = await import('../lib/framing.js')

const workspace = mkdtempSync(join(tmpdir(), 'dsh-ohos-shell-'))
process.env.DSH_OHOS_WORKSPACE = workspace

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

/** Fake `ctx.subprocess` whose "shell" answers each framed script. */
function fakeSubprocess(behavior) {
  const spawned = []
  const scripts = []
  return {
    spawned,
    scripts,
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const handle = {
        stdin,
        stdout,
        stderr,
        control: undefined,
        collected: {},
        done: new Promise(() => {}),
        terminate() {
          handle.terminated = true
          stdout.end()
          stderr.end()
        },
        waitForExit: async () => true,
      }
      spawned.push(handle)
      stdin.on('data', chunk => {
        const text = chunk.toString('utf8')
        scripts.push(text)
        const match = /__DSH_BEGIN_([0-9a-f]+)__/.exec(text)
        if (match === null) return
        const nonce = match[1]
        const reply = behavior(text, nonce)
        if (reply === undefined) return
        stdout.write(`__DSH_BEGIN_${nonce}__\n`)
        if (reply.stdout !== undefined) stdout.write(reply.stdout)
        if (reply.stderr !== undefined) stderr.write(reply.stderr)
        stdout.write(`\n__DSH_END_${nonce}__ ${reply.exitCode ?? 0}\n`)
      })
      return handle
    },
  }
}

function executorWith(behavior, config = { timeoutMs: 5_000 }) {
  const subprocess = fakeSubprocess(behavior)
  const ctx = { subprocess, effect() {}, logger() { return { info() {}, warn() {}, error() {} } }, provide() {}, get() { return undefined } }
  return { executor: new shell.OhosShellExecutor(ctx, config), subprocess }
}

await test('buildScript: sentinel frame, quoted workdir, subshell (no cd leak)', () => {
  const script = framing.buildScript({ nonce: 'a'.repeat(24), workdir: "/tmp/it's here", command: 'echo hi' })
  assert.match(script, /printf '%s\\n' '__DSH_BEGIN_aaaa/)
  assert.match(script, /^\($/m)
  assert.match(script, /cd -- '\/tmp\/it'\\''s here' \|\| exit 125/)
  assert.match(script, /echo hi/)
  assert.match(script, /printf '\\n%s %s\\n' '__DSH_END_aaaa/)
  assert.throws(() => framing.buildScript({ nonce: 'XYZ', workdir: '/tmp', command: 'x' }), /nonce/)
})

await test('FrameParser: single chunk, every split point, exit code, marker collision', () => {
  const nonce = 'b'.repeat(24)
  const frame = `__DSH_BEGIN_${nonce}__\nline1\nline2\n\n__DSH_END_${nonce}__ 7\n`
  const expected = 'line1\nline2\n'

  const whole = new framing.FrameParser(nonce)
  const one = whole.push(frame)
  assert.equal(one.body, expected)
  assert.equal(one.completed, true)
  assert.equal(one.exitCode, 7)

  for (let split = 0; split <= frame.length; split += 1) {
    const parser = new framing.FrameParser(nonce)
    let body = ''
    let done
    for (const part of [frame.slice(0, split), frame.slice(split)]) {
      const parsed = parser.push(part)
      body += parsed.body
      if (parsed.completed) done = parsed
    }
    assert.equal(body, expected, `split at ${split}`)
    assert.equal(done?.exitCode, 7, `split at ${split}`)
  }

  const collision = new framing.FrameParser(nonce)
  const parsed = collision.push(`noise __DSH_BEGIN_deadbeefdeadbeef__\n__DSH_BEGIN_${nonce}__\nok\n\n__DSH_END_${nonce}__ 0\n`)
  assert.equal(parsed.body, 'ok\n')
  assert.equal(parsed.exitCode, 0)
})

await test('normalizeConfig: defaults and validation', () => {
  assert.deepEqual(shell.normalizeConfig(), { timeoutMs: 120_000, shellPath: '/system/bin/sh' })
  assert.deepEqual(shell.normalizeConfig({ timeoutMs: 1_000, shellPath: '/system/bin/toybox' }), { timeoutMs: 1_000, shellPath: '/system/bin/toybox' })
  assert.throws(() => shell.normalizeConfig({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => shell.normalizeConfig({ shellPath: 'sh' }), /absolute/)
})

await test('resolve(): clamps timeout, defaults workdir from env, refuses without workspace', () => {
  const { executor } = executorWith(() => undefined)
  const spec = executor.resolve({ command: 'echo hi' })
  assert.equal(spec.workdir, workspace)
  assert.equal(spec.timeoutMs, 5_000)
  assert.equal(spec.onExpiry, 'kill')
  assert.equal(spec.stdoutMaxBytes, 64_000)
  const clamped = executor.resolve({ command: 'echo hi', timeoutMs: 10_000_000 })
  assert.equal(clamped.timeoutMs, 600_000)
  assert.throws(() => executor.resolve({ command: 'x', workdir: 'relative' }), /workdir/)
  const saved = process.env.DSH_OHOS_WORKSPACE
  delete process.env.DSH_OHOS_WORKSPACE
  try {
    assert.throws(() => executor.resolve({ command: 'x' }), /workdir is required/)
  } finally {
    process.env.DSH_OHOS_WORKSPACE = saved
  }
})

await test('execute(): success, output readers, done never rejects', async () => {
  const { executor, subprocess } = executorWith((text, nonce) => ({ stdout: 'hello\n', stderr: 'warn\n', exitCode: 0 }))
  const proc = await executor.execute(executor.resolve({ command: 'echo hello' }))
  const result = await proc.result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
  assert.equal(result.stdout.text, 'hello\n')
  assert.equal(result.stderr.text, 'warn\n')
  assert.equal(result.timeoutMs, 5_000)
  await proc.done
  assert.equal(subprocess.scripts.length, 1)
  assert.match(subprocess.scripts[0], /cd -- /)
})

await test('execute(): non-zero exit resolves (no reject) and the next call reuses the shell with a fresh cd', async () => {
  let call = 0
  const { executor, subprocess } = executorWith((_text, nonce) => {
    call += 1
    return call === 1 ? { stdout: 'first\n', exitCode: 3 } : { stdout: 'second\n', exitCode: 0 }
  })
  const first = await executor.execute(executor.resolve({ command: 'false' }))
  const firstResult = await first.result()
  assert.equal(firstResult.exitCode, 3)
  const second = await executor.execute(executor.resolve({ command: 'echo second' }))
  const secondResult = await second.result()
  assert.equal(secondResult.exitCode, 0)
  assert.equal(secondResult.stdout.text, 'second\n')
  assert.equal(subprocess.spawned.length, 1, 'one persistent shell is reused')
  assert.equal(subprocess.scripts.length, 2)
  assert.match(subprocess.scripts[1], /cd -- /)
})

await test('execute(): timeout kills the shell and reports timedOut only', async () => {
  const { executor, subprocess } = executorWith(() => undefined, { timeoutMs: 40 })
  const proc = await executor.execute(executor.resolve({ command: 'sleep 999' }))
  const result = await proc.result()
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.equal(proc.status, 'killed')
  assert.equal(subprocess.spawned[0].terminated, true)
})

await test('execute(): abort reports aborted only', async () => {
  const { executor } = executorWith(() => undefined, { timeoutMs: 5_000 })
  const controller = new AbortController()
  const proc = await executor.execute(executor.resolve({ command: 'sleep 999', signal: controller.signal }))
  setTimeout(() => controller.abort(), 20)
  const result = await proc.result()
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
})

await test('execute(): readOutput is consuming, observed readers are not', async () => {
  const { executor } = executorWith(() => ({ stdout: 'abcdef\n', exitCode: 0 }))
  const proc = await executor.execute(executor.resolve({ command: 'echo abcdef' }))
  await proc.result()
  const first = proc.readOutput()
  const second = proc.readOutput()
  assert.equal(first.delta, 'abcdef\n')
  assert.equal(second.delta, '')
  assert.equal(proc.observed.stdout.readFrom(0).text, 'abcdef\n')
  assert.equal(proc.observed.stdout.readFrom(0).text, 'abcdef\n')
})

await test('execute(): kill() is idempotent and settles without a timeout flag', async () => {
  const { executor, subprocess } = executorWith(() => undefined)
  const proc = await executor.execute(executor.resolve({ command: 'sleep 999' }))
  assert.equal(proc.kill(), true)
  assert.equal(proc.kill(), false)
  const result = await proc.result()
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(subprocess.spawned[0].terminated, true)
})

rmSync(workspace, { recursive: true, force: true })
if (failures > 0) {
  console.error(`shell smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('shell smoke: all checks passed')
}
