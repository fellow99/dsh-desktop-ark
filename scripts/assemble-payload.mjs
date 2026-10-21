#!/usr/bin/env node
/**
 * 装配载荷（真实物化）：把上游 dsh 运行树变成可随包分发的 `build/payload-stage/dsh`。
 *
 * 两种输入：
 *   --deploy          从 `../deepseek-harness` 物化（pnpm deploy --legacy + 补全 + web dist）
 *   --from <dir>      采用一棵已构建好的运行树（不校验其来源）
 *
 * 覆盖层（两种输入都会注入，除非 `--no-overlay`）：
 *   profiles/ohos/     → <stage>/profiles/ohos/
 *   packages/*-ohos/   → <stage>/node_modules/@dsh-ohos/<short>/
 *
 * 落盘由 `--apply` 控制：没有 `--apply` 时不写 `build/payload-stage`（dry-run 只打印计划）。
 *
 * 退出码：0 成功（含 dry-run）；1 断言/执行失败；2 缺必需输入（并给出下一步命令）。
 *
 * 依据：specs/102-payload-pipeline/{spec,plan}.md（FR-102-016/017/018）、
 *      specs/105-upstream-adapter-bundle/spec.md（FR-105-004/019）、
 *      docs/000-工程规划.md §7.2。
 */
import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFlockShim, applySharpShim, applyAttachmentDurabilityPatch } from './lib/payload-shims.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DSH_ROOT = resolve(ROOT, '../deepseek-harness');
const STAGE = resolve(ROOT, 'build/payload-stage/dsh');
const WORK = resolve(ROOT, 'build/payload-stage/.work');
const PROFILE_SRC = resolve(ROOT, 'profiles/ohos');
const PACKAGES_SRC = resolve(ROOT, 'packages');
const SHIMS_SRC = resolve(ROOT, 'payload/shims');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const deploy = flag('--deploy');
const fromDir = value('--from');
const apply = flag('--apply');
const noOverlay = flag('--no-overlay');
// 就地重跑覆盖层：不重新物化上游树（--deploy/--from 之外的第三条输入），
// 用于「改完 packages/ 或 profiles/ 只想重装一遍插件与 profile」的场景。
const reuse = flag('--reuse');

/** 一行结论 + 明确下一步。 */
function fail(code, message, next) {
  console.error(`\n[assemble-payload] ${message}`);
  if (next) console.error(`[assemble-payload] 下一步：${next}`);
  process.exit(code);
}

function log(message) {
  console.log(`[assemble-payload] ${message}`);
}

function run(command, cwd) {
  log(`$ ${command}`);
  execSync(command, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, CI: process.env.CI ?? 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** pnpm 在 Windows 上用 Junction 表达 workspace 链接；落到设备上会失效，故就地换成真实目录。 */
function materializeLinks(dir, depth = 0, touched = []) {
  if (depth > 8) return touched;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return touched;
  }
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue;
    const full = join(dir, entry.name);
    if (isSymlink(full)) {
      try {
        const target = realpathSync(full);
        rmSync(full, { recursive: true, force: true });
        cpSync(target, full, { recursive: true, dereference: true });
        touched.push(full);
      } catch (error) {
        log(`物化链接失败 ${full}：${error.message}`);
      }
    } else if (entry.isDirectory()) {
      materializeLinks(full, depth + 1, touched);
    }
  }
  return touched;
}

/** 复制单个 workspace 包（lib + package.json + cordis.patch.yml），排除嵌套 node_modules。 */
function copyWorkspacePackage(pkgDir, destRoot) {
  const manifest = resolve(pkgDir, 'package.json');
  if (!existsSync(manifest)) return undefined;
  let name;
  try {
    name = JSON.parse(readFileSync(manifest, 'utf8')).name;
  } catch {
    return undefined;
  }
  if (!name || !name.startsWith('@deepseek-ai/')) return undefined;
  const short = name.slice('@deepseek-ai/'.length);
  const dest = resolve(destRoot, short);
  if (existsSync(dest)) return undefined;
  cpSync(pkgDir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => !src.includes(`${sep}node_modules`) && !src.includes(`${sep}test`),
  });
  return short;
}

/** deploy 不物化 peerDependencies 与 workspace 源码包；这里按目录结构补齐。 */
function collectWorkspacePackages(stage) {
  const destRoot = resolve(stage, 'node_modules/@deepseek-ai');
  mkdirSync(destRoot, { recursive: true });
  const copied = [];
  const categories = ['packages', 'vendor', 'apps'];
  for (const category of categories) {
    const dir = resolve(DSH_ROOT, category);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (existsSync(resolve(full, 'package.json'))) {
        const done = copyWorkspacePackage(full, destRoot);
        if (done) copied.push(done);
        continue;
      }
      let nested = [];
      try {
        nested = readdirSync(full);
      } catch {
        continue;
      }
      for (const child of nested) {
        const done = copyWorkspacePackage(resolve(full, child), destRoot);
        if (done) copied.push(done);
      }
    }
  }
  return copied;
}

