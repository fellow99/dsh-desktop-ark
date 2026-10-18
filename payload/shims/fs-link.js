'use strict';
/**
 * 平台垫片 S1：`fs.link` 的 EACCES/EPERM/ENOTSUP/EXDEV 回退。
 *
 * 上游 `session-persistence-jsonl` 用 `link()` 原子发布会话产物（`EEXIST` 语义），
 * 鸿蒙沙箱拒绝硬链接。回退为同目录 `rename`：调用方已在暂存前拒绝已存在的目标，
 * 且本应用是单进程，进程内写声明已排除竞争写者。
 *
 * 标记：DSH_OHOS_SHIM fs.link（`selfcheck` 与 `/_ohos/facts` 依赖它）
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'DSH_OHOS_SHIM fs.link';
const FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

let installed = false;

function canFallback(error) {
  return error !== null && typeof error === 'object' && FALLBACK_CODES.has(error.code);
}

function renameSyncFallback(existingPath, newPath) {
  try {
    fs.renameSync(existingPath, newPath);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw error;
    }
    throw error;
  }
}

function install(log) {
  if (installed) return { marker: MARKER, installed: true, changed: false };
  const originalLink = fs.promises.link;
  const originalLinkSync = fs.linkSync;

  fs.promises.link = async function link(existingPath, newPath) {
    try {
      return await originalLink.call(fs.promises, existingPath, newPath);
    } catch (error) {
      if (!canFallback(error)) throw error;
      log(`${MARKER}: link fallback -> rename (${existingPath} -> ${path.basename(newPath)})`);
      return renameSyncFallback(existingPath, newPath);
    }
  };

  fs.linkSync = function linkSync(existingPath, newPath) {
    try {
      return originalLinkSync.call(fs, existingPath, newPath);
    } catch (error) {
      if (!canFallback(error)) throw error;
      log(`${MARKER}: linkSync fallback -> rename (${existingPath} -> ${path.basename(newPath)})`);
      return renameSyncFallback(existingPath, newPath);
    }
  };

  installed = true;
  log(`${MARKER} installed`);
  return { marker: MARKER, installed: true, changed: true };
}

module.exports = { install, marker: MARKER, isInstalled: () => installed };
