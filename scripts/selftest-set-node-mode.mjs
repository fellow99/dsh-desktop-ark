#!/usr/bin/env node
/**
 * 109-jitless：`scripts/set-node-mode.mjs` 的脚本级测试（评审 #1/#5 要求的回归门禁）。
 *
 *   node scripts/selftest-set-node-mode.mjs
 *
 * 做四件事：
 *   1) 记录两份源文件的原文（结束时**原样恢复**，无论成功失败）；
 *   2) compat → jit → jit → compat → compat：校验每次的声明数与幂等（第二次 no-op）；
 *   3) 每次都把 module.json5 去掉行注释后 JSON.parse 一遍（防逗号/括号错）；
 *   4) 断言 BuildConfig 常量与声明面始终一致。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(ROOT, 'scripts/set-node-mode.mjs');
const CONFIG = join(ROOT, 'entry/src/main/ets/common/BuildConfig.ets');
const MODULE = join(ROOT, 'entry/src/main/module.json5');
const PERMISSION = 'ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY';

const originalConfig = readFileSync(CONFIG, 'utf-8');
const originalModule = readFileSync(MODULE, 'utf-8');
const failures = [];

function check(ok, message) {
  if (!ok) failures.push(message);
  console.log(`[selftest-set-node-mode] ${ok ? 'ok  ' : 'FAIL'} ${message}`);
}

function declarations(text) {
  return text.split(/\r?\n/).filter((line) => line.includes(PERMISSION) && !line.trim().startsWith('//')).length;
}

function parseModule(text) {
  const stripped = text.split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');
  return JSON.parse(stripped);
}

function run(mode) {
  const out = execFileSync(process.execPath, [SCRIPT, mode], { encoding: 'utf-8' });
  return out;
}

try {
  for (const mode of ['compat', 'jit', 'compat']) {
    run(mode);
    const config = readFileSync(CONFIG, 'utf-8');
    const moduleText = readFileSync(MODULE, 'utf-8');
    const expected = mode === 'jit' ? 2 : 0;
    let parsed = null;
    try {
      parsed = parseModule(moduleText);
    } catch (error) {
      check(false, `${mode}：module.json5 不是合法 JSON5（去注释后 JSON.parse 失败：${error.message}）`);
    }
    check(config.includes(`export const NODE_MODE: string = '${mode}';`), `${mode}：BuildConfig 常量已切换`);
    check(declarations(moduleText) === expected, `${mode}：JIT 声明 ${expected} 处（实际 ${declarations(moduleText)}）`);
    if (parsed !== null) {
      const names = parsed.module.requestPermissions.map((item) => item.name);
      check(names.includes(PERMISSION) === (mode === 'jit'), `${mode}：requestPermissions 与形态一致`);
      check(parsed.module.definePermissions.filter((item) => item.name === PERMISSION).length === (mode === 'jit' ? 1 : 0),
        `${mode}：definePermissions 与形态一致`);
    }
  }

  // 幂等：同形态再跑一次不写文件（用 mtime + 内容双重判断）
  const before = readFileSync(MODULE, 'utf-8');
  const out = run('compat');
  const after = readFileSync(MODULE, 'utf-8');
  check(out.includes('无需改动'), 'compat 重复执行输出「无需改动」');
  check(before === after, 'compat 重复执行文件内容不变');

  // 非法参数：非零退出且文件不变
  let rejected = false;
  try {
    execFileSync(process.execPath, [SCRIPT, 'bogus'], { encoding: 'utf-8', stdio: 'pipe' });
  } catch (error) {
    rejected = error.status === 2;
  }
  check(rejected, '非法参数以退出码 2 拒绝');
  check(readFileSync(MODULE, 'utf-8') === after, '非法参数不修改 module.json5');
} finally {
  writeFileSync(CONFIG, originalConfig, 'utf-8');
  writeFileSync(MODULE, originalModule, 'utf-8');
  console.log('[selftest-set-node-mode] 已恢复原始文件');
}

if (failures.length > 0) {
  console.error(`[selftest-set-node-mode] FAILED：${failures.length} 项`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('[selftest-set-node-mode] PASS');