/** .pnpm 里的非 hoisted 依赖（zod 等）同样要摊平到顶层，否则设备上解析不到。 */
function collectNonHoistedDeps(stage) {
  const pnpmDir = resolve(stage, 'node_modules/.pnpm');
  const topDir = resolve(stage, 'node_modules');
  if (!existsSync(pnpmDir)) return [];
  const copied = new Set();
  const materialize = (entry, name) => {
    if (copied.has(name)) return;
    const dest = resolve(topDir, ...name.split('/'));
    if (existsSync(dest)) return;
    const nested = resolve(pnpmDir, entry, 'node_modules', ...name.split('/'));
    if (!existsSync(nested)) return;
    cpSync(nested, dest, { recursive: true, dereference: true });
    copied.add(name);
  };
  for (const entry of readdirSync(pnpmDir)) {
    const nodeModules = resolve(pnpmDir, entry, 'node_modules');
    if (!existsSync(nodeModules)) continue;
    for (const scopeOrName of readdirSync(nodeModules)) {
      const full = resolve(nodeModules, scopeOrName);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (scopeOrName.startsWith('@')) {
        for (const name of readdirSync(full)) materialize(entry, `${scopeOrName}/${name}`);
      } else {
        materialize(entry, scopeOrName);
      }
    }
  }
  return [...copied];
}

/**
 * 剪裁载荷：只保留运行期真正会读到的文件。
 *
 * 去掉的内容在 aarch64/OHOS 上都不可能被加载或需要：其它平台的预编译包（含 184 MB 的
 * Windows LibreOffice 套件）、TypeScript 源码、类型声明、sourcemap、测试与文档。
 * 目标是 HAP 的 200 MB 预算（specs/102 §6「体积」）。
 */
const PRUNE_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  'test-fixtures',
  'fixtures',
  'docs',
  'example',
  'examples',
  'benchmark',
  'benchmarks',
]);
const PRUNE_FILE_EXT = ['.map', '.ts', '.tsx', '.tsbuildinfo', '.md', '.markdown'];
// 尾部 ABI 后缀（-msvc / -gnu / -musl）同样是别的平台；漏判会把 win32 预编译二进制打进包。
const ABI_SUFFIX = '(?:-(?:msvc|gnu|musl))?';
const FOREIGN_PKG = new RegExp(`-(win32|win|darwin|mac|linux|android)-(x64|ia32|arm64|arm|universal)${ABI_SUFFIX}$`);
const PLATFORM_DIR = new RegExp(`^(win32|win|darwin|mac|linux|android|freebsd)-(x64|ia32|arm64|arm|universal)${ABI_SUFFIX}$`);

function prunePayload(stage) {
  const nodeModules = resolve(stage, 'node_modules');
  let removedFiles = 0;
  let removedBytes = 0;
  const drop = (full, isDirectory) => {
    if (isDirectory) {
      const size = countTree(full);
      rmSync(full, { recursive: true, force: true });
      removedFiles += size.files;
      removedBytes += size.bytes;
    } else {
      try {
        removedBytes += lstatSync(full).size;
      } catch {
        // 大小读不到也照样删
      }
      rmSync(full, { force: true });
      removedFiles += 1;
    }
  };
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('@')) {
          walk(full, depth + 1); // scope 目录本身不是包
          continue;
        }
        if (PRUNE_DIRS.has(entry.name) || FOREIGN_PKG.test(entry.name) || PLATFORM_DIR.test(entry.name)) {
          drop(full, true);
          continue;
        }
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('LICENSE') || entry.name.startsWith('NOTICE')) continue;
        if (PRUNE_FILE_EXT.some((ext) => entry.name.endsWith(ext))) drop(full, false);
      }
    }
  };
  walk(nodeModules, 0);
  log(`剪裁：移除 ${removedFiles} 个文件 / ${(removedBytes / 1048576).toFixed(1)} MiB`);
}

/**
 * 204-plugin-git：isomorphic-git 的版本 pin。
 *
 * 唯一可改点 —— 插件侧 `packages/git-ohos/lib/runtime.js` 的 `ISOMORPHIC_GIT_VERSION` 必须与
 * 此值一致（装载时断言），升级要同时改两处并重跑本脚本 + 真机回归。
 */
const ISOMORPHIC_GIT_VERSION = '1.44.2';

/** `diff` 由宿主依赖闭包提供（上游四个包声明 `diff ^9.0.0`），本工程**不物化**第二份。 */
const HOST_DIFF_MAJOR = 9;

/** 闭包里 `package.json` 的最小数量；低于它就说明 pnpm 只装了直接依赖。 */
const GIT_CLOSURE_MIN_PACKAGES = 50;

/**
 * 204-plugin-git：把 isomorphic-git 及其整棵依赖闭包物化到**插件自己的** `node_modules/`。
 *
 * 为什么嵌套而不是平铺到载荷顶层：载荷顶层已有 `pako@0.2.9`（isomorphic-git 需要 1.x）等同名包，
 * 平铺会覆盖它们从而破坏上游。嵌套后 Node 从 `@dsh-ohos/git/lib/*.js` 向上第一跳即命中本闭包，
 * 与载荷顶层绝不互相影响。
 *
 * 为什么 `diff` 不在此列：上游 `dsh-tool-fs` 等四个包已声明 `diff ^9.0.0`，载荷顶层就有
 * `diff@9.0.0`；再物化一份会同名冲突且多 0.8 MiB。插件只在 `peerDependencies` 声明它。
 *
 * 调用点：`overlay()` 内、`collectOhosPackages()` **之后**（插件目录必须先存在）。
 * 失败一律抛错（不用 `process.exit`），由调用点统一 `fail()`，以保证 staging 清理。
 *
 * @param {string} stage - 载荷 stage 根（含 `node_modules/`）。
 * @returns {{dir: string, packages: number, bytes: number}} 落位、闭包包数、字节数。
 */
