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
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFlockShim, applySharpShim, applyAttachmentDurabilityPatch } from './lib/payload-shims.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DSH_ROOT = resolve(ROOT, '../deepseek-harness');
const STAGE = resolve(ROOT, 'build/payload-stage/dsh');
const WORK = resolve(ROOT, 'build/payload-stage/.work');
const PROFILE_SRC = resolve(ROOT, 'profiles/ohos');
const PACKAGES_SRC = resolve(ROOT, 'packages');

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
  if (!deploy && !fromDir) {
    log('dry-run：未指定输入，只打印计划');
    log('  真实物化：node scripts/assemble-payload.mjs --deploy --apply');
    log('  采用外部树：node scripts/assemble-payload.mjs --from <已构建 dsh 树> --apply');
    log(`  目标：${STAGE}`);
    process.exit(0);
  }
  if (deploy && fromDir) fail(2, '--deploy 与 --from 互斥', '只选一个输入');

  const stage = fromDir ? adoptTree(fromDir) : deployTree();
  // 剪裁先于覆盖层：插件包与 profile 不参与剪裁规则
  prunePayload(stage);
  if (!noOverlay) overlay(stage);
  assertStage(stage);
  if (apply) applyStage(stage);
  else log('dry-run：未加 --apply，弃用本次装配结果（不写 build/payload-stage）');
}

main();
