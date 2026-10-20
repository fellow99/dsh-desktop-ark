/**
 * 载荷物化期的垫片安装器（可被 assemble / package 两条链路复用）。
 *
 * 目前只有 S3：`@deepseek-ai/node-addon-system/flock` 的单进程替身。
 * 为什么不放运行时：这是**文件替换**而不是模块 hook —— 可审计（文件里有标记）、
 * 对 ESM/CJS 都生效、且与 S6 的落点（同名包替换）保持一致。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MARKER = 'DSH_OHOS_FLOCK_STUB';
const SOURCE = join(ROOT, 'payload/shims/node-addon-system-flock.js');
const SHARP_SOURCE = join(ROOT, 'payload/shims/sharp');

/**
 * 把载荷里的 `node-addon-system/lib/flock.js` 换成单进程替身（幂等）。
 * @param {string} stage - 运行树根（含 node_modules）
 * @param {(line: string) => void} [log]
 * @returns {string} 被替换文件的路径
 */
export function applyFlockShim(stage, log = () => {}) {
  const dest = join(stage, 'node_modules/@deepseek-ai/node-addon-system/lib/flock.js');
  if (!existsSync(SOURCE)) throw new Error(`缺少 S3 垫片源码：${SOURCE}`);
  if (!existsSync(dest)) throw new Error(`载荷里没有 node-addon-system/lib/flock.js：${dest}`);

  if (readFileSync(dest, 'utf8').includes(MARKER)) {
    log('垫片 S3：flock 已是单进程替身（幂等）');
    return dest;
  }

  // 留一份上游原件便于升级对账（只写一次）。
  const backup = join(dirname(dest), 'flock.upstream.js');
  if (!existsSync(backup)) copyFileSync(dest, backup);
  writeFileSync(dest, readFileSync(SOURCE, 'utf8'));
  if (!readFileSync(dest, 'utf8').includes(MARKER)) {
    throw new Error(`S3 替换后标记缺失：${dest}`);
  }
  log('垫片 S3：node-addon-system/flock → 单进程替身（上游备份 flock.upstream.js）');
  return dest;
}

/**
 * 把载荷里的 `node_modules/sharp` 换成同名包替身（S4）。
 *
 * 上游 `attachment-local` 用 `require('sharp')` 懒加载、没有注入点；只有同名的
 * `node_modules/sharp` 能覆盖到它。替身本体是 `@dsh-ohos/attachment-image`
 * （纯 JS 头解析 + 像素操作走宿主桥 `image.normalize`），这里放一个 CJS 包装入口。
 * @param {string} stage
 * @param {(line: string) => void} [log]
 * @returns {string}
 */
export function applySharpShim(stage, log = () => {}) {
  const dest = join(stage, 'node_modules/sharp');
  const manifestPath = join(dest, 'package.json');
  if (!existsSync(join(SHARP_SOURCE, 'index.cjs')) || !existsSync(join(SHARP_SOURCE, 'package.json'))) {
    throw new Error(`缺少 S4 垫片源码：${SHARP_SOURCE}`);
  }

  let upstreamVersion = '';
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.dshOhosShim === 'S4') {
        log('垫片 S4：sharp 已是纯 JS 替身（幂等）');
        return dest;
      }
      upstreamVersion = String(manifest.version ?? '');
    } catch {
      upstreamVersion = '';
    }
  }

  const backup = join(stage, 'node_modules', 'sharp.upstream');
  if (existsSync(dest)) {
    if (!existsSync(backup)) renameSync(dest, backup);
    else rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });
  cpSync(SHARP_SOURCE, dest, { recursive: true });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.upstreamVersion = upstreamVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
  if (!existsSync(join(dest, 'index.cjs'))) throw new Error(`S4 替换后入口缺失：${dest}`);
  log(`垫片 S4：sharp → @dsh-ohos/attachment-image（upstreamVersion=${upstreamVersion || 'unknown'}）`);
  return dest;
}