function collectGitRuntime(stage) {
  const pluginDir = resolve(stage, 'node_modules/@dsh-ohos/git');
  if (!existsSync(resolve(pluginDir, 'package.json'))) {
    throw new Error(`204-plugin-git: 插件目录缺失 ${pluginDir}（collectOhosPackages() 必须先跑）`);
  }

  const dest = resolve(pluginDir, 'node_modules');
  const installedManifest = resolve(dest, 'isomorphic-git/package.json');

  // 快路径：目标已完整物化且版本一致。常规链路不可达（stage 每次重建），只服务于
  // 「单独二次调用 collectGitRuntime()」的幂等验证。
  if (existsSync(installedManifest)) {
    const actual = JSON.parse(readFileSync(installedManifest, 'utf8')).version;
    if (actual === ISOMORPHIC_GIT_VERSION) {
      const stats = countTree(dest);
      log(`git 运行时已在位：isomorphic-git@${actual}（${stats.files} 个文件 / ${(stats.bytes / 1048576).toFixed(1)} MiB）`);
      assertGitRuntimeArtifact(stage);
      return { dir: dest, packages: countPackages(dest), bytes: stats.bytes };
    }
    rmSync(dest, { recursive: true, force: true });
  }

  const staging = resolve(WORK, 'git-runtime');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    writeFileSync(resolve(staging, 'package.json'), `${JSON.stringify({
      name: 'dsh-ohos-git-runtime',
      private: true,
      version: '0.0.0',
      description: 'Staging tree for the isomorphic-git closure materialized into @dsh-ohos/git/node_modules.',
    }, null, 2)}\n`);
    run(`pnpm add isomorphic-git@${ISOMORPHIC_GIT_VERSION} --config.node-linker=hoisted --ignore-scripts`, staging);

    const source = resolve(staging, 'node_modules');
    if (!existsSync(resolve(source, 'isomorphic-git/package.json'))) {
      throw new Error(`204-plugin-git: pnpm 未产出 isomorphic-git（${source}）`);
    }
    mkdirSync(dest, { recursive: true });
    // 扁平闭包整体复制：dereference 把 pnpm 可能留下的链接换成真实文件（设备上没有链接语义）。
    cpSync(source, dest, { recursive: true, dereference: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  assertGitRuntimeArtifact(stage);
  const stats = countTree(dest);
  log(`git 运行时已物化：isomorphic-git@${ISOMORPHIC_GIT_VERSION} → node_modules/@dsh-ohos/git/node_modules`
    + `（${countPackages(dest)} 包 / ${stats.files} 个文件 / ${(stats.bytes / 1048576).toFixed(1)} MiB）`);
  return { dir: dest, packages: countPackages(dest), bytes: stats.bytes };
}

// ── 012-pnpm-integration：随包物化的纯 JS pnpm 引擎 ─────────────────────────────────
//
// 设备上既没有 pnpm 二进制，也不允许 spawn 子进程（应用域 fork 出的 node 子进程被 SIGSYS 杀死）。
// 唯一可行路线是把 pnpm 的 CLI（纯 JS）打进载荷，由宿主在同一进程的 worker 线程里 import 它。
// 版本是一个常量：升级 = 改这里 + 重跑装配（断言会先红，不会静默出包）。
const PNPM_VERSION = '10.34.6';

// ── 201-dsh-market：内置插件市场 ────────────────────────────────────────────────────
const DSH_MARKET_VERSION = '1.66.42';
const MARKET_ROOT = resolve(ROOT, '../dsh-market');

/** 删掉 pnpm 引擎里非目标平台的产物（copy 导入法不会加载它们），只控体积。 */
function prunePnpmEngine(root) {
  const distDir = resolve(root, 'dist');
  if (existsSync(distDir)) {
    for (const entry of readdirSync(distDir)) {
      if (/^reflink\.(darwin|win32)/.test(entry)) rmSync(resolve(distDir, entry), { force: true });
    }
  }
  const reflinkDir = resolve(distDir, 'node_modules/@reflink');
  if (existsSync(reflinkDir)) {
    for (const entry of readdirSync(reflinkDir)) {
      if (/^reflink-(darwin|win32)/.test(entry)) rmSync(resolve(reflinkDir, entry), { recursive: true, force: true });
    }
  }
  const vendorDir = resolve(distDir, 'vendor');
  if (existsSync(vendorDir)) {
    for (const entry of readdirSync(vendorDir)) {
      if (entry.endsWith('.exe')) rmSync(resolve(vendorDir, entry), { force: true });
    }
  }
  const changelog = resolve(root, 'CHANGELOG.md');
  if (existsSync(changelog)) rmSync(changelog, { force: true });
}

/** 断言 pnpm 引擎产物：版本一致 + 入口非空（快路径与新物化都必须过）。 */
function assertPnpmEngineArtifact(dest) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(dest, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`pnpm 引擎 package.json 无法解析：${error.message}`);
  }
  if (manifest.version !== PNPM_VERSION) {
    throw new Error(`pnpm 引擎版本不符：期望 ${PNPM_VERSION}，实际 ${manifest.version}（改 PNPM_VERSION 或删产物后重跑）`);
  }
  const entry = resolve(dest, 'bin', 'pnpm.cjs');
  // 刚复制完的树在 Windows 上偶发一次 ENOENT/EBUSY（杀软或索引服务正在扫），重试几次再判死。
  let size = 0;
  let lastError = 'not-found';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      size = statSync(entry).size;
      lastError = '';
      break;
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (!(size > 0)) throw new Error(`pnpm 引擎入口缺失或为空：${entry}（${lastError}）`);
}

