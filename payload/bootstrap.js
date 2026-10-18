'use strict';
/**
 * Node 侧入口（交给 `node::Start` 的脚本）。
 *
 * 职责（顺序固定）：
 *   1) 建立运行期目录与 `app.log`；
 *   2) 安装异常兜底（只落日志，绝不 `process.exit`）；
 *   3) 安装平台垫片（白名单 S1–S5）；
 *   4) 解析/解包载荷（幂等 marker）；缺失则写 `payload-missing`；
 *   5) 交给 `host.js` 启动 dsh Host。
 *
 * 环境契约（由 ArkTS 的 `NodeRuntimeOptions` 注入）：
 *   NODE_BRIDGE_PAYLOAD_ROOT / NODE_BRIDGE_READONLY_ROOT / NODE_BRIDGE_ARCHIVE
 *   DSH_OHOS_APP_LOG / DSH_OHOS_HOME / DSH_OHOS_WORKSPACE
 *
 * 约束：本文件是**唯一**解包者（宪法 C5）；所有路径来自环境变量，绝不用 cwd。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ASSET_DIR = __dirname;
const PAYLOAD_ROOT = process.env.NODE_BRIDGE_PAYLOAD_ROOT || path.join(process.env.HOME || '/', 'payload');
const READONLY_ROOT = process.env.NODE_BRIDGE_READONLY_ROOT || '';
const ARCHIVE = process.env.NODE_BRIDGE_ARCHIVE || '';
const APP_LOG = process.env.DSH_OHOS_APP_LOG || path.join(PAYLOAD_ROOT, 'app.log');
const READY_FILE = path.join(PAYLOAD_ROOT, 'ready.json');
const VERSION_FILE = path.join(ASSET_DIR, 'dsh.version');
const SCAFFOLD_VERSION = '0.1.0+scaffold';

function now() {
  return Date.now();
}

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.mkdirSync(PAYLOAD_ROOT, { recursive: true });
    fs.appendFileSync(APP_LOG, text);
  } catch (error) {
    // 日志不可写时不能拖垮启动；stderr 已被库接管到 node.log。
    process.stderr.write(`[app.log unavailable] ${text}`);
  }
}

function writeReady(payload) {
  const body = JSON.stringify({ schema: 1, at: now(), version: SCAFFOLD_VERSION, ...payload }, null, 2);
  const tmp = `${READY_FILE}.tmp`;
  try {
    fs.mkdirSync(PAYLOAD_ROOT, { recursive: true });
    fs.rmSync(tmp, { force: true });
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, body);
      // 先落盘再改名（整体数据模型 §2 要求 tmp → fsync → rename）。
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, READY_FILE);
  } catch (error) {
    log(`writeReady failed: ${error && error.message ? error.message : String(error)}`);
  }
}

function installExceptionHandlers() {
  process.on('uncaughtException', (error) => {
    log(`uncaughtException: ${error && error.stack ? error.stack : String(error)}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${reason && reason.stack ? reason.stack : String(reason)}`);
  });
}

function installShims() {
  const shims = [];
  const fsLink = require('./shims/fs-link.js');
  shims.push(fsLink.install(log));
  const fsSymlink = require('./shims/fs-symlink.js');
  shims.push(fsSymlink.install(log));
  return shims;
}

function readVersion() {
  try {
    const first = fs.readFileSync(VERSION_FILE, 'utf8').split('\n')[0].trim();
    const [sha256, fileCount, bytes, builtAt] = first.split(/\s+/);
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) {
      return { present: false, detail: `${VERSION_FILE} 首行不是 64 位 sha256` };
    }
    return { present: true, sha256, sha12: sha256.slice(0, 12), fileCount, bytes, builtAt };
  } catch (error) {
    return { present: false, detail: error && error.message ? error.message : String(error) };
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 解析运行根：已解包则复用；有归档则解包；否则返回 null。
 * @returns {string|null}
 */
function resolveRunRoot(version) {
  const devRoot = path.join(PAYLOAD_ROOT, 'dsh');
  if (fs.existsSync(path.join(devRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
    log(`payload: using dev root ${devRoot}`);
    return devRoot;
  }
  if (!ARCHIVE || !fs.existsSync(ARCHIVE)) {
    log(`payload: archive missing (${ARCHIVE || 'not provided'})`);
    return null;
  }
  if (!version.present) {
    log(`payload: version file unusable: ${version.detail}`);
    return null;
  }
  const target = path.join(PAYLOAD_ROOT, version.sha12, 'dsh');
  const marker = path.join(PAYLOAD_ROOT, `.ready-${version.sha12}`);
  if (fs.existsSync(marker) && fs.existsSync(target)) {
    log(`payload: reuse ${target}`);
    return target;
  }
  writeReady({ phase: 'extracting', sha12: version.sha12 });
  const actual = sha256File(ARCHIVE);
  if (actual !== version.sha256) {
    log(`payload: sha256 mismatch (expected ${version.sha256}, actual ${actual})`);
    return null;
  }
  const extract = require('./lib/tar-extract.js');
  const staging = path.join(PAYLOAD_ROOT, `${version.sha12}.staging`);
  fs.rmSync(staging, { recursive: true, force: true });
  const files = extract.untarGzip(ARCHIVE, staging, log);
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, path.dirname(target));
  fs.writeFileSync(marker, `${version.sha256} ${files} ${now()}\n`);
  log(`payload: extracted ${files} files -> ${target}`);
  return target;
}

async function main() {
  fs.mkdirSync(PAYLOAD_ROOT, { recursive: true });
  installExceptionHandlers();
  log(`bootstrap: start (readonlyRoot=${READONLY_ROOT || '-'}, assetDir=${ASSET_DIR})`);

  const shims = installShims();
  const sqlite = require('./shims/sqlite.js').install(log);
  const version = readVersion();

  writeReady({ phase: 'preparing', sha12: version.sha12 || '', shims: shims.map((s) => s.marker) });

  const runRoot = resolveRunRoot(version);
  if (runRoot === null) {
    const diagnostic = [
      `未找到可运行的 dsh 载荷。`,
      `期望归档：${ARCHIVE || '(未提供)'}`,
      `期望版本文件：${VERSION_FILE}`,
      `期望运行根：${path.join(PAYLOAD_ROOT, 'dsh')}`,
      `这是 000-scaffold 的预期状态：载荷由 scripts/assemble-payload.mjs 生成。`
    ].join('\n');
    writeReady({ phase: 'payload-missing', diagnostic, shims: shims.map((s) => s.marker) });
    log(`bootstrap: payload-missing. ${diagnostic}`);
    return;
  }

  const flock = require('./shims/flock.js').install(runRoot, log);
  const sharp = require('./shims/sharp.js').install(runRoot, log);
  shims.push(flock, sharp);

  const host = require('./host.js');
  await host.start({
    runRoot,
    payloadRoot: PAYLOAD_ROOT,
    assetDir: ASSET_DIR,
    version,
    shims: shims.map((s) => ({ marker: s.marker, installed: s.installed === true })),
    sqlite,
    log,
    writeReady
  });
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  log(`bootstrap: fatal ${message}`);
  writeReady({ phase: 'failed', diagnostic: message });
});
