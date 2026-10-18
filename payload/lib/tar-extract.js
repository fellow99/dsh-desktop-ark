'use strict';
/**
 * 最小 ustar + gzip 解包器（零依赖）。
 *
 * 为什么自己写：应用域不能 spawn `tar`，且 `resfile` 里只有一个 `.tar.gz`；
 * 依赖任何原生模块都会把问题推给设备。格式严格限制为 ustar/pax-less。
 *
 * 安全属性（TC-102-007）：
 *   - 拒绝绝对路径、`..` 段、非普通文件/目录的条目（符号链接/硬链接直接失败）；
 *   - 目标路径必须落在解包根之内（`path.resolve` 前缀校验）。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BLOCK = 512;

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end >= 0 ? slice.subarray(0, end) : slice).toString('utf8');
}

function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).trim();
  if (text === '') return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function parseHeader(block) {
  const name = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  const size = readOctal(block, 124, 12);
  const type = String.fromCharCode(block[156] || 48);
  const magic = readString(block, 257, 6);
  return { name: prefix === '' ? name : `${prefix}/${name}`, size, type, magic };
}

function assertSafe(entryPath, root) {
  if (entryPath === '' || entryPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entryPath)) {
    throw new Error(`拒绝绝对路径条目：${entryPath}`);
  }
  const segments = entryPath.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`拒绝路径穿越条目：${entryPath}`);
  }
  const target = path.resolve(root, entryPath);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`条目逃逸解包根：${entryPath}`);
  }
  return target;
}

/**
 * 解包 `.tar.gz` 到目标目录。
 * @param {string} archive - 归档绝对路径
 * @param {string} destDir - 解包根（必须不存在或为空）
 * @param {(line: string) => void} log
 * @returns {number} 写出的条目数
 */
function untarGzip(archive, destDir, log) {
  const compressed = fs.readFileSync(archive);
  const buffer = zlib.gunzipSync(compressed);
  fs.mkdirSync(destDir, { recursive: true });

  let offset = 0;
  let files = 0;
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      break;
    }
    const header = parseHeader(block);
    offset += BLOCK;

    if (header.magic !== 'ustar' && header.magic !== 'ustar ') {
      throw new Error(`不是 ustar 归档（magic=${JSON.stringify(header.magic)}）`);
    }
    if (header.type !== '0' && header.type !== '\0' && header.type !== '5') {
      throw new Error(`拒绝条目类型 ${header.type}：${header.name}`);
    }

    const target = assertSafe(header.name, destDir);
    if (header.type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const body = buffer.subarray(offset, offset + header.size);
      if (body.length !== header.size) {
        throw new Error(`归档截断：${header.name}（期望 ${header.size}，实际 ${body.length}）`);
      }
      fs.writeFileSync(target, body);
      files += 1;
    }

    const padded = Math.ceil(header.size / BLOCK) * BLOCK;
    offset += padded;
  }

  log(`tar-extract: ${files} files -> ${destDir}`);
  return files;
}

module.exports = { untarGzip };