/**
 * 物化 pnpm 引擎到 `<stage>/node_modules/dsh-market-pnpm`（独立目录名，避免与载荷顶层同名包耦合）。
 * 幂等：目标已存在只做断言；失败抛错（由调用点统一 fail，staging 在 finally 里清掉）。
 */
function collectMarketPNPM(stage) {
  const dest = resolve(stage, 'node_modules/dsh-market-pnpm');
  if (existsSync(resolve(dest, 'package.json'))) {
    assertPnpmEngineArtifact(dest);
    log('pnpm 引擎已物化（断言通过）');
    return dest;
  }
  const staging = resolve(WORK, 'pnpm-engine');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(
    resolve(staging, 'package.json'),
    `${JSON.stringify({ name: 'pnpm-engine-staging', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  try {
    run(`pnpm add pnpm@${PNPM_VERSION} --config.node-linker=hoisted --ignore-scripts`, staging);
    const src = resolve(staging, 'node_modules/pnpm');
    if (!existsSync(resolve(src, 'package.json'))) {
      throw new Error(`pnpm 引擎物化失败（未落地）：${src}`);
    }
    mkdirSync(resolve(stage, 'node_modules'), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    prunePnpmEngine(dest);
    assertPnpmEngineArtifact(dest);
    log(`pnpm 引擎已物化 (pnpm@${PNPM_VERSION}) -> ${dest}`);
    return dest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 递归复制市场的运行时依赖闭包；`@deepseek-ai/*` 从载荷宿主闭包解析，不复制。 */
function copyMarketRuntimeDeps(srcNm, destNm, marketRoot) {
  let queue = [];
  try {
    const manifest = JSON.parse(readFileSync(resolve(marketRoot, 'package.json'), 'utf8'));
    queue = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];
  } catch {
    return;
  }
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name) || name.startsWith('@deepseek-ai/')) continue;
    seen.add(name);
    const srcPkg = resolve(srcNm, name);
    const destPkg = resolve(destNm, name);
    if (!existsSync(resolve(srcPkg, 'package.json')) || existsSync(resolve(destPkg, 'package.json'))) continue;
    cpSync(srcPkg, destPkg, { recursive: true, dereference: true });
    try {
      const pkg = JSON.parse(readFileSync(resolve(srcPkg, 'package.json'), 'utf8'));
      for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
        queue.push(dep);
      }
    } catch {
      // 读不到的传递依赖会在闭包断言里报出来
    }
  }
}

/**
 * 把市场的 `undici` 换成纯 JS 替身（`payload/shims/undici`）。
 *
 * 原包的 HTTP 解析器是 WASM 版 llhttp，`--jitless` 下每次 fetch 都抛
 * `WebAssembly is not defined`；而 dsh-market 是 `import { fetch } from 'undici'`，
 * 全局 fetch 垫片拦不到它。替身只实现市场用到的 `Agent` / `EnvHttpProxyAgent` / `fetch`。
 */
function applyMarketUndiciShim(dest, log) {
  const target = resolve(dest, 'node_modules/undici');
  if (!existsSync(target)) return; // 市场若不再依赖 undici，这里什么都不做
  const shimSrc = resolve(SHIMS_SRC, 'undici');
  if (!existsSync(resolve(shimSrc, 'package.json'))) {
    throw new Error(`缺少 undici 替身：${shimSrc}（payload/shims/undici）`);
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(shimSrc, target, { recursive: true, dereference: true });
  log('dshmarket 的 undici 已替换为纯 JS 替身（--jitless 兼容）');
}

/** 断言 dshmarket 产物：版本、三个入口、依赖闭包完整、不夹带 `@deepseek-ai/*`、undici 是替身。 */
function assertDshMarketArtifact(dest) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(dest, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`dshmarket package.json 无法解析：${error.message}`);
  }
  if (manifest.version !== DSH_MARKET_VERSION) {
    throw new Error(`dsh-market 版本不符：期望 ${DSH_MARKET_VERSION}，实际 ${manifest.version}（改 DSH_MARKET_VERSION 或换 ../dsh-market 的 commit）`);
  }
  for (const rel of ['lib/index.js', 'client/client.js', 'cordis.patch.yml']) {
    let size = 0;
    try {
      size = statSync(resolve(dest, rel)).size;
    } catch {
      // 缺失由下面统一报告
    }
    if (!(size > 0)) throw new Error(`dshmarket 缺少入口 ${rel}（先 cd ../dsh-market && npm i && npm run build）`);
  }
  const missing = [];
  const seen = new Set();
  const queue = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith('@deepseek-ai/')) continue;
    const pkgJson = resolve(dest, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(pkgJson)) {
      missing.push(name);
      continue;
    }
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
      for (const dep of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
        queue.push(dep);
      }
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) throw new Error(`dshmarket 依赖闭包不完整：${missing.join(', ')}`);
  if (existsSync(resolve(dest, 'node_modules/@deepseek-ai'))) {
    throw new Error('dshmarket 不得携带 @deepseek-ai/*（宿主闭包已提供，复制会造成第二份）');
  }
  const undiciManifest = resolve(dest, 'node_modules/undici/package.json');
  if (existsSync(undiciManifest)) {
    let marker;
    try {
      marker = JSON.parse(readFileSync(undiciManifest, 'utf8')).dshOhosShim;
    } catch (error) {
      throw new Error(`undici 替身的 package.json 无法解析：${error.message}`);
    }
    if (marker !== 'pure-js-undici') {
      throw new Error('dshmarket 的 undici 必须是纯 JS 替身（--jitless 下原包每次 fetch 都失败）');
    }
  }
}

