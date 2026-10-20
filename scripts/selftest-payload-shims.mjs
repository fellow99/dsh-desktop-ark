#!/usr/bin/env node
/**
 * S3 垫片回归测试（评审遗留：上一版只查包清单，报了假阳性，首轮对话才炸）。
 *
 *   node scripts/selftest-payload-shims.mjs
 *
 * 覆盖：
 *   1) 上游 flock 被替换为单进程替身（文件带标记、可 import、tryLockExclusive 立即 resolve）；
 *   2) 幂等：第二次不重复写、上游备份只留一份；
 *   3) 缺 `node-addon-system/lib/flock.js` 时**抛错**（不静默通过）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyFlockShim, applySharpShim, applyAttachmentDurabilityPatch, FLOCK_STUB_MARKER } from './lib/payload-shims.mjs';

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
  }
}

function makeStage(upstreamBody = 'throw new Error("flock is not supported on openharmony-arm64");\n') {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-ohos-shim-'));
  const dir = join(stage, 'node_modules/@deepseek-ai/node-addon-system');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/node-addon-system', version: '0.1.2' }));
  writeFileSync(join(dir, 'lib/flock.js'), upstreamBody);
  return { stage, dir };
}

await test('替换：文件带标记、可 import、tryLockExclusive 立即成功', async () => {
  const { stage, dir } = makeStage();
  try {
    const out = [];
    const dest = applyFlockShim(stage, (line) => out.push(line));
    assert.equal(dest, join(dir, 'lib/flock.js'));
    const body = readFileSync(dest, 'utf8');
    assert.ok(body.includes(FLOCK_STUB_MARKER), 'replacement marker present');
    assert.ok(existsSync(join(dir, 'lib/flock.upstream.js')), 'upstream backup created');
    const mod = await import(`file://${dest.replace(/\\/g, '/')}`);
    await mod.tryLockExclusive(1);
    assert.equal(typeof mod.default.tryLockExclusive, 'function');
    assert.ok(out.some((line) => line.includes('单进程替身')), 'logs the replacement');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

await test('幂等：第二次不再改写，上游备份保留一份', async () => {
  const { stage, dir } = makeStage();
  try {
    applyFlockShim(stage, () => {});
    const first = readFileSync(join(dir, 'lib/flock.js'), 'utf8');
    const backupFirst = readFileSync(join(dir, 'lib/flock.upstream.js'), 'utf8');
    const out = [];
    applyFlockShim(stage, (line) => out.push(line));
    assert.equal(readFileSync(join(dir, 'lib/flock.js'), 'utf8'), first);
    assert.equal(readFileSync(join(dir, 'lib/flock.upstream.js'), 'utf8'), backupFirst);
    assert.ok(out.some((line) => line.includes('幂等')), 'logs idempotency');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

await test('缺文件：抛错而不是静默通过', async () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-ohos-shim-missing-'));
  try {
    assert.throws(() => applyFlockShim(stage, () => {}), /flock\.js/);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

await test('S4：sharp 同名包被替换为可调用的纯 JS 工厂', async () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-ohos-sharp-'))
  try {
    const ohos = join(stage, 'node_modules/@dsh-ohos/attachment-image')
    mkdirSync(ohos, { recursive: true })
    writeFileSync(join(ohos, 'package.json'), JSON.stringify({ name: '@dsh-ohos/attachment-image', type: 'module', main: 'index.js' }))
    writeFileSync(join(ohos, 'index.js'), [
      'export default function sharp(){ return { ok: true } }',
      'export const marker = "S4";',
      '',
    ].join(String.fromCharCode(10)))
    const upstream = join(stage, 'node_modules/sharp')
    mkdirSync(upstream, { recursive: true })
    writeFileSync(join(upstream, 'package.json'), JSON.stringify({ name: 'sharp', version: '9.9.9' }))
    writeFileSync(join(upstream, 'index.js'), 'throw new Error("upstream sharp")')

    const dest = applySharpShim(stage, () => {})
    const manifest = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    assert.equal(manifest.dshOhosShim, 'S4')
    assert.equal(manifest.upstreamVersion, '9.9.9')
    assert.ok(existsSync(join(stage, 'node_modules/sharp.upstream/package.json')), 'upstream backup kept')
    const mod = await import(`file://${join(dest, 'index.cjs').split(String.fromCharCode(92)).join('/')}`)
    assert.equal(typeof mod.default, 'function')
    assert.deepEqual(mod.default(), { ok: true })
    const again = applySharpShim(stage, () => {})
    assert.equal(again, dest, 'idempotent')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})

await test('S5：附件目录 fsync 在 OHOS 沙箱边界降级为 best-effort（幂等）', async () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-ohos-s5-'))
  try {
    const dir = join(stage, 'node_modules/@deepseek-ai/dsh-attachment-local/lib')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'index.js')
    writeFileSync(file, 'async function f(parent){ await syncDirectory(parent); }' + String.fromCharCode(10))
    applyAttachmentDurabilityPatch(stage, () => {})
    const body = readFileSync(file, 'utf8')
    assert.ok(body.includes('DSH_OHOS_SYNC_DIR_BEST_EFFORT'))
    assert.ok(body.includes('syncDirectoryBestEffort(parent)'))
    assert.ok(body.includes('EACCES'))
    applyAttachmentDurabilityPatch(stage, () => {})
    assert.equal(readFileSync(file, 'utf8'), body, 'idempotent')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.error(`selftest-payload-shims: ${failures} failure(s)`);
  process.exit(1);
}
console.log('selftest-payload-shims: all checks passed');
