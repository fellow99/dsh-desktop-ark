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

for (const note of notes) console.log(`[verify-upstream] ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`[verify-upstream] ✗ ${problem}`);
  process.exit(1);
}
console.log('[verify-upstream] ok');