/**
 * 市场工程是否「源码比产物新」。
 *
 * `lib/` 是构建产物：它一旦落后于 `src/`，我们打出去的包就少了新的宿主路由/客户端能力，
 * 而表现只是某个 UI 动作返回 404/405（例：`/dsh-market/sidebar-entry` 在旧 lib 里根本不存在）。
 * 这类漂移必须在装配期变红，而不是等用户点出来。
 */
function assertMarketBuilt(marketRoot) {
  const pairs = [
    ['src/index.ts', 'lib/index.js'],
    ['src/routes.ts', 'lib/routes.js'],
    ['src/client/index.ts', 'client/client.js'],
  ];
  for (const [source, built] of pairs) {
    const srcPath = resolve(marketRoot, source);
    const builtPath = resolve(marketRoot, built);
    if (!existsSync(srcPath) || !existsSync(builtPath)) continue;
    if (statSync(srcPath).mtimeMs > statSync(builtPath).mtimeMs + 1000) {
      throw new Error(
        `dsh-market 的构建产物落后于源码：${built} 比 ${source} 旧（先 cd ../dsh-market && npm run build）`,
      );
    }
  }
}

/** 已物化的 dshmarket 是否落后于源码（是则重拷；源目录对比，只看白名单产物）。 */
function marketCopyIsStale(dest) {
  for (const rel of ['lib/index.js', 'lib/routes.js', 'client/client.js', 'package.json']) {
    const src = resolve(MARKET_ROOT, rel);
    const copy = resolve(dest, rel);
    if (!existsSync(src) || !existsSync(copy)) return true;
    if (statSync(src).mtimeMs > statSync(copy).mtimeMs + 1000) return true;
  }
  return false;
}

/**
 * 物化 dsh-market 到 `<stage>/node_modules/dshmarket`。
 * 市场工程缺失或未构建即抛错；幂等：目标已存在且未落后于源码时只做断言。
 */
function collectDshMarket(stage) {
  const dest = resolve(stage, 'node_modules/dshmarket');
  const firstStep = '先 cd ../dsh-market && npm i && npm run build';
  if (!existsSync(resolve(MARKET_ROOT, 'package.json'))) {
    throw new Error(`dsh-market 未找到：${MARKET_ROOT}（${firstStep}）`);
  }
  assertMarketBuilt(MARKET_ROOT);
  if (existsSync(resolve(dest, 'package.json')) && !marketCopyIsStale(dest)) {
    applyMarketUndiciShim(dest, log);
    assertDshMarketArtifact(dest);
    log('dshmarket 已物化（断言通过）');
    return dest;
  }
  for (const rel of ['lib/index.js', 'client/client.js']) {
    if (!existsSync(resolve(MARKET_ROOT, rel))) {
      throw new Error(`dsh-market 未构建：缺 ${rel}（${firstStep}）`);
    }
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(MARKET_ROOT, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = relative(MARKET_ROOT, src);
      if (rel === '') return true;
      const top = rel.split(/[\\/]/)[0];
      return top === 'package.json' || top === 'cordis.patch.yml' || top === 'lib' || top === 'client';
    },
  });
  const srcNm = resolve(MARKET_ROOT, 'node_modules');
  if (existsSync(srcNm)) copyMarketRuntimeDeps(srcNm, resolve(dest, 'node_modules'), MARKET_ROOT);
  applyMarketUndiciShim(dest, log);
  assertDshMarketArtifact(dest);
  log(`dshmarket 已物化 (${DSH_MARKET_VERSION}) -> ${dest}`);
  return dest;
}

/** 统计一棵树里的 `package.json` 数量（= 包数，scope 目录自身不算）。 */
function countPackages(dir) {
  let count = 0;
  const walk = (current, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) walk(full, entry.name.startsWith('@') ? depth : depth + 1);
      else if (entry.name === 'package.json') count += 1;
    }
  };
  walk(dir, 0);
  return count;
}

/**
 * 204-plugin-git 的产物断言（AC-204-11 / AC-204-12）。任一条不成立即抛错。
 *
 * @param {string} stage - 载荷 stage 根。
 */
