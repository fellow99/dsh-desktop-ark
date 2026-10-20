'use strict';
/**
 * 平台垫片 S4：`sharp` 替身探针。
 *
 * 无 libvips / 无 aarch64-ohos 产物。载荷物化阶段（`scripts/lib/payload-shims.mjs`
 * 的 `applySharpShim`）把 `node_modules/sharp` **同名包**换成 `payload/shims/sharp`
 * 的 CJS 包装入口，本体是 `@dsh-ohos/attachment-image`（纯 JS 头解析；需要像素操作时
 * 走宿主桥 `image.normalize`）。
 *
 * 本文件只做审计，不 patch 模块解析：判定依据是 `package.json` 的 `dshOhosShim: "S4"`
 * —— **不能只看包存在**：上一版就是这样报了假阳性（日志写 installed，实际仍是上游 sharp，
 * 首轮图片对话才报 "Could not load the sharp module using the openharmony-arm64 runtime"）。
 *
 * 标记：DSH_OHOS_SHIM sharp
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'DSH_OHOS_SHIM sharp';
const SHIM_ID = 'S4';

/**
 * @param {string} runRoot - 运行根（含 `node_modules`）
 * @param {(line: string) => void} log
 */
function install(runRoot, log) {
  const manifestPath = path.join(runRoot, 'node_modules', 'sharp', 'package.json');
  let present = false;
  let replaced = false;
  let detail = '';
  let upstreamVersion = '';
  if (!fs.existsSync(manifestPath)) {
    detail = `replacement package not materialized at ${manifestPath}`;
  } else {
    present = true;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      replaced = manifest.dshOhosShim === SHIM_ID;
      upstreamVersion = typeof manifest.upstreamVersion === 'string' ? manifest.upstreamVersion : '';
      detail = replaced
        ? `pure-JS replacement present (upstream ${upstreamVersion || 'unknown'})`
        : 'upstream sharp still in place';
    } catch (error) {
      detail = `cannot parse ${manifestPath}: ${error && error.message ? error.message : String(error)}`;
    }
  }
  log(`${MARKER}: ${replaced ? 'installed' : 'NOT replaced'} (${detail})`);
  return { marker: MARKER, installed: replaced, present, replaced, detail, manifestPath, upstreamVersion };
}

module.exports = { install, marker: MARKER, shimId: SHIM_ID };
