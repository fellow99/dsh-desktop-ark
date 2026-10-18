'use strict';
/**
 * 平台垫片 S2：`fs.symlink` 的 EACCES 回退（递归复制）。
 *
 * 运行期不依赖链接（profile 与插件在载荷里已物化）；该垫片只在
 * 上游试图"修复"或"链接"包目录时兜底，避免 `EACCES` 打断启动。
 *
 * 标记：DSH_OHOS_SHIM fs.symlink
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'DSH_OHOS_SHIM fs.symlink';
const FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

let installed = false;

function copyRecursive(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.copyFileSync(source, target);
}

function install(log) {
  if (installed) return { marker: MARKER, installed: true, changed: false };
  const originalSymlink = fs.promises.symlink;
  const originalSymlinkSync = fs.symlinkSync;

  fs.promises.symlink = async function symlink(target, linkPath, type) {
    try {
      return await originalSymlink.call(fs.promises, target, linkPath, type);
    } catch (error) {
      if (!error || !FALLBACK_CODES.has(error.code)) throw error;
      log(`${MARKER}: symlink fallback -> copy (${linkPath})`);
      copyRecursive(path.resolve(path.dirname(linkPath), target), linkPath);
    }
  };

  fs.symlinkSync = function symlinkSync(target, linkPath, type) {
    try {
      return originalSymlinkSync.call(fs, target, linkPath, type);
    } catch (error) {
      if (!error || !FALLBACK_CODES.has(error.code)) throw error;
      log(`${MARKER}: symlinkSync fallback -> copy (${linkPath})`);
      copyRecursive(path.resolve(path.dirname(linkPath), target), linkPath);
    }
  };

  installed = true;
  log(`${MARKER} installed`);
  return { marker: MARKER, installed: true, changed: true };
}

module.exports = { install, marker: MARKER, isInstalled: () => installed };
