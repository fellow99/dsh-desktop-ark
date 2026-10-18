#!/usr/bin/env node
/**
 * 装配载荷（dry-run 默认）。
 *
 * 真正的上游构建/物化（pnpm deploy + 裁剪）属于模块 102 的后续阶段；
 * 本脚本当前只保证"输入清楚、不静默成功"：
 *   - `--from <dir>`：把一个已构建的 dsh 运行树复制到 `build/payload-stage/dsh`；
 *   - 无 `--from`：打印期望输入与下一步命令，退出码 0（dry run）。
 *   - `--apply` 且无 `--from` 且无 stage：退出码 2（拒绝假装装配成功）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STAGE = join(ROOT, 'build/payload-stage/dsh');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fromIndex = args.indexOf('--from');
const from = fromIndex >= 0 ? args[fromIndex + 1] : undefined;

function countFiles(dir, depth = 0) {
  if (depth > 2) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name), depth + 1);
    else total += 1;
  }
  return total;
}

if (from !== undefined) {
  if (!existsSync(join(from, 'node_modules/@deepseek-ai/dsh/package.json'))) {
    console.error(`[assemble-payload] --from 目录不像 dsh 运行树（缺 node_modules/@deepseek-ai/dsh/package.json）：${from}`);
    process.exit(2);
  }
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  cpSync(from, STAGE, { recursive: true });
  console.log(`[assemble-payload] copied ${countFiles(STAGE)} entries -> ${STAGE}`);
  process.exit(0);
}

if (!apply) {
  console.log('[assemble-payload] dry run（未写盘）');
  console.log('  期望输入：一个已构建并物化的 dsh 运行树（含 node_modules/@deepseek-ai/dsh）');
  console.log('  下一步：');
  console.log('    node scripts/build-upstream.mjs                 # 构建上游（tag 校验 + pnpm build）');
  console.log('    node scripts/assemble-payload.mjs --apply --from <staged-dsh-tree>');
  console.log('    node scripts/package-payload.mjs               # 确定性 tar.gz + dsh.version');
  process.exit(0);
}

if (existsSync(STAGE)) {
  console.log(`[assemble-payload] 已存在 stage：${STAGE}（${countFiles(STAGE)} entries）`);
  process.exit(0);
}

console.error('[assemble-payload] --apply 缺少 --from，且没有现成 stage：拒绝假装装配成功。');
process.exit(2);