/**
 * 物化期补丁 S5：让 `dsh-attachment-local` 的目录持久性证明在 OHOS 沙箱边界**降级**。
 *
 * 上游 `ensureDurableDirectory()` 会从目标目录逐级 `fsync` 到 `/`；OHOS 上应用**不能**
 * open 祖先目录（`/data/storage/el2` → EACCES），于是 **任何图片附件**在首次发布时都会
 * 失败（实测：`session/agent-busy` 的 details 里是 `EACCES: permission denied, open
 * '/data/storage/el2'`）。
 *
 * 补丁只做一件事：把 `syncDirectory(parent)` 换成 best-effort —— EACCES/EPERM 记一条
 * stderr 后继续，其它错误照常抛。文件本身的 fsync 与内容寻址校验都不受影响。
 * 目标文件带 `DSH_OHOS_SYNC_DIR_BEST_EFFORT` 标记，便于升级对账；找不到锚点即报错。
 * @param {string} stage
 * @param {(line: string) => void} [log]
 * @returns {string}
 */
export function applyAttachmentDurabilityPatch(stage, log = () => {}) {
  const file = join(stage, 'node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js')
  if (!existsSync(file)) throw new Error(`载荷里没有 dsh-attachment-local：${file}`)
  const text = readFileSync(file, 'utf8')
  const MARK = 'DSH_OHOS_SYNC_DIR_BEST_EFFORT'
  if (text.includes(MARK)) {
    log('补丁 S5：附件目录持久性证明已是 best-effort（幂等）')
    return file
  }
  const anchor = 'await syncDirectory(parent);'
  const occurrences = text.split(anchor).length - 1
  if (occurrences !== 1) throw new Error(`S5 锚点不唯一或缺失（${occurrences}）：${anchor}`)
  const patched = text.replace(anchor, 'await syncDirectoryBestEffort(parent);') + String.fromCharCode(10) + `
/** ${MARK}: OHOS 沙箱不能 fsync 祖先目录（/data/storage/el2 → EACCES）⇒ 边界处降级。 */
async function syncDirectoryBestEffort(dir) {
  try {
    await syncDirectory(dir);
  } catch (error) {
    const code = error && error.code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
    if (!globalThis.${MARK}_WARNED) {
      globalThis.${MARK}_WARNED = true;
      console.error('[ohos] syncDirectory at sandbox boundary skipped: ' + dir + ' (' + code + ')');
    }
  }
}
`
  writeFileSync(file, patched)
  if (!readFileSync(file, 'utf8').includes(MARK)) throw new Error(`S5 补丁后标记缺失：${file}`)
  log('补丁 S5：dsh-attachment-local 目录 fsync 改为沙箱边界 best-effort')
  return file
}

/**
 * 把 `packages/*-ohos` 的源码同步进载荷的 `node_modules/@dsh-ohos/<name>`。
 *
 * 为什么需要：`assemble-payload` 的 overlay 只在**重新装配**时做这一步，而日常
 * `build-hap.sh` 只跑 `sync-payload` + `package-payload`。少了这一步，改过的插件
 * （例如这次的 host-bridge / attachment-image）会留在源码里、归档仍是旧版本 ——
 * 实测踩到：修好 `image.normalize` 后设备仍跑旧包。
 * @param {string} root - 工程根（含 packages/）
 * @param {string} stage
 * @param {(line: string) => void} [log]
 * @returns {string[]} 同步的包名
 */
export function syncOhosPackages(root, stage, log = () => {}) {
  const src = join(root, 'packages')
  if (!existsSync(src)) return []
  const synced = []
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('-ohos')) continue
    const dir = join(src, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const name = typeof manifest.name === 'string' ? manifest.name : ''
    if (!name.startsWith('@dsh-ohos/')) continue
    const dest = join(stage, 'node_modules', name)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    cpSync(manifestPath, join(dest, 'package.json'))
    if (existsSync(join(dir, 'lib'))) cpSync(join(dir, 'lib'), join(dest, 'lib'), { recursive: true })
    if (existsSync(join(dir, 'cordis.patch.yml'))) cpSync(join(dir, 'cordis.patch.yml'), join(dest, 'cordis.patch.yml'))
    synced.push(name)
  }
  if (synced.length > 0) log(`seam 插件已同步：${synced.length} 个（${synced.join(', ')}）`)
  return synced
}

export { MARKER as FLOCK_STUB_MARKER, SHARP_SOURCE };
