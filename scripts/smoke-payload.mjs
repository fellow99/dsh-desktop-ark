'use strict';
/**
 * 载荷树冒烟：用宿主 Node 直接验证装配出来的运行树能被上游加载。
 *
 * 只做「加载 + 组装」，不 bind 端口、不依赖 OHOS：
 *   1) createRequire 指向载荷里的 @deepseek-ai/dsh；
 *   2) 解析 @deepseek-ai/dsh-app-boot / dsh-profile-boot；
 *   3) loadProfileDirectory('dsh', <stage>/profiles/ohos, manifest) + reportSkippedBundles；
 *   4) 打印 profile 的 bundle 顺序与解析出的行数，断言 @dsh-ohos/* 行都在。
 *
 * 用法：node scripts/smoke-payload.mjs [stageDir]
 * 退出码：0 通过；1 断言失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const stage = path.resolve(process.argv[2] || path.join(HERE, '..', 'build', 'payload-stage', 'dsh'));
const manifest = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
function fail(message) {
  console.error(`[smoke-payload] FAIL ${message}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(manifest)) fail(`缺少 ${manifest}`);
  const requireFromStage = createRequire(manifest);

  const appBootPath = requireFromStage.resolve('@deepseek-ai/dsh-app-boot');
  const profileBootPath = requireFromStage.resolve('@deepseek-ai/dsh/profile-boot');

  return (async () => {
    const appBoot = await import(pathToFileURL(appBootPath).href);
    const profileBoot = await import(pathToFileURL(profileBootPath).href);
    console.log(`[smoke-payload] app-boot=${appBootPath}`);
    console.log(`[smoke-payload] profile-boot=${profileBootPath}`);

    const profileDir = path.join(stage, 'profiles', 'ohos');
    const profile = appBoot.loadProfileDirectory('dsh', profileDir, manifest);
    appBoot.reportSkippedBundles('dsh', profile);

    // profile 是 { name, dir, layers:[{patchPaths, patches}], patchPath, patches, skippedBundles }；
    // 每个 patch 元素是一个操作：{insert:[行]} 或 {id, disabled?, config?}。
    const flatten = (operations) => {
      const rows = [];
      const disabledIds = [];
      for (const op of operations) {
        if (op && Array.isArray(op.insert)) rows.push(...op.insert);
        else if (op && typeof op.id === 'string') {
          rows.push(op);
          if (op.disabled === true) disabledIds.push(op.id);
        }
      }
      return { rows, disabledIds };
    };

    const allOperations = [
      ...(profile.patches ?? []),
      ...(profile.layers ?? []).flatMap((layer) => layer.patches ?? []),
    ];
    const { rows, disabledIds } = flatten(allOperations);
    const ids = rows.map((row) => row && row.id).filter(Boolean);
    console.log(`[smoke-payload] 层数=${(profile.layers ?? []).length} 行数=${ids.length}`);
    console.log(`[smoke-payload] 禁用行：${disabledIds.join(', ') || '(none)'}`);

    const required = [
      'subprocess-ohos',
      'sandbox-ohos',
      'shell-ohos',
      'workspace-picker',
      'notify-ohos',
      'facts-ohos',
    ];
    const missing = required.filter((id) => !ids.includes(id));
    if (missing.length > 0) fail(`profile 缺少插入行：${missing.join(', ')}`);

    const mustDisable = ['hmr', 'subprocess', 'sandbox', 'bash-sandbox', 'directory-picker', 'open-in-app'];
    const notDisabled = mustDisable.filter((id) => !disabledIds.includes(id));
    if (notDisabled.length > 0) fail(`这些行应被覆盖层禁用但没有：${notDisabled.join(', ')}`);

    const ohos = ids.filter((id) => String(id).includes('-ohos') || id === 'workspace-picker');
    console.log(`[smoke-payload] @dsh-ohos 行：${ohos.join(', ')}`);
    console.log('[smoke-payload] OK');
  })();
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
