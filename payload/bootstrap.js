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
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.HOME || '/', 'dsh-home');
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

/**
 * 109-jitless：安装纯 JS 兼容层（只在 `WebAssembly === undefined` 时真正接管）。
 *
 * 失败绝不阻断启动：记一行事实并返回 failed 形态；`fetch` 是否可用由自检如实上报。
 */
function installCompatLayer() {
  try {
    const { installIfNeeded } = require('./jitless');
    return installIfNeeded(log);
  } catch (error) {
    const detail = error && error.stack ? error.stack : String(error);
    log(`jitless: 兼容层加载失败（继续启动）：${detail}`);
    return {
      active: false,
      webAssembly: typeof WebAssembly === 'undefined' ? 'undefined' : 'defined',
      httpLazy: 'failed',
      sealed: [],
      fetch: 'failed',
      globals: {},
      fetchImpl: null,
      loadFailed: true
    };
  }
}

/** compat 形态下做一次回环自检（GET/POST/SSE/Abort/FormData），结果进 app.log 与 ready.json。
 *  评审 #2：总预算 1200 ms（超时只记 timeout），且调用点移到 `preparing` 公告之后。 */
async function runCompatSelfCheck(compat, budgetMs) {
  if (compat.loadFailed === true) {
    return { status: 'not-run', cases: [], detail: 'compat 层加载失败' };
  }
  if (compat.active !== true) {
    return { status: 'skipped', cases: [] };
  }
  try {
    const { runSelfCheck } = require('./jitless/selfcheck.js');
    // 全局接管失败时用 fetchImpl 直连：把「垫片坏了」与「接管坏了」分开取证（评审 #5）。
    const options = typeof compat.fetchImpl === 'function' ? { budgetMs, fetch: compat.fetchImpl } : { budgetMs };
    return await runSelfCheck(log, options);
  } catch (error) {
    const detail = error && error.stack ? error.stack : String(error);
    log(`jitless: 自检执行失败（不阻断启动）：${detail}`);
    return { status: 'failed', cases: [], detail };
  }
}

function installShims() {
  const shims = [];
  const fsLink = require('./shims/fs-link.js');
  shims.push(fsLink.install(log));
  const fsSymlink = require('./shims/fs-symlink.js');
  shims.push(fsSymlink.install(log));
  // S6：app-boot 用原生 addon 读 Node 内部模块；OHOS 无该 addon 的预编译二进制，
  // 装配期已把包替换为纯 JS 实现（依赖 --expose-internals）。这里只测量并如实上报。
  const requireBuiltin = require('./shims/require-builtin.js');
  shims.push(requireBuiltin.install(log));
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
/**
 * 用户级 patch：`$DSH_HOME/user-patch.yml`（设备可改、升级不覆盖）。缺省写入空数组。
 * 平台适配不在这一层（FR-105-006）。
 */
function ensureUserPatch() {
  const file = path.join(DSH_HOME, 'user-patch.yml');
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '# 用户级 patch（设备可改；升级不覆盖）。空数组 = 无覆盖。\n[]\n');
      log(`user-patch: created ${file}`);
    }
    return file;
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    log(`user-patch: 写入失败（不影响启动）：${detail}`);
    return '';
  }
}

async function main() {
  fs.mkdirSync(PAYLOAD_ROOT, { recursive: true });
  installExceptionHandlers();
  log(`bootstrap: start (readonlyRoot=${READONLY_ROOT || '-'}, assetDir=${ASSET_DIR})`);

  // 109-jitless：兼容层必须在任何 fetch 使用之前安装；WASM 可用时它一个动作都不做。
  const compat = installCompatLayer();

  const shims = installShims();
  const sqlite = require('./shims/sqlite.js').install(log);
  const version = readVersion();

  writeReady({ phase: 'preparing', sha12: version.sha12 || '', shims: shims.map((s) => s.marker), compat });

  // 自检放在 preparing 公告之后，并带总预算：绝不拖住启动（FR-109-017 / 评审 #2）。
  compat.selfcheck = await runCompatSelfCheck(compat, 1200);

  const runRoot = resolveRunRoot(version);
  if (runRoot === null) {
    const diagnostic = [
      `未找到可运行的 dsh 载荷。`,
      `期望归档：${ARCHIVE || '(未提供)'}`,
      `期望版本文件：${VERSION_FILE}`,
      `期望运行根：${path.join(PAYLOAD_ROOT, 'dsh')}`,
      `这是 000-scaffold 的预期状态：载荷由 scripts/assemble-payload.mjs 生成。`
    ].join('\n');
    writeReady({ phase: 'payload-missing', diagnostic, shims: shims.map((s) => s.marker), compat });
    log(`bootstrap: payload-missing. ${diagnostic}`);
    return;
  }

  // profile 必须留在运行根内：插件的 `import('@dsh-ohos/x')` 由 ESM 从 profile 目录向上解析，
  // 只有 <runRoot>/node_modules 在解析链上（搬到 $DSH_HOME 会导致全部 seam 插件 import 失败）。
  const profileDir = path.join(runRoot, 'profiles', 'ohos');
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    const detail = `载荷缺少 profiles/ohos：${profileDir}`;
    writeReady({ phase: 'failed', diagnostic: detail, shims: shims.map((s) => s.marker), compat });
    log(`bootstrap: ${detail}`);
    return;
  }
  log(`profile: using ${profileDir}`);

  // 用户级 patch 单独放 $DSH_HOME（设备可改、升级不覆盖；AC-105-05）
  ensureUserPatch();

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
    compat,
    log,
    writeReady
  });
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  log(`bootstrap: fatal ${message}`);
  writeReady({ phase: 'failed', diagnostic: message });
});
