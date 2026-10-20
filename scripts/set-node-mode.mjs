#!/usr/bin/env node
/**
 * 109-jitless：切换 Node 运行形态（**编译期**开关）。
 *
 *   node scripts/set-node-mode.mjs compat     # 默认：不声明 JIT ACL + --jitless + 载荷兼容层
 *   node scripts/set-node-mode.mjs jit        # 有 ACL：成对声明 JIT 权限 + 不带 --jitless
 *
 * 同时维护两处，保证「常量 ↔ 声明面」不会错配：
 *   1) `entry/src/main/ets/common/BuildConfig.ets` 的 `NODE_MODE`
 *   2) `entry/src/main/module.json5` 的两段标记块（request / define）
 *
 * 纪律（评审 #1 之后重写）：
 *   · **先算后写**：两份新文本全部在内存里算完并校验通过，才落盘 —— 任一步失败即零写入，
 *     不会留下「常量=jit 但声明面=compat」这种**无 ACL 却按 JIT 启动**的必崩组合；
 *   · 幂等：已是目标形态时不写文件；
 *   · 形状容忍：标记块里已有该权限（任何写法）就视为已声明，不重复插入；
 *   · 保留原文件行尾风格（CRLF/LF）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD_CONFIG = join(ROOT, 'entry/src/main/ets/common/BuildConfig.ets');
const MODULE_JSON = join(ROOT, 'entry/src/main/module.json5');

const MODES = ['jit', 'compat'];
const PERMISSION = 'ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY';
const CONSTANT_PATTERN = /export const NODE_MODE: string = '(jit|compat)';/;

const BLOCKS = [
  { name: 'requestPermissions', begin: '// [109-jitless:jit:request:begin]', end: '// [109-jitless:jit:request:end]' },
  { name: 'definePermissions', begin: '// [109-jitless:jit:define:begin]', end: '// [109-jitless:jit:define:end]' },
];

class SwitchError extends Error {}

function fail(message) {
  throw new SwitchError(message);
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function isCommentOrBlank(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('//');
}

function previousCodeIndex(lines, beginIndex) {
  for (let i = beginIndex - 1; i >= 0; i -= 1) {
    if (!isCommentOrBlank(lines[i])) return i;
  }
  return -1;
}

function nextCodeIndex(lines, endIndex) {
  for (let i = endIndex + 1; i < lines.length; i += 1) {
    if (!isCommentOrBlank(lines[i])) return i;
  }
  return -1;
}

function isPermissionLine(line) {
  return line.includes(PERMISSION) && !line.trim().startsWith('//');
}

/** 在内存里调整一段标记块；返回新行数组与是否变化。 */
function applyBlock(lines, block, mode) {
  const begin = lines.findIndex((line) => line.trim() === block.begin);
  const end = lines.findIndex((line) => line.trim() === block.end);
  if (begin < 0 || end < 0) fail(`module.json5 缺少标记：${block.begin} / ${block.end}`);
  if (end < begin) fail(`module.json5 标记顺序错乱：${block.name}`);

  const inside = lines.slice(begin + 1, end);
  const declared = inside.some((line) => isPermissionLine(line));

  if (mode === 'compat') {
    if (!declared) return { lines, changed: false };
    const before = previousCodeIndex(lines, begin);
    const after = nextCodeIndex(lines, end);
    if (before >= 0 && after >= 0) {
      const closesContainer = /^[\]}]/.test(lines[after].trim());
      if (closesContainer && lines[before].trimEnd().endsWith(',')) {
        lines[before] = lines[before].trimEnd().replace(/,$/, '');
      }
    }
    const kept = inside.filter((line) => !isPermissionLine(line));
    return { lines: [...lines.slice(0, begin + 1), ...kept, ...lines.slice(end)], changed: true };
  }

  if (declared) return { lines, changed: false };

  const indent = (lines[begin].match(/^\s*/) || [''])[0];
  const entryLine = `${indent}{ "name": "${PERMISSION}" }`;
  const before = previousCodeIndex(lines, begin);
  if (before < 0) fail(`module.json5 结构异常：${block.name} 之前没有可锚定的行`);
  const prev = lines[before].trimEnd();
  if (!prev.endsWith(',') && !prev.endsWith('[') && !prev.endsWith('{')) {
    lines[before] = `${prev},`;
  }
  return { lines: [...lines.slice(0, begin + 1), entryLine, ...lines.slice(end)], changed: true };
}

function planBuildConfig(text, mode) {
  if (!CONSTANT_PATTERN.test(text)) {
    fail(`BuildConfig.ets 缺少锚点：export const NODE_MODE: string = '...';`);
  }
  const next = text.replace(CONSTANT_PATTERN, `export const NODE_MODE: string = '${mode}';`);
  return { text: next, changed: next !== text };
}

function planModuleJson(text, mode) {
  const eol = eolOf(text);
  let lines = text.split(/\r?\n/);
  let changed = false;
  for (const block of BLOCKS) {
    const result = applyBlock(lines, block, mode);
    lines = result.lines;
    changed = changed || result.changed;
  }
  return { text: changed ? lines.join(eol) : text, changed };
}

/** 校验**内存中的**两份文本（写盘前调用）。 */
function verifyPlanned(configText, moduleText, mode) {
  const constantOk = configText.includes(`export const NODE_MODE: string = '${mode}';`);
  const declared = moduleText.split(/\r?\n/).filter((line) => isPermissionLine(line)).length;
  const expected = mode === 'jit' ? 2 : 0;
  if (!constantOk || declared !== expected) {
    fail(`校验失败（未写入任何文件）：constant=${String(constantOk)} jitDeclarations=${declared}（期望 ${expected}）`);
  }
}

function run() {
  const mode = (process.argv[2] || '').trim();
  if (!MODES.includes(mode)) {
    fail(`用法：node scripts/set-node-mode.mjs <${MODES.join('|')}>（收到 "${mode}"）`);
  }

  const configText = readFileSync(BUILD_CONFIG, 'utf-8');
  const moduleText = readFileSync(MODULE_JSON, 'utf-8');

  // 全部在内存里算 + 校验；任一失败抛错 ⇒ 下面一行都不会执行。
  const configPlan = planBuildConfig(configText, mode);
  const modulePlan = planModuleJson(moduleText, mode);
  verifyPlanned(configPlan.text, modulePlan.text, mode);

  if (configPlan.changed) writeFileSync(BUILD_CONFIG, configPlan.text, 'utf-8');
  if (modulePlan.changed) writeFileSync(MODULE_JSON, modulePlan.text, 'utf-8');

  console.log(`[set-node-mode] 目标形态：${mode}`);
  console.log(`[set-node-mode] BuildConfig.ets：${configPlan.changed ? '已更新' : '无需改动'}`);
  console.log(`[set-node-mode] module.json5：${modulePlan.changed ? '已更新' : '无需改动'}（JIT 声明 ${mode === 'jit' ? '2 处' : '0 处'}）`);
  console.log('[set-node-mode] 下一步：bash scripts/build-hap.sh --node-mode ' + mode);
}

try {
  run();
} catch (error) {
  if (error instanceof SwitchError) {
    console.error(`[set-node-mode] ${error.message}`);
    process.exit(2);
  }
  throw error;
}