function assertGitRuntimeArtifact(stage) {
  const nested = resolve(stage, 'node_modules/@dsh-ohos/git/node_modules');
  const manifest = resolve(nested, 'isomorphic-git/package.json');
  if (!existsSync(manifest)) throw new Error(`204-plugin-git: 缺少 ${manifest}`);
  const actual = JSON.parse(readFileSync(manifest, 'utf8')).version;
  if (actual !== ISOMORPHIC_GIT_VERSION) {
    throw new Error(`204-plugin-git: isomorphic-git 版本 ${actual} 与 pin ${ISOMORPHIC_GIT_VERSION} 不一致`);
  }
  // exports 里的 `./http/node` 是本插件实际使用的 HTTP 客户端面；缺它等于闭包不完整。
  const httpNode = resolve(nested, 'isomorphic-git/http/node/index.js');
  const httpNodeCjs = resolve(nested, 'isomorphic-git/http/node/index.cjs');
  if (!existsSync(httpNode) && !existsSync(httpNodeCjs)) {
    throw new Error('204-plugin-git: isomorphic-git 缺 http/node 入口');
  }
  const packages = countPackages(nested);
  if (packages < GIT_CLOSURE_MIN_PACKAGES) {
    throw new Error(`204-plugin-git: git 闭包只有 ${packages} 个包（下限 ${GIT_CLOSURE_MIN_PACKAGES}），pnpm 可能只装了直接依赖`);
  }
  if (existsSync(resolve(nested, 'diff'))) {
    throw new Error('204-plugin-git: 插件自带的 node_modules 内出现了 diff —— 它必须由宿主闭包提供（AC-204-12）');
  }
  const hostDiff = resolve(stage, 'node_modules/diff/package.json');
  if (!existsSync(hostDiff)) {
    throw new Error(`204-plugin-git: 载荷顶层缺少 diff（${hostDiff}）：本插件依赖宿主闭包渲染 unified diff`);
  }
  const hostMajor = Number.parseInt(String(JSON.parse(readFileSync(hostDiff, 'utf8')).version).split('.')[0], 10);
  if (hostMajor !== HOST_DIFF_MAJOR) {
    throw new Error(`204-plugin-git: 载荷顶层 diff 主版本为 ${hostMajor}，插件按 ${HOST_DIFF_MAJOR} 编写`);
  }
}

/** 本工程维护的 seam 插件包（packages/<name>-ohos/）物化为 @dsh-ohos/<name>。 */
function collectOhosPackages(stage) {
  const destRoot = resolve(stage, 'node_modules/@dsh-ohos');
  mkdirSync(destRoot, { recursive: true });
  const copied = [];
  for (const entry of readdirSync(PACKAGES_SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(PACKAGES_SRC, entry.name);
    const manifestPath = resolve(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      fail(1, `无法解析 ${manifestPath}：${error.message}`);
    }
    if (!String(manifest.name ?? '').startsWith('@dsh-ohos/')) continue;
    const short = manifest.name.slice('@dsh-ohos/'.length);
    const dest = resolve(destRoot, short);
    rmSync(dest, { recursive: true, force: true });
    cpSync(dir, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => !src.includes(`${sep}node_modules`) && !src.includes(`${sep}test`),
    });
    if (manifest.dsh && manifest.dsh.bundle) {
      // 纯 YAML 覆盖层：没有 JS 入口，断言声明的 patch 文件存在即可。
      const patch = (manifest.dsh.bundle.patch ?? ['./cordis.patch.yml'])[0];
      if (!existsSync(resolve(dest, patch))) {
        fail(1, `bundle 包 ${manifest.name} 缺少 ${patch}`);
      }
    } else {
      const main = manifest.main ?? 'lib/index.js';
      if (!existsSync(resolve(dest, main))) {
        fail(1, `插件包 ${manifest.name} 缺少入口 ${main}`);
      }
    }
    copied.push(manifest.name);
  }
  return copied;
}

/** bundle 覆盖层里插入的每一行都必须能解析；解析不到就中止（FR-105-005）。 */
function assertInsertedRowsResolve(stage) {
  const patchPath = resolve(PACKAGES_SRC, 'bundle-ohos/cordis.patch.yml');
  if (!existsSync(patchPath)) fail(2, `缺少 bundle 覆盖层：${patchPath}`, '检查 packages/bundle-ohos/');
  const text = readFileSync(patchPath, 'utf8');
  const names = [...text.matchAll(/^\s*-?\s*name:\s*'?(@[^'\s]+)'?\s*$/gm)].map((m) => m[1]);
  const missing = [];
  for (const name of [...new Set(names)]) {
    const target = resolve(stage, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(target)) missing.push(name);
  }
  if (missing.length > 0) {
    fail(1, `bundle 插入行无法解析：${missing.join(', ')}`, '先装配这些包，或从覆盖层移除该行');
  }
  return [...new Set(names)];
}

function countTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (current, depth) => {
    if (depth > 24) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else {
        files += 1;
        try {
          bytes += lstatSync(full).size;
        } catch {
          // 读不到大小的条目不影响文件计数
        }
      }
    }
  };
  walk(dir, 0);
  return { files, bytes };
}

