'use strict';
/**
 * 平台垫片 S3：`flock` 的**单进程替身**探针。
 *
 * 上游 `dsh-session-persistence-jsonl` 在第一次写入会话时，通过
 * `@deepseek-ai/node-addon-system/flock` 取内核排他锁；该包只在 linux/darwin 有原生
 * binding，OHOS 上会抛 `flock is not supported on openharmony-arm64`（实测：首轮对话直接失败）。
 *
 * 物化期（`scripts/lib/payload-shims.mjs`）已把 `node-addon-system/lib/flock.js` 换成
 * `payload/shims/node-addon-system-flock.js`（单进程立即成功，与上游 webworker 运行时同语义）。
 *
 * 本文件只做**审计**，不 patch 模块解析：
 *   1) 包与 `lib/flock.js` 是否存在；
 *   2) 该文件是否真的带替换标记 —— **不能只看包清单存在**：上一版正是这样报了假阳性
 *      （日志写 `installed`，实际仍是原生实现，首轮对话才炸）。
 *
 * 标记：DSH_OHOS_SHIM flock
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'DSH_OHOS_SHIM flock';
const STUB_PACKAGE = path.join('@deepseek-ai', 'node-addon-system');
const STUB_FILE = path.join(STUB_PACKAGE, 'lib', 'flock.js');
const STUB_MARKER = 'DSH_OHOS_FLOCK_STUB';

/**
 * @param {string} runRoot - 运行根（含 `node_modules`）
 * @param {(line: string) => void} log
 */
function install(runRoot, log) {
  const manifest = path.join(runRoot, 'node_modules', STUB_PACKAGE, 'package.json');
  const file = path.join(runRoot, 'node_modules', STUB_FILE);
  const present = fs.existsSync(manifest);
  let replaced = false;
  let detail = '';
  if (!present) {
    detail = `stub package not materialized at ${manifest}`;
  } else if (!fs.existsSync(file)) {
    detail = `missing ${file}`;
  } else {
    try {
      replaced = fs.readFileSync(file, 'utf8').includes(STUB_MARKER);
      detail = replaced ? 'single-process replacement present' : 'upstream native flock still in place';
    } catch (error) {
      detail = `cannot read ${file}: ${error && error.message ? error.message : String(error)}`;
    }
  }
  log(`${MARKER}: ${replaced ? 'installed' : 'NOT replaced'} (${detail})`);
  return { marker: MARKER, installed: replaced, present, replaced, detail, file };
}

module.exports = { install, marker: MARKER, stubPackage: STUB_PACKAGE, stubMarker: STUB_MARKER };
