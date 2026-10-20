#!/usr/bin/env node
/**
 * 204-plugin-git：设置「真机取证用 Node inspector 端口」（**编译期**常量）。
 *
 *   node scripts/set-inspect.mjs 19229   # debug：进程内 Node 带 --inspect=127.0.0.1:19229
 *   node scripts/set-inspect.mjs 0       # release：关闭（默认）
 *
 * 为什么是脚本而不是运行期开关：`--inspect` 是进程级参数，运行期改不了（同 109-jitless 的
 * `--jitless`）。源码里的常量**默认是 0**，由 `build-hap.sh` 按构建类型改写，因此
 * 「提交里永远不开调试口」，而 release 构建不依赖任何人记得手动改回。
 *
 * 纪律（同 `set-node-mode.mjs`）：先算后写、幂等、保留行尾风格。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUILD_CONFIG = join(ROOT, 'entry/src/main/ets/common/BuildConfig.ets');
const PATTERN = /export const INSPECT_PORT: number = (\d+);/;

const raw = process.argv[2];
if (raw === undefined) {
  console.error('[set-inspect] 用法：node scripts/set-inspect.mjs <port>（0 = 关闭）');
  process.exit(2);
}
const port = Number(raw);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`[set-inspect] 非法端口：${raw}（合法范围 0…65535）`);
  process.exit(2);
}

const text = readFileSync(BUILD_CONFIG, 'utf8');
const match = PATTERN.exec(text);
if (match === null) {
  console.error(`[set-inspect] 在 ${BUILD_CONFIG} 里找不到 INSPECT_PORT 常量声明`);
  process.exit(1);
}
if (Number(match[1]) === port) {
  console.log(`[set-inspect] 已是 ${port}（幂等，未写文件）`);
  process.exit(0);
}
writeFileSync(BUILD_CONFIG, text.replace(PATTERN, `export const INSPECT_PORT: number = ${port};`));
console.log(`[set-inspect] INSPECT_PORT: ${match[1]} → ${port}${port === 0 ? '（关闭）' : '（仅回环，需 hdc fport）'}`);
