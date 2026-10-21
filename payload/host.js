'use strict';
/**
 * dsh Host 启动器（等价于 `apps/desktop-host` 的精简版，去掉 Electron 专属逻辑）。
 *
 * 只做四件事：
 *   1) 从运行根解析上游包（`createRequire` 指向 `@deepseek-ai/dsh/package.json`）；
 *   2) `loadProfileDirectory` 载入 `<runRoot>/profiles/ohos`（用户 patch 来自 `$DSH_HOME/user-patch.yml`）；
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
/**
 * 012-pnpm-integration / 201-dsh-market：把进程内 pnpm 的运行时前提准备好。
 *
 * 三件事，全部幂等，失败只记日志（它们不改变 Host 能否启动，只改变「能不能装插件」）：
 *   1) `DSH_PNPM_ENGINE` 指向随包物化的纯 JS pnpm 入口；
 *   2) profile 的 `pnpm-workspace.yaml` 缺失时创建（hoisted / copy / 不装 peer / 不跑脚本）；
 *   3) 建出 store 与 cache 目录（两者都必须落在沙箱内）。
 *
 * `storeDir` 必须是绝对路径：设备上 `process.cwd()` 是 `/`，相对路径会解析到沙箱外。
 *
 * @param {{ runRoot: string, profileDir: string, log: (line: string) => void }} options
 */
function configureMarketRuntime(options) {
  const { runRoot, profileDir, log } = options;
  const engine = path.join(runRoot, 'node_modules', 'dsh-market-pnpm', 'bin', 'pnpm.cjs');
  process.env.DSH_PNPM_ENGINE = engine;
  log(`market: DSH_PNPM_ENGINE=${engine}`);

  const storeDir = path.join(profileDir, '.pnpm-store');
  const configFile = path.join(profileDir, 'pnpm-workspace.yaml');
  try {
    if (!fs.existsSync(configFile)) {
      // `autoInstallPeers: false`：缺 peer 时走 dsh 的运行时解析，所有插件共用安装里那一份 cordis
      // （与上游 app-boot 的 profile 模板同一语义）。`ignoreScripts`：平台既不能编译也不能 spawn。
      const body = [
        'packages:',
        '  - .',
        '',
        'nodeLinker: hoisted',
        'autoInstallPeers: false',
        'packageImportMethod: copy',
        'ignoreScripts: true',
        'minimumReleaseAge: 0',
        `storeDir: ${JSON.stringify(storeDir)}`,
        '',
      ].join('\n');
      fs.writeFileSync(configFile, body);
      log(`market: wrote pnpm config ${configFile} (storeDir=${storeDir})`);
    } else {
      // 已经存在就保留用户/市场的其它键，但 `storeDir` 必须落在**本次** profile 之下：
      // 开发机上跑过冒烟会把当时的绝对路径留在文件里，随包发出去后设备上会指向沙箱外，
      // 每次安装都失败且无法自愈。只重写这一行，其余原样保留。
      const current = fs.readFileSync(configFile, 'utf8');
      const match = /^storeDir:\s*(.+)$/m.exec(current);
      const configured = match === null ? '' : match[1].trim().replace(/^["']|["']$/g, '');
      if (configured !== storeDir) {
        const rewritten = match === null
          ? `${current.trimEnd()}\nstoreDir: ${JSON.stringify(storeDir)}\n`
          : current.replace(match[0], `storeDir: ${JSON.stringify(storeDir)}`);
        fs.writeFileSync(configFile, rewritten);
        log(`market: storeDir 修正为 ${storeDir}（原值 ${configured === '' ? '(未设置)' : configured}）`);
      } else {
        log(`market: pnpm config kept as-is ${configFile}`);
      }
    }
  } catch (error) {
    log(`market: pnpm config unavailable (continuing): ${error && error.message ? error.message : String(error)}`);
  }

  for (const dir of [storeDir, path.join(profileDir, '.pnpm-cache')]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      log(`market: cannot create ${dir} (continuing): ${error && error.message ? error.message : String(error)}`);
    }
  }
}

async function start(ctx) {
  const { runRoot, version, shims, sqlite, compat, log, writeReady } = ctx;
  const dshHome = process.env.DSH_HOME || path.join(process.env.HOME || '/', 'dsh-home');
  // profile 留在运行根内：ESM 从该目录向上只会在 <runRoot>/node_modules 命中 @dsh-ohos/*。
  const projectDir = path.join(runRoot, 'profiles', 'ohos');
  const userPatch = path.join(dshHome, 'user-patch.yml');
  const dshManifest = path.join(runRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  // 012/201：进程内 pnpm 的运行时前提（引擎入口 + profile pnpm 配置）。必须在 runProfile 之前，
  // 因为 profile 的组合与行配置在 runProfile 内一次性读取。
  configureMarketRuntime({ runRoot, profileDir: projectDir, log });

  writeReady({ phase: 'starting', sha12: version.sha12, shims: shims.map((s) => s.marker), compat });

  if (!fs.existsSync(dshManifest)) {
    writeReady({
      phase: 'payload-missing',
      diagnostic: `缺少上游包：${dshManifest}`,
      shims: shims.map((s) => s.marker),
      compat
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
    writeReady({ phase: 'failed', diagnostic: `解析上游包失败：${message}`, shims: shims.map((s) => s.marker), compat });
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
      patchFiles: userPatch !== '' && fs.existsSync(userPatch) ? [userPatch] : [],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0']
    });

    const { ctx: hostCtx } = await application;
    // 上游只提供 loopback 端口（dsh-web-app 的 localWebUrl 口径就是 http://127.0.0.1:<port>）；
    // 不要臆造 `webServer.protocol` 之类的字段（不存在 → `Invalid URL`）。
    const port = hostCtx.webServer.port;
    if (!Number.isInteger(port) || port <= 0) {
      const diagnostic = `webServer.port 非法：${String(port)}`;
      log(`host: ${diagnostic}`);
      writeReady({ phase: 'failed', diagnostic, shims: shims.map((s) => s.marker), compat });
      return;
    }
    const origin = `http://127.0.0.1:${String(port)}`;
    const url = hostCtx.connection.authenticatedUrl(origin);
    const token = new URL(url).searchParams.get('token') || '';
    if (token === '') {
      const diagnostic = 'authenticatedUrl 未携带一次性 token';
      log(`host: ${diagnostic}`);
      writeReady({ phase: 'failed', diagnostic, shims: shims.map((s) => s.marker), compat });
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
      // 109-jitless：形态事实（active / webAssembly / fetch / selfcheck）随公告对外可见。
      compat,
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
    writeReady({ phase: 'failed', diagnostic: `启动 dsh Host 失败：${message}`, shims: shims.map((s) => s.marker), compat });
  }
}

module.exports = { start };
