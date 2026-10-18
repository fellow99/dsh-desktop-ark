'use strict';
/**
 * dsh Host 启动器（等价于 `apps/desktop-host` 的精简版，去掉 Electron 专属逻辑）。
 *
 * 只做四件事：
 *   1) 从运行根解析上游包（`createRequire` 指向 `@deepseek-ai/dsh/package.json`）；
 *   2) `loadProfileDirectory` 载入 `$DSH_HOME/profiles/ohos`；
 *   3) `runProfile` 启动 Web 应用（`--host 127.0.0.1 --port 0 --no-open`）；
 *   4) 用 `ctx.connection.authenticatedUrl()` 上报带一次性 token 的入口 URL。
 *
 * 失败时不抛给 bootstrap（那会被当作致命错误），而是写 `ready.json` 的失败态。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

/**
 * @param {{
 *   runRoot: string,
 *   payloadRoot: string,
 *   assetDir: string,
 *   version: object,
 *   shims: Array<{marker: string, installed: boolean}>,
 *   sqlite: object,
 *   log: (line: string) => void,
 *   writeReady: (payload: object) => void
 * }} ctx
 */
async function start(ctx) {
  const { runRoot, version, shims, sqlite, log, writeReady } = ctx;
  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || '/', 'dsh-home');
  const projectDir = path.join(dshHome, 'profiles', 'ohos');
  const dshManifest = path.join(runRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');

  writeReady({ phase: 'starting', sha12: version.sha12, shims: shims.map((s) => s.marker) });

  if (!fs.existsSync(dshManifest)) {
    writeReady({
      phase: 'payload-missing',
      diagnostic: `缺少上游包：${dshManifest}`,
      shims: shims.map((s) => s.marker)
    });
    return;
  }

  let appBoot;
  let profileBoot;
  try {
    const requireFromRun = createRequire(dshManifest);
    appBoot = await import(pathToFileURL(requireFromRun.resolve('@deepseek-ai/dsh-app-boot')).href);
    profileBoot = await import(pathToFileURL(requireFromRun.resolve('@deepseek-ai/dsh/profile-boot')).href);
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error);
    log(`host: resolve upstream failed: ${message}`);
    writeReady({ phase: 'failed', diagnostic: `解析上游包失败：${message}`, shims: shims.map((s) => s.marker) });
    return;
  }

  try {
    const profile = appBoot.loadProfileDirectory('dsh', projectDir, dshManifest);
    appBoot.reportSkippedBundles('dsh', profile);
    log(`host: profile loaded from ${projectDir}`);

    const application = profileBoot.runProfile({
      environment: appBoot.loadLayeredEnv('dsh'),
      profile: 'ohos',
      resolvedProfile: { profile, installAnchor: dshManifest },
      patchFiles: [],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0']
    });

    const { ctx: hostCtx } = await application;
    const origin = `${hostCtx.webServer.protocol}//127.0.0.1:${hostCtx.webServer.port}`;
    const url = hostCtx.connection.authenticatedUrl(origin);
    const token = new URL(url).searchParams.get('token') || '';
    if (token === '') {
      const diagnostic = 'authenticatedUrl 未携带一次性 token';
      log(`host: ${diagnostic}`);
      writeReady({ phase: 'failed', diagnostic, shims: shims.map((s) => s.marker) });
      return;
    }

    writeReady({
      phase: 'ready',
      url,
      origin,
      token,
      pid: process.pid,
      sha12: version.sha12,
      shims: shims.map((s) => s.marker),
      sqlite,
      roots: {
        payload: runRoot,
        dshHome,
        workspace: process.env.DSH_OHOS_WORKSPACE || '',
        readonly: process.env.NODE_BRIDGE_READONLY_ROOT || ''
      }
    });
    log(`host: ready at ${origin} (token length=${token.length})`);
  } catch (error) {
    const message = error && error.stack ? error.stack : String(error);
    log(`host: runProfile failed: ${message}`);
    writeReady({ phase: 'failed', diagnostic: `启动 dsh Host 失败：${message}`, shims: shims.map((s) => s.marker) });
  }
}

module.exports = { start };
