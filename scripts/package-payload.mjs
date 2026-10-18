#!/usr/bin/env node
/**
 * 把 `build/payload-stage/dsh` 打成确定性 `dsh.tar.gz`，并写 `dsh.version`。
 *
 * - 归档内顶层目录固定为 `dsh/`（与运行时 `runRoot` 对齐）；
 * - ustar（非 pax），条目顺序按路径排序 → 同输入同 hash；
 * - 没有 stage 时**跳过**（scaffold 阶段没有真实载荷），保留已有 `dsh.version`。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const STAGE = join(ROOT, 'build/payload-stage/dsh');
const OUT_DIR = join(ROOT, 'entry/src/main/resources/resfile/dsh-payload');
const ARCHIVE = join(OUT_DIR, 'dsh.tar.gz');

if (!existsSync(STAGE)) {
  console.log('[package-payload] 无 build/payload-stage/dsh → 跳过（scaffold 预期状态）');
  process.exit(0);
}

function fail(message) {
  console.error(`[package-payload] ${message}`);
  process.exit(1);
}

/** 固定 builtAt 用（默认取载荷树最新 mtime，保证重跑同输入同首行）。 */
const builtAtArg = (() => {
  const index = process.argv.indexOf('--built-at');
  return index >= 0 ? process.argv[index + 1] : undefined;
})();

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function pad(buffer, size) {
  const out = Buffer.alloc(size);
  buffer.copy(out, 0, 0, Math.min(buffer.length, size));
  return out;
}

function octal(value, size) {
  const text = value.toString(8).padStart(size - 1, '0');
  return Buffer.from(`${text}\0`, 'ascii');
}

/**
 * ustar 只允许 name ≤100 字节；更长的路径必须用 prefix(155) + name(≤100) 拆分。
 * 无法拆分（>255 字节）时**报错退出**，不静默截断（评审 #7）。
 */
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) {
    return { name, prefix: '' };
  }
  for (let i = name.lastIndexOf('/'); i > 0; i = name.lastIndexOf('/', i - 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name: rest, prefix };
    }
  }
  throw new Error(`条目名超过 ustar 上限（255 字节）或无法按 '/' 拆分：${name}`);
}

function header(name, prefix, size, mode, type) {
  const block = Buffer.alloc(512, 0);
  pad(Buffer.from(name, 'utf8'), 100).copy(block, 0);
  pad(Buffer.from(prefix, 'utf8'), 155).copy(block, 345);
  octal(mode, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  block.write('        ', 148, 8, 'ascii');
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

const files = walk(STAGE).map((full) => ({
  full,
  name: `dsh/${relative(STAGE, full).split('\\').join('/')}`,
  size: statSync(full).size,
  mtimeMs: statSync(full).mtimeMs,
}));


// 快速跳过（FR-102-016 的可重跑语义）：归档已存在、首行 sha 与归档哈希一致、且归档比载荷树新
// ⇒ 不重打。`--force` 可强制重打。
const newestMtime = files.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
const versionFile = join(OUT_DIR, 'dsh.version');
if (!process.argv.includes('--force') && existsSync(ARCHIVE) && existsSync(versionFile)) {
  const declared = (readFileSync(versionFile, 'utf8').split('\n')[0].trim().split(/\s+/)[0] || '');
  const archiveStat = statSync(ARCHIVE);
  if (archiveStat.mtimeMs >= newestMtime && /^[0-9a-f]{64}$/.test(declared)) {
    const actual = createHash('sha256').update(readFileSync(ARCHIVE)).digest('hex');
    if (actual === declared) {
      console.log(`[package-payload] 归档已是最新（${files.length} files, sha12=${actual.slice(0, 12)}）→ 跳过；--force 可重打`);
      process.exit(0);
    }
  }
}
const chunks = [];
let bytes = 0;
try {
  for (const file of files) {
    const split = splitName(file.name);
    chunks.push(header(split.name, split.prefix, file.size, 0o644, '0'));
    const body = readFileSync(file.full);
    chunks.push(body);
    const padded = Math.ceil(file.size / 512) * 512;
    if (padded > file.size) {
      chunks.push(Buffer.alloc(padded - file.size, 0));
    }
    bytes += body.byteLength;
  }
} catch (error) {
  fail(`无法编码归档：${error.message}`);
}
chunks.push(Buffer.alloc(1024, 0));

const tar = Buffer.concat(chunks);
const gz = gzipSync(tar, { level: 9 });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(ARCHIVE, gz);

const sha256 = createHash('sha256').update(gz).digest('hex');
// 可复现（FR-102-016）：默认用载荷树的最新 mtime 作为 builtAt，重跑同输入即同首行；
// 需要固定值时用 --built-at <ISO> 覆盖。
// builtAt 用载荷树的最新 mtime（可复现），已在上面算出
const builtAt = builtAtArg ?? new Date(newestMtime || Date.now()).toISOString();
writeFileSync(join(OUT_DIR, 'dsh.version'), `${sha256} ${files.length} ${bytes} ${builtAt}\n`);
console.log(`[package-payload] ${files.length} files, ${bytes} bytes -> ${relative(ROOT, ARCHIVE)} (${gz.byteLength} bytes gz)`);
console.log(`[package-payload] sha256=${sha256} sha12=${sha256.slice(0, 12)}`);
