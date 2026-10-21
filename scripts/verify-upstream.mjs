#!/usr/bin/env node
/**
 * 校验上游契约（宪法 C1/C12、§5.5）。
 *
 * 断言：
 *   1) `../deepseek-harness` 处于锁定的 tag；
 *   2) 上游工作区无本地改动（零补丁）；
 *   3) 我们覆盖的每个 patch id 在上游 patch 文件中存在；
 *   4) `profiles/ohos/package.json` 可解析且 bundles 有序；
 *   5) `packages/bundle-ohos` 的 `dsh.bundle.patch` 存在。
 *
 * 任一失败 → 退出码 1（不静默跳过）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const UPSTREAM = resolve(ROOT, '..', 'deepseek-harness');
const EXPECTED_TAG = 'dsh-v0.2.1-rc.2';

const problems = [];
const notes = [];

function git(args, cwd = UPSTREAM) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// 1) tag
try {
  const tag = git(['describe', '--tags']);
  if (tag !== EXPECTED_TAG) {
    problems.push(`上游 tag=${tag}，期望 ${EXPECTED_TAG}`);
  } else {
    notes.push(`upstream tag ok: ${tag}`);
  }
} catch (error) {
  problems.push(`无法读取上游 tag：${error.message}`);
}

// 2) 零补丁
try {
  const dirty = git(['status', '--porcelain']);
  if (dirty !== '') {
    problems.push(`上游工作区有本地改动：\n${dirty}`);
  } else {
    notes.push('upstream working tree clean');
  }
} catch (error) {
  problems.push(`无法读取上游状态：${error.message}`);
}

// 3) patch id 存在性
const BASE_PATCH = join(UPSTREAM, 'packages/bundle/base/cordis.patch.yml');
const WEB_PATCH = join(UPSTREAM, 'packages/bundle/web-app/cordis.patch.yml');
const required = new Map([
  [BASE_PATCH, ['hmr', 'subprocess', 'sandbox', 'sandbox-policy', 'bash-sandbox', 'session-query-sqlite']],
  [WEB_PATCH, ['directory-picker', 'open-in-app']]
]);
for (const [file, ids] of required) {
  if (!existsSync(file)) {
    problems.push(`缺少上游 patch：${file}`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const id of ids) {
    if (!new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`, 'm').test(text)) {
      problems.push(`${file} 中不存在 id=${id}（上游可能改名）`);
    }
  }
}
notes.push('patch ids checked');

// 4) profile
const PROFILE = join(ROOT, 'profiles/ohos/package.json');
try {
  const manifest = JSON.parse(readFileSync(PROFILE, 'utf8'));
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.length === 0) {
    problems.push(`${PROFILE} 缺少 dsh.profile.bundles`);
  } else {
    notes.push(`profile bundles: ${bundles.join(' -> ')}`);
  }
} catch (error) {
  problems.push(`无法解析 profile：${error.message}`);
}

// 5) bundle patch 文件存在
const BUNDLE = join(ROOT, 'packages/bundle-ohos/package.json');
try {
  const manifest = JSON.parse(readFileSync(BUNDLE, 'utf8'));
  const patches = manifest?.dsh?.bundle?.patch;
  const list = Array.isArray(patches) ? patches : [patches];
  for (const rel of list) {
    const file = join(ROOT, 'packages/bundle-ohos', rel);
    if (!existsSync(file)) {
      problems.push(`bundle patch 缺失：${file}`);
    }
  }
  notes.push(`bundle patches: ${list.length}`);
} catch (error) {
  problems.push(`无法解析 bundle：${error.message}`);
}
// 6) 品牌与首次引导（205-plugin-branding）：上游常量必须与我们的配置对齐
const UPSTREAM_ONBOARDING = join(UPSTREAM, 'packages/client/ui-settings-models/src/onboarding-copy.ts');
const BUNDLE_PATCH = join(ROOT, 'packages/bundle-ohos/cordis.patch.yml');
const BRANDING_INDEX = join(ROOT, 'packages/branding-ohos/lib/index.js');
const BRANDING_CLIENT = join(ROOT, 'packages/branding-ohos/lib/client.js');
try {
  const upstreamCopy = readFileSync(UPSTREAM_ONBOARDING, 'utf8');
  const expected = /WELCOME_NOTICE_VERSION\s*=\s*'([^']+)'/.exec(upstreamCopy)?.[1];
  const bundlePatch = readFileSync(BUNDLE_PATCH, 'utf8');
  const ours = /welcomeNoticeVersion:\s*'([^']+)'/.exec(bundlePatch)?.[1];
  if (expected === undefined) {
    problems.push(`${UPSTREAM_ONBOARDING} 中找不到 WELCOME_NOTICE_VERSION（上游可能改名或搬走）`);
  } else if (ours === undefined) {
    problems.push(`${BUNDLE_PATCH} 缺少 welcomeNoticeVersion 配置行（首次引导会重新弹出）`);
  } else if (ours !== expected) {
    problems.push(`欢迎提示版本漂移：我们的 ${ours} ≠ 上游 ${expected}（同步 ${BUNDLE_PATCH}，否则预览提示重新弹出）`);
  } else {
    notes.push(`welcome notice ack aligned: ${ours}`);
  }
  if (!/^-\s*id:\s*ui-brand-official\s*$\n\s*disabled:\s*true\s*$/m.test(bundlePatch)) {
    problems.push(`${BUNDLE_PATCH} 未禁用 ui-brand-official（上游官方品牌位可能冒出来）`);
  }
  if (!/^\s*-\s*id:\s*branding-ohos\s*$/m.test(bundlePatch) || !/name:\s*'@dsh-ohos\/branding'/.test(bundlePatch)) {
    problems.push(`${BUNDLE_PATCH} 未挂载 branding-ohos 行（本产品品牌位缺失）`);
  }
} catch (error) {
  problems.push(`无法核对品牌/引导配置：${error.message}`);
}

// 7) 品牌位的锚点属性：Host 半边下发的样式与浏览器半边的标记必须同一个值
try {
  if (!existsSync(BRANDING_INDEX) || !existsSync(BRANDING_CLIENT)) {
    problems.push('缺少 packages/branding-ohos/lib/{index,client}.js');
  } else {
    const hostAttr = /HERO_ATTR\s*=\s*'([^']+)'/.exec(readFileSync(BRANDING_INDEX, 'utf8'))?.[1];
    const browserAttr = /HERO_ATTR\s*=\s*'([^']+)'/.exec(readFileSync(BRANDING_CLIENT, 'utf8'))?.[1];
    if (hostAttr === undefined || browserAttr === undefined) {
      problems.push('branding 包缺少 HERO_ATTR 声明');
    } else if (hostAttr !== browserAttr) {
      problems.push(`branding 的 HERO_ATTR 不一致：host ${hostAttr} ≠ client ${browserAttr}（上游标语不会被隐藏）`);
    } else {
      notes.push(`branding hero anchor: ${hostAttr}`);
    }
  }
} catch (error) {
  problems.push(`无法核对品牌位锚点：${error.message}`);
}

// 8) 窗口标题：上游 `brand.localBuild` 的两种文案必须仍被我们的标题守卫覆盖
try {
  const localeDir = join(UPSTREAM, 'packages/client/locale/src/locales');
  const readBrand = (file) => /'brand\.localBuild':\s*'([^']+)'/.exec(readFileSync(join(localeDir, file), 'utf8'))?.[1];
  const upstreamTitles = [readBrand('en.ts'), readBrand('zh.ts')];
  const clientSource = readFileSync(BRANDING_CLIENT, 'utf8');
  const missing = upstreamTitles.filter((title) => title !== undefined && !clientSource.includes(title));
  if (upstreamTitles.some(title => title === undefined)) {
    problems.push(`${localeDir}/{en,zh}.ts 中找不到 brand.localBuild（上游可能改名或搬走）`);
  } else if (missing.length > 0) {
    problems.push(`标题守卫未覆盖上游文案：${missing.join(', ')}（同步 ${BRANDING_CLIENT} 的 UPSTREAM_PRODUCT_TITLES）`);
  } else {
    notes.push(`upstream window titles covered: ${upstreamTitles.join(' | ')}`);
  }
} catch (error) {
  problems.push(`无法核对窗口标题文案：${error.message}`);
}

for (const note of notes) console.log(`[verify-upstream] ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`[verify-upstream] ✗ ${problem}`);
  process.exit(1);
}
console.log('[verify-upstream] ok');
