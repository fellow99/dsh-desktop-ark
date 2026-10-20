#!/usr/bin/env node
/**
 * 把 `payload/` 同步到 `entry/src/main/resources/resfile/dsh-payload/`。
 *
 * 关键约束（评审 #4）：
 * - 若 resfile 里已有 `dsh.tar.gz`，必须**原样保留**（连同它的 `dsh.version`），
 *   否则 `bootstrap.js` 的 sha 对账会失败；
 * - 只有在没有归档时，才按脚本文件聚合 hash 生成 `dsh.version`（scaffold 形态）。
 *
 * 单一事实源是 `payload/`；resfile 里的是构建产物（gitignored）。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'payload');
const DEST = join(ROOT, 'entry/src/main/resources/resfile/dsh-payload');
const ARCHIVE = join(DEST, 'dsh.tar.gz');
const VERSION = join(DEST, 'dsh.version');

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push({ full, rel: relative(base, full).split('\\').join('/') });
    }
  }
  return out;
}

if (!existsSync(SRC)) {
  console.error(`[sync-payload] 缺少源目录：${SRC}`);
  process.exit(2);
}

// 1) 先保存已有归档与版本（如果有）
const keptArchive = existsSync(ARCHIVE) ? readFileSync(ARCHIVE) : null;
const keptVersion = existsSync(VERSION) ? readFileSync(VERSION) : null;
// 归档的 mtime 是 package-payload「最新即跳过」判据的一部分：回写内容时必须一并恢复，
// 否则这次 writeFileSync 会把 mtime 刷新成 now，让后续重打判断永远为「已是最新」（实测踩到：
// 载荷里换了 flock 垫片，但归档仍是旧的）。
const keptArchiveStat = keptArchive !== null ? statSync(ARCHIVE) : null;

// 2) 同步脚本
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

// 3) 恢复归档（连同版本），保证 sha 对账口径一致
if (keptArchive !== null) {
  writeFileSync(ARCHIVE, keptArchive);
  if (keptArchiveStat !== null) {
    utimesSync(ARCHIVE, keptArchiveStat.atime, keptArchiveStat.mtime);
  }
  if (keptVersion !== null) {
    writeFileSync(VERSION, keptVersion);
  }
  const files = walk(DEST).filter((f) => f.rel !== 'dsh.tar.gz' && f.rel !== 'dsh.version');
  console.log(`[sync-payload] ${files.length} files -> ${relative(ROOT, DEST)}`);
  console.log('[sync-payload] 保留既有 dsh.tar.gz 与 dsh.version（归档 sha 口径不变）');
  process.exit(0);
}

// 4) 无归档：按脚本文件聚合 hash 生成 version（scaffold 形态）
const files = walk(DEST).filter((f) => f.rel !== 'dsh.version');
const hash = createHash('sha256');
let bytes = 0;
for (const file of files) {
  const body = readFileSync(file.full);
  bytes += body.byteLength;
  hash.update(file.rel);
  hash.update('\0');
  hash.update(body);
  hash.update('\0');
}
const sha256 = hash.digest('hex');
writeFileSync(VERSION, `${sha256} ${files.length} ${bytes} ${new Date().toISOString()}\n`);

console.log(`[sync-payload] ${files.length} files, ${bytes} bytes -> ${relative(ROOT, DEST)}`);
console.log(`[sync-payload] sha256=${sha256} sha12=${sha256.slice(0, 12)}（无归档：脚本聚合口径）`);
