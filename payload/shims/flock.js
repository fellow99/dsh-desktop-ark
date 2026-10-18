'use strict';
/**
 * 平台垫片 S3：`flock` 的进程内替身探针。
 *
 * 上游 `session-persistence-jsonl` 通过 `@deepseek-ai/node-addon-system/flock`
 * 取内核排他锁。该包是原生 addon，在 libnode 上不可用；正确做法是在载荷物化阶段
 * 用同名包替身覆盖（`single` 进程语义等价）。
 *
 * 本文件不 patch 模块解析（那会变成不可审计的隐式行为），只做两件事：
 *   1) 探测替身是否已随载荷物化（`node_modules/@deepseek-ai/node-addon-system/package.json` 的标记）；
 *   2) 输出可审计结论，供 `selfcheck` 与 `/_ohos/facts` 使用。
 *
 * 标记：DSH_OHOS_SHIM flock
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'DSH_OHOS_SHIM flock';
const STUB_PACKAGE = path.join('@deepseek-ai', 'node-addon-system');

/**
 * @param {string} runRoot - 运行根（含 `node_modules`）
 * @param {(line: string) => void} log
 */
function install(runRoot, log) {
  const manifest = path.join(runRoot, 'node_modules', STUB_PACKAGE, 'package.json');
  const present = fs.existsSync(manifest);
  if (!present) {
    log(`${MARKER}: stub package not materialized at ${manifest} (flock will fail if reached)`);
    return { marker: MARKER, installed: false, present: false, manifest };
  }
  log(`${MARKER} installed (stub package present)`);
  return { marker: MARKER, installed: true, present: true, manifest };
}

module.exports = { install, marker: MARKER, stubPackage: STUB_PACKAGE };
