/*
 * 来源：pi-desktop-ark/payload/jitless/http-lazy-undici.js（需求 108-jitless，已量产）
 * 本工程（109-jitless）复用该实现；未做行为改动。
 * 归属与维护：两工程同源；改动请同时回写两侧，避免分叉。
 */

'use strict';
/*
 * 封印 `node:http` / `node:https` 上的**惰性 getter**（需求 108-jitless）
 *
 * 【问题（真机栈帧）】`at lazyUndici (node:http:123:21)`。Node 22+ 把一部分 `node:http`
 * 导出改成了**惰性 getter**，第一次访问才 `require('internal/deps/undici/undici')`。
 * jitless 下 WASM 不可用，而这条路正是 undici（WASM 版 llhttp）初始化的入口之一。
 *
 * 【做法】在任何人访问之前，把每个 getter 用 `Object.defineProperty` 换成**普通值属性**，
 * 那条惰性路径就再也走不到了。**不能先读原值**：读一下就触发初始化 —— 只能先看描述符
 * （`Object.getOwnPropertyDescriptor`），确认 `desc.get` 存在再改写。
 *
 * 【为什么只在 WASM 缺失时封】封 getter 会**反噬原生实现**：`maxHeaderSize` 被换成 `{}` 后，
 * 原生 undici 直接报 `http module not available or http.maxHeaderSize invalid`，
 * 也就是"PC 侧（有 WASM）反而 fetch 全挂"。端侧永远是 jitless，所以这个条件对真机零影响；
 * 函数内部再自检一次（调用方忘了判也不会误封）。
 *
 * 【与参考实现的两处有意差异（都是本机 Node v24.7.0 实测换来的）】
 *
 * ① `globalAgent` **不能**换成 `{}`：
 *      把 `https.globalAgent` 换成 `{}` 之后，`https.request(...)` 直接抛
 *      `TypeError: Protocol "https:" not supported. Expected "undefined"` ——
 *      因为 `node:https` 的 `request` 会把模块上的 `globalAgent` 当作 `_defaultAgent`，
 *      而那个对象的 `protocol` 正是 `"https:"`。http 侧不受影响（http 的 ClientRequest 用的是
 *      `lib/_http_agent.js` 里的全局实例，不读模块属性）。
 *    处置：这一项换成**同模块 `Agent` 的实例**（`new mod.Agent()`）——`Agent` 本身不是惰性
 *    getter、是纯 JS、不碰 WASM；既保住 https 的默认 agent，又掐断了惰性访问路径。
 *    若该模块没有可用的 `Agent` 构造器（版本差异），退回 `{}` 并把这一项记成 `failed`。
 *
 * ② `maxHeaderSize` 换成**数值**（16 KB，Node 的默认值）而不是 `{}`：
 *      它是给 undici 的 `Client` 读的，`{}` 会让 `new Client()/new EnvHttpProxyAgent()` 这类
 *      在 jitless 下**本来可以构造**的对象开始报错。换成等价数值既保住可构造性，也不触发惰性。
 *
 * 其余（`WebSocket` / `CloseEvent` / `MessageEvent` 等）仍按参考实现换成 `{}`：它们只是全局
 * 接口的转出点，没人会拿它们当对象用。
 */

const NOOP = () => {};
const LOG_PREFIX = '[jitless]';

/** Node 默认的 `http.maxHeaderSize`（16 KB）；用数值占位见文件头 ②。 */
const DEFAULT_MAX_HEADER_SIZE = 16 * 1024;

/**
 * 给一个惰性 getter 选占位值。
 *
 * @param {string} name 属性名
 * @param {object} mod 模块对象
 * @returns {{kind: 'agent'|'value'|'empty', value?: any, failed?: boolean}}
 */
