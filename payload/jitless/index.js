'use strict';
/*
 * jitless 兼容层的唯一出口（需求 109-jitless）
 *
 * 【为什么需要这一层】OHOS 不允许 W^X 的 JIT 页 ⇒ 宿主以 `--jitless` 启动 ⇒ V8 连带关掉 WASM
 * ⇒ `WebAssembly === undefined`。于是 Node 自带 undici 全线不可用：
 *   · 原生 `fetch`（解析器是 WASM 版 llhttp）一连接就抛 `WebAssembly is not defined`；
 *   · `node:http`/`node:https` 的惰性 getter（`lazyUndici`）会把 undici 拉起来。
 * 本目录两个文件就是这两条缺口的纯 JS 补齐：`http-lazy-undici.js`（封印惰性 getter）、
 * `fetch-shim.js`（基于原生 `node:http/https` 的 fetch 实现）。
 *
 * 【判据只有一个】`typeof WebAssembly === 'undefined'`。WASM 可用时**一个动作都不做**
 * —— 有 ACL 的 jit 形态必须保持 100% 原生行为；任何"顺手装一下"都会让原生 undici 与
 * 垫片打架（`maxHeaderSize` 被换掉后原生 fetch 直接报 `http.maxHeaderSize invalid`）。
 *
 * 【调用方式】`payload/bootstrap.js` 在异常兜底之后、其它垫片之前：
 *     const { installIfNeeded } = require('./jitless');
 *     const facts = installIfNeeded(log);
 *
 * 【返回事实（结构化三态）】`installed` / `kept` / `failed`：
 *     {
 *       active: boolean,        // 兼容层是否接管（= WASM 是否缺失）
 *       webAssembly: 'undefined' | 'defined',
 *       httpLazy: 'installed' | 'kept' | 'failed',
 *       sealed: string[],       // 被封印的属性名清单
 *       fetch: 'installed' | 'kept' | 'failed',
 *       globals: { Headers: ..., Request: ..., ... },
 *       fetchImpl: Function | null,
 *     }
 * 幂等：重复调用返回**同一个对象**，不重复安装。
 *
 * 【来源】实现复用同源工程 `pi-desktop-ark/payload/jitless/`（需求 108-jitless，已量产）；
 * 本工程只去掉其「条件入口（PI_JITLESS_DIR）」耦合 —— 我们的载荷没有进程内 `undici` 消费者。
 */

/* 评审 #7：两个实现只在 compat 分支里 require —— jit 形态连模块体都不执行。 */

const LOG_PREFIX = '[jitless]';
const NOOP = () => {};

/** 幂等缓存：`null` = 还没跑过。 */
let state = null;

/** 把各阶段结果画成一行（日志里一眼能看出三态与细节）。 */
function describe(facts) {
  const globals = Object.entries(facts.globals)
    .map(([name, status]) => `${name}:${status}`)
    .join(', ');
  return `httpLazy=${facts.httpLazy}（${facts.sealed.length > 0 ? facts.sealed.join(', ') : '无'}）`
    + ` fetch=${facts.fetch}`
    + ` globals=${globals.length > 0 ? globals : '(无)'}`;
}

/**
 * 按需安装 jitless 兼容层。
 *
 * @param {(line: string) => void} [log] 日志回调（调用方负责落盘；本模块不写文件）
 * @returns {{active: boolean, webAssembly: 'undefined'|'defined', httpLazy: string, sealed: string[],
 *   fetch: string, globals: Record<string, string>, fetchImpl: Function|null}}
 */
function installIfNeeded(log = NOOP) {
  const say = typeof log === 'function' ? log : NOOP;
  if (state !== null) {
    say(`${LOG_PREFIX} 兼容层已安装过（幂等）：${describe(state)}`);
    return state;
  }

  if (typeof WebAssembly !== 'undefined') {
    say(`${LOG_PREFIX} WASM 可用：兼容层不安装（jit 形态零改动）`);
    state = {
      active: false,
      webAssembly: 'defined',
      httpLazy: 'kept',
      sealed: [],
      fetch: 'kept',
      globals: {},
      fetchImpl: null,
    };
    return state;
  }

  /*
   * 顺序是承重的：**先封 getter、再接管 fetch**。
   * 反过来的话 `installFetchShim()` 里读 `globalThis.Headers` 之类的惰性属性时，
   * 可能先把 undici 拉起来（那一步在 jitless 下的表现取决于 Node 版本：本机是"能物化、
   * 发请求才炸"，但端侧不保证）。
   */
  const { sealHttpLazyUndici } = require('./http-lazy-undici.js');
  const { installFetchShim } = require('./fetch-shim.js');
  let httpLazy = 'failed';
  let sealed = [];
  try {
    const report = sealHttpLazyUndici(say);
    // http/https 两侧同名 getter 会重复：审计只关心「哪些名字被封印」（评审 #8）
    sealed = Array.from(new Set(report));
    httpLazy = typeof report.status === 'string' ? report.status : 'installed';
    const detail = report.detail;
    if (detail !== undefined && Array.isArray(detail.failed) && detail.failed.length > 0) {
      say(`${LOG_PREFIX} 惰性 getter 封印有失败项：${detail.failed.join('；')}`);
    }
  } catch (error) {
    /* 入口脚本没有第二次机会：这里抛出去就等于宿主起不来。
     * 记一行 failed 事实，继续装 fetch —— fetch 才是"能不能调模型"的决定项。 */
    say(`${LOG_PREFIX} 封印 node:http/https 惰性 getter 失败（继续安装 fetch）：${String(error)}`);
  }

  let fetchStatus = 'failed';
  let globals = {};
  let fetchImpl = null;
  try {
    const result = installFetchShim();
    fetchStatus = result.status;
    globals = result.globals;
    fetchImpl = result.fetch === undefined ? null : result.fetch;
  } catch (error) {
    say(`${LOG_PREFIX} 安装 fetch 垫片失败：${String(error)}`);
  }

  state = {
    active: true,
    webAssembly: 'undefined',
    httpLazy,
    sealed,
    fetch: fetchStatus,
    globals,
    fetchImpl,
  };

  say(`${LOG_PREFIX} 兼容层安装完成：${describe(state)}`);
  return state;
}

module.exports = { installIfNeeded, describe };
