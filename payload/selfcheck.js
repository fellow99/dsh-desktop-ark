'use strict';
/**
 * 载荷自检（L0 门禁的现场判据）。
 *
 * 只断言"能在本机验证的事实"：
 *   - 垫片是否安装（S1/S2 行为、S5 探测结果）；
 *   - 运行期目录是否可写；
 *   - `ready.json` 结构是否合法（若存在）。
 *
 * 不检查未实现的能力（那属于模块测试）。
 *
 * 用法：`node selfcheck.js`（输出 JSON；全部通过时退出码 0）
 */
const fs = require('node:fs');
const path = require('node:path');

const PAYLOAD_ROOT = process.env.NODE_BRIDGE_PAYLOAD_ROOT || path.join(process.env.HOME || '/', 'payload');
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
}

function checkShims() {
  const fsLink = require('./shims/fs-link.js');
  const fsSymlink = require('./shims/fs-symlink.js');
  const sqlite = require('./shims/sqlite.js');
  const noop = () => {};

  const link = fsLink.install(noop);
  record('shim.fs.link', link.installed === true, link.marker);

  const symlink = fsSymlink.install(noop);
  record('shim.fs.symlink', symlink.installed === true, symlink.marker);

  // S3/S4：垫片模块必须存在且标记正确（替身包是否物化由 build 侧决定，这里只断言"可审计"）。
  const flock = require('./shims/flock.js');
  record('shim.flock', typeof flock.marker === 'string' && flock.marker.indexOf('flock') >= 0, flock.marker);
  const sharp = require('./shims/sharp.js');
  record('shim.sharp', typeof sharp.marker === 'string' && sharp.marker.indexOf('sharp') >= 0, sharp.marker);

  const sqliteProbe = sqlite.install(noop);
  // G2 未过不算失败：它是"事实"，由发布方决定是否启用会话搜索。
  record('probe.node:sqlite', true, `available=${sqliteProbe.available} fts5=${sqliteProbe.fts5}`);
}

function checkDirs() {
  try {
    fs.mkdirSync(PAYLOAD_ROOT, { recursive: true });
    const probe = path.join(PAYLOAD_ROOT, `.selfcheck-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    record('dirs.payloadRoot', true, PAYLOAD_ROOT);
  } catch (error) {
    record('dirs.payloadRoot', false, error && error.message ? error.message : String(error));
  }
}

function checkReady() {
  const readyFile = path.join(PAYLOAD_ROOT, 'ready.json');
  if (!fs.existsSync(readyFile)) {
    record('ready.present', true, 'not yet written (cold start)');
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    const phaseOk = typeof parsed.phase === 'string';
    const readyOk = parsed.phase !== 'ready' || (typeof parsed.url === 'string' && parsed.url.startsWith('http://127.0.0.1:'));
    record('ready.schema', parsed.schema === 1 && phaseOk, `phase=${parsed.phase}`);
    record('ready.readyFields', readyOk, parsed.phase === 'ready' ? parsed.url : 'n/a');
  } catch (error) {
    record('ready.parse', false, error && error.message ? error.message : String(error));
  }
}

checkShims();
checkDirs();
checkReady();

const failed = results.filter((item) => item.ok !== true);
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, results }, null, 2)}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