function placeholderFor(name, mod) {
  if (name === 'globalAgent') {
    /* 见文件头 ①：换成同模块 Agent 的真实实例，不能是 `{}`。 */
    try {
      const AgentCtor = mod.Agent;
      if (typeof AgentCtor === 'function') {
        /* Node ≥19 的 globalAgent 默认 keepAlive=true；这里必须对齐，否则 compat 下每次 fetch 都要重新握手。 */
        return { kind: 'agent', value: new AgentCtor({ keepAlive: true }) };
      }
    } catch {
      /* 拿不到 Agent（或它自己也是惰性的）⇒ 退回下面的兜底 */
    }
    return { kind: 'empty', value: {}, failed: true };
  }
  if (name === 'maxHeaderSize') {
    /* 见文件头 ②：数值占位，保住 undici 的"可构造"。 */
    return { kind: 'value', value: DEFAULT_MAX_HEADER_SIZE };
  }
  return { kind: 'empty', value: {} };
}

/**
 * 把清单挂到返回值上（非枚举，不污染"这是一个名字数组"的语义）。
 * @param {string[]} names
 * @param {'installed'|'kept'|'failed'} status
 * @param {object} detail
 */
function sealReport(names, status, detail) {
  const out = names.slice();
  Object.defineProperties(out, {
    status: { value: status, enumerable: false },
    detail: { value: detail, enumerable: false },
  });
  return out;
}

/**
 * 封印 `node:http` / `node:https` 模块对象上的所有惰性 getter。
 *
 * **只在 WASM 缺失时执行**（函数内部自检，见文件头）。幂等：二次调用时已经没有 getter，
 * 返回空清单、`status === 'installed'`。
 *
 * @param {(line: string) => void} [log] 日志回调（调用方负责落盘，本模块不写文件）
 * @returns {string[]} 被封印的属性名清单；清单上另挂两个非枚举字段
 *   `status`（`'installed'|'kept'|'failed'`）与 `detail`（`{sealed, kept, failed}`，元素为
 *   `"<模块>.<属性>"`）。WASM 可用时返回空清单、`status === 'kept'`。
 */
function sealHttpLazyUndici(log = NOOP) {
  const say = typeof log === 'function' ? log : NOOP;

  if (typeof WebAssembly !== 'undefined') {
    say(`${LOG_PREFIX} WASM 可用：保留 node:http/https 的惰性 getter（原生 fetch/undici 需要它们）`);
    return sealReport([], 'kept', { sealed: [], kept: [], failed: [] });
  }

  const sealed = [];
  const kept = [];
  const failed = [];

  for (const modName of ['node:http', 'node:https']) {
    let mod;
    try {
      mod = require(modName);
    } catch (error) {
      failed.push(`${modName}（无法 require：${String(error)}）`);
      say(`${LOG_PREFIX} ${modName} 无法加载，跳过封印：${String(error)}`);
      continue;
    }

    const localSealed = [];
    for (const name of Object.getOwnPropertyNames(mod)) {
      let desc;
      try {
        /* 【只读描述符，不读值】读 `mod[name]` 本身就会物化惰性 getter（见文件头）。 */
        desc = Object.getOwnPropertyDescriptor(mod, name);
      } catch {
        continue;
      }
      if (desc === undefined || typeof desc.get !== 'function') continue;

      const placeholder = placeholderFor(name, mod);
      try {
        Object.defineProperty(mod, name, {
          value: placeholder.value,
          writable: true,
          configurable: true,
          enumerable: desc.enumerable === true,
        });
        sealed.push(name);
        localSealed.push(`${name}(${placeholder.kind})`);
        if (placeholder.failed === true) {
          failed.push(`${modName}.${name}（只能换成 {}：模块没有可用的 Agent 构造器）`);
        }
      } catch (error) {
        failed.push(`${modName}.${name}（${String(error)}）`);
      }
    }

    if (localSealed.length === 0) {
      kept.push(`${modName}（无惰性 getter）`);
      say(`${LOG_PREFIX} ${modName} 上没有任何惰性 getter，跳过`);
    } else {
      say(`${LOG_PREFIX} ${modName} 的惰性 getter 已封印：${localSealed.join(', ')}`);
    }
  }

  const status = failed.length > 0 ? 'failed' : 'installed';
  return sealReport(sealed, status, { sealed: sealed.slice(), kept, failed });
}

module.exports = { sealHttpLazyUndici, DEFAULT_MAX_HEADER_SIZE };
