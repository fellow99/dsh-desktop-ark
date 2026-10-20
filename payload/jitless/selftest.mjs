#!/usr/bin/env node
/**
 * payload/jitless/selftest.mjs —— 109-jitless 的双形态自检（PC 侧）
 *
 * 用法：
 *   node --jitless payload/jitless/selftest.mjs   # 目标臂：WASM 缺失，兼容层必须接管
 *   node          payload/jitless/selftest.mjs   # 对照臂：WASM 可用，兼容层必须零动作
 *
 * 断言（两臂都跑）：
 *   1) installIfNeeded 的 active 与 typeof WebAssembly 一致；第二次调用幂等（同一对象）；
 *   2) 功能性用例（GET/POST JSON/SSE/Abort/FormData/惰性 getter 封印）全过；
 *   3) 对照臂额外断言：globalThis.fetch 保持原生（未安装垫片）。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const { installIfNeeded } = require(join(HERE, 'index.js'));
const { shimFetch } = require(join(HERE, 'fetch-shim.js'));
const { runSelfCheck } = require(join(HERE, 'selfcheck.js'));

const wasmDefined = typeof WebAssembly !== 'undefined';
const label = wasmDefined ? 'jit（对照臂：WASM 可用）' : 'compat（目标臂：WASM 缺失）';
const failures = [];

function check(ok, message) {
  if (!ok) failures.push(message);
  console.log(`[selftest] ${ok ? 'ok  ' : 'FAIL'} ${message}`);
}

console.log(`[selftest] 形态：${label}`);

const first = installIfNeeded((line) => console.log(line));
const second = installIfNeeded((line) => console.log(line));

check(first.active === !wasmDefined, `active=${String(first.active)} 与 WASM=${wasmDefined ? 'defined' : 'undefined'} 匹配`);
check(first === second, 'installIfNeeded 幂等（第二次返回同一对象）');

if (wasmDefined) {
  check(first.fetch === 'kept', `对照臂 fetch=${first.fetch}（应为 kept）`);
  check(first.fetchImpl === null, '对照臂没有接管 fetchImpl');
  check(first.httpLazy === 'kept' && first.sealed.length === 0, '对照臂没有封印任何惰性 getter');
} else {
  check(first.fetch === 'installed', `目标臂 fetch=${first.fetch}（应为 installed）`);
  check(typeof first.fetchImpl === 'function', '目标臂 fetchImpl 是函数');
  check(first.httpLazy === 'installed', `目标臂 httpLazy=${first.httpLazy}（应为 installed）`);
  check(first.sealed.includes('maxHeaderSize') && first.sealed.includes('globalAgent'),
    `封印清单含 maxHeaderSize/globalAgent：${first.sealed.join(',')}`);
}

const result = await runSelfCheck((line) => console.log(line), { budgetMs: 4000 });
check(result.status === 'ok', `回环自检（全局 fetch） ${result.status}（${result.cases.filter((c) => c.ok).length}/${result.cases.length}）`);

// 无论哪一臂都直连 shimFetch 再跑一轮：把「垫片实现」与「全局接管」分开取证。
const direct = await runSelfCheck((line) => console.log(line), { fetch: shimFetch, budgetMs: 4000 });
check(direct.status === 'ok', `回环自检（shimFetch 直连） ${direct.status}（${direct.cases.filter((c) => c.ok).length}/${direct.cases.length}）`);

if (wasmDefined) {
  // 对照臂：原生 fetch 必须仍然可用（兼容层不能把原生实现顶掉）
  const nativeOk = await (async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => res.end('native'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.address().port)}/`);
      return (await response.text()) === 'native';
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  })();
  check(nativeOk, '对照臂原生 fetch 仍可用（未被垫片接管）');
}

if (failures.length > 0) {
  console.error(`[selftest] FAILED：${failures.length} 项`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('[selftest] PASS');
