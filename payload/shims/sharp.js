'use strict';
/**
 * 平台垫片 S4：`sharp` 替身探针。
 *
 * 无 libvips / 无 aarch64-ohos 产物。载荷物化阶段用同名包顶替（纯 JS 头解析 +
 * 需要转换时走宿主桥 `image.normalize`）。本文件只探测与登记，不做隐式替换。
 *
 * 标记：DSH_OHOS_SHIM sharp
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'DSH_OHOS_SHIM sharp';

/**
 * @param {string} runRoot - 运行根（含 `node_modules`）
 * @param {(line: string) => void} log
 */
function install(runRoot, log) {
  const manifest = path.join(runRoot, 'node_modules', 'sharp', 'package.json');
  const present = fs.existsSync(manifest);
  if (!present) {
    log(`${MARKER}: replacement package not materialized at ${manifest} (attachments will fail if reached)`);
    return { marker: MARKER, installed: false, present: false, manifest };
  }
  log(`${MARKER} installed (replacement package present)`);
  return { marker: MARKER, installed: true, present: true, manifest };
}

module.exports = { install, marker: MARKER };