function assertNoLinks(stage) {
  const links = [];
  const walk = (current, depth) => {
    if (depth > 12 || links.length > 5) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (isSymlink(full)) links.push(full);
      else if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(stage, 0);
  if (links.length > 0) {
    fail(1, `载荷仍含链接（设备上无 symlink/hardlink）：${links.slice(0, 5).join(', ')}`);
  }
}

/** 待装配的输入是否成立；不成立时给出下一步命令。 */
function assertDeployInputs() {
  if (!existsSync(resolve(DSH_ROOT, 'package.json'))) {
    fail(2, `上游未找到：${DSH_ROOT}`, 'git clone --branch dsh-v0.2.1-rc.2 https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness');
  }
  const cliBin = resolve(DSH_ROOT, 'apps/cli/lib/bin.js');
  const sampleLib = resolve(DSH_ROOT, 'packages/core/agent/lib/index.js');
  const webDist = resolve(DSH_ROOT, 'apps/web/dist/index.html');
  const missing = [];
  if (!existsSync(cliBin)) missing.push('apps/cli/lib/bin.js（CLI/Host 产物）');
  if (!existsSync(sampleLib)) missing.push('packages/core/agent/lib（包产物）');
  if (!existsSync(webDist)) missing.push('apps/web/dist/index.html（Web UI 产物）');
  if (missing.length > 0) {
    fail(
      2,
      `上游未构建完整：缺少 ${missing.join('、')}`,
      'cd ../deepseek-harness && CI=true pnpm run build:lib:host && pnpm run build:lib:client && pnpm run build:web',
    );
  }
}

function deployTree() {
  assertDeployInputs();
  const target = resolve(WORK, 'dsh');
  // 复用上一次物化结果（`--fresh` 可强制重跑 pnpm deploy）。
  //
  // 注意：**复用也要重跑“摊平三件套”**。中断过的 run 会留下半成品树
  // （`.pnpm` 与 junction 都在），而后续剪裁只删 `.pnpm` 之外的平台包、
  // 不做链接物化 ⇒ 复用时若不重跑，装配会在 `assertNoLinks` 处失败。
  // 三步都是幂等的：已物化的目录会被跳过，已摊平的依赖会被去重。
  if (existsSync(target) && !flag('--fresh')) {
    log(`复用物化树：${target}（--fresh 可重跑 pnpm deploy）`);
  } else {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    run(`pnpm --filter @deepseek-ai/dsh deploy --legacy "${target}"`, DSH_ROOT);
  }

  const linked = materializeLinks(resolve(target, 'node_modules'), 0, []);
  log(`物化链接 ${linked.length} 处`);

  const workspacePackages = collectWorkspacePackages(target);
  log(`补全 @deepseek-ai 包 ${workspacePackages.length} 个`);

  const flat = collectNonHoistedDeps(target);
  log(`补全非 hoisted 依赖 ${flat.length} 个`);

  const store = resolve(target, 'node_modules/.pnpm');
  if (existsSync(store)) rmSync(store, { recursive: true, force: true });
  const webDist = resolve(DSH_ROOT, 'apps/web/dist');
  const webFrontend = resolve(target, 'node_modules/@deepseek-ai/dsh-web-frontend/dist');
  if (!existsSync(webDist)) fail(2, `缺少 Web UI 产物：${webDist}`, '在 ../deepseek-harness 执行 pnpm run build:web');
  rmSync(webFrontend, { recursive: true, force: true });
  cpSync(webDist, webFrontend, { recursive: true });
  log('Web UI dist 已注入 dsh-web-frontend/dist');
  return target;
}

function adoptTree(source) {
  const from = resolve(source);
  if (!existsSync(from)) fail(2, `--from 目录不存在：${from}`, '传入已构建的 dsh 运行树，或改用 --deploy');
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const target = resolve(WORK, 'dsh');
  cpSync(from, target, { recursive: true, dereference: true });
  log(`已采用外部运行树：${from}`);
  return target;
}

/**
 * 垫片 S6：把上游 `node-addon-require-builtin`（原生 NAPI addon，无 OHOS 目标）
 * 替换为纯 JS 实现——`payload/shims/require-builtin.js`。
 *
 * 依据：该 addon 只提供"读 Node 内部模块"的能力，运行时带 `--expose-internals` 时
 * `require('internal/…')` 等价可得（OHOS 运行时 v24.2.0 实测可用）。
 * 上游包版本记进 `package.json` 的 `upstreamVersion`，便于升级时对账。
 */
function installRequireBuiltinShim(stage) {
  const shimSource = resolve(ROOT, 'payload/shims/require-builtin.js');
  if (!existsSync(shimSource)) fail(2, `缺少垫片源码：${shimSource}`);
  const dest = resolve(stage, 'node_modules/node-addon-require-builtin');
  if (!existsSync(dest)) {
    fail(1, `载荷里没有 node-addon-require-builtin：${dest}`, '检查 deploy 是否完整（app-boot 依赖它）');
  }
  let upstreamVersion = '';
  try {
    upstreamVersion = String(JSON.parse(readFileSync(resolve(dest, 'package.json'), 'utf8')).version ?? '');
  } catch {
    upstreamVersion = '';
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(resolve(dest, 'lib'), { recursive: true });
  writeFileSync(
    resolve(dest, 'package.json'),
    `${JSON.stringify(
      {
        name: 'node-addon-require-builtin',
        version: upstreamVersion === '' ? '0.1.9' : upstreamVersion,
        type: 'commonjs',
        description: 'OHOS shim S6: pure JS replacement for the native require-builtin addon (needs --expose-internals).',
        main: 'lib/index.js',
        exports: {
          '.': { import: './lib/index.js', require: './lib/index.js', default: './lib/index.js' },
          './package.json': './package.json',
        },
        license: 'MIT',
        dshOhosShim: 'S6',
        upstreamVersion,
      },
      null,
      2,
    )}\n`,
  );
  cpSync(shimSource, resolve(dest, 'lib/index.js'));
  log(`垫片 S6：node-addon-require-builtin → 纯 JS（upstreamVersion=${upstreamVersion || 'unknown'}）`);
  return dest;
}

function overlay(stage) {
  const profileDest = resolve(stage, 'profiles/ohos');
  rmSync(profileDest, { recursive: true, force: true });
  cpSync(PROFILE_SRC, profileDest, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(profileDest, 'package.json'), 'utf8'));
  const bundles = manifest?.dsh?.profile?.bundles ?? [];
  if (!bundles.includes('@dsh-ohos/bundle')) {
    fail(1, `profile 清单未包含 @dsh-ohos/bundle：${profileDest}/package.json`);
  }
  log(`profile 已注入：profiles/ohos（${bundles.length} 个 bundle）`);

  const plugins = collectOhosPackages(stage);
  log(`seam 插件已注入：${plugins.length} 个（${plugins.join(', ')}）`);

  // 204-plugin-git：isomorphic-git 闭包必须物化在插件自己的 node_modules 下（见 collectGitRuntime）。
  // 顺序不能反 —— 它要求 @dsh-ohos/git 目录已存在。
  try {
    collectGitRuntime(stage);
  } catch (error) {
    fail(1, `204-plugin-git 运行时物化失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 012-pnpm-integration：纯 JS pnpm 引擎必须随包（设备既无 pnpm 二进制，也不能 spawn 子进程）。
  try {
    collectMarketPNPM(stage);
  } catch (error) {
    fail(1, `012-pnpm-integration 物化失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 201-dsh-market：插件市场产物（host half + client half + 运行时依赖闭包）。
  try {
    collectDshMarket(stage);
  } catch (error) {
    fail(1, `201-dsh-market 物化失败：${error instanceof Error ? error.message : String(error)}`);
  }

  installRequireBuiltinShim(stage);
  try {
    applyFlockShim(stage, log);
  } catch (error) {
    fail(1, `垫片 S3 安装失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    applySharpShim(stage, log);
  } catch (error) {
    fail(1, `垫片 S4 安装失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    applyAttachmentDurabilityPatch(stage, log);
  } catch (error) {
    fail(1, `补丁 S5 安装失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertStage(stage) {
  const checks = [];
  const dshManifest = resolve(stage, 'node_modules/@deepseek-ai/dsh/package.json');
  checks.push(['@deepseek-ai/dsh 存在', existsSync(dshManifest)]);
  checks.push([
    'Web UI dist 存在',
    existsSync(resolve(stage, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html')),
  ]);
  checks.push(['profiles/ohos 存在', existsSync(resolve(stage, 'profiles/ohos/package.json'))]);
  const rows = noOverlay ? [] : assertInsertedRowsResolve(stage);
  checks.push([`bundle 插入行可解析（${rows.length} 行）`, true]);
  assertNoLinks(stage);
  checks.push(['无 symlink/hardlink', true]);

  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) fail(1, `载荷断言失败：${failed.join('、')}`);
  for (const [name] of checks) log(`✓ ${name}`);
}

function applyStage(stage) {
  const size = countTree(stage);
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(resolve(STAGE, '..'), { recursive: true });
  renameSync(stage, STAGE);
  writeFileSync(
    resolve(STAGE, '..', 'assemble.json'),
    `${JSON.stringify(
      {
        schema: 1,
        source: fromDir ? 'from' : 'deploy',
        files: size.files,
        bytes: size.bytes,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  log(`已落地：${STAGE}（${size.files} 文件 / ${(size.bytes / 1048576).toFixed(1)} MiB）`);
  log('下一步：node scripts/package-payload.mjs（生成 dsh.tar.gz 与 dsh.version）');
}

function main() {
  const modeCount = [deploy, fromDir !== undefined, reuse].filter(Boolean).length;
  if (modeCount === 0) {
    log('dry-run：未指定输入，只打印计划');
    log('  真实物化：node scripts/assemble-payload.mjs --deploy --apply');
    log('  采用外部树：node scripts/assemble-payload.mjs --from <已构建 dsh 树> --apply');
    log('  就地重跑覆盖层：node scripts/assemble-payload.mjs --reuse --apply');
    log(`  目标：${STAGE}`);
    process.exit(0);
  }
  if (modeCount > 1) fail(2, '--deploy / --from / --reuse 互斥', '只选一个输入');

  if (reuse) {
    if (!existsSync(resolve(STAGE, 'node_modules/@deepseek-ai/dsh/package.json'))) {
      fail(2, `--reuse 需要一份已装配的 stage：${STAGE}`, '先跑一次 --deploy 或 --from');
    }
    // 就地重跑：stage 就是 STAGE，覆盖层直接写进去（没有「staging → 落盘」这一步）。
    log(`复用现有 stage（就地重跑覆盖层）：${STAGE}`);
    prunePayload(STAGE);
    if (!noOverlay) overlay(STAGE);
    assertStage(STAGE);
    if (!apply) log('提示：--reuse 是就地写入，--apply 对它没有额外作用');
    log('下一步：node scripts/package-payload.mjs（生成 dsh.tar.gz 与 dsh.version）');
    return;
  }

  const stage = fromDir ? adoptTree(fromDir) : deployTree();
  // 剪裁先于覆盖层：插件包与 profile 不参与剪裁规则
  prunePayload(stage);
  if (!noOverlay) overlay(stage);
  assertStage(stage);
  if (apply) applyStage(stage);
  else log('dry-run：未加 --apply，弃用本次装配结果（不写 build/payload-stage）');
}

main();
