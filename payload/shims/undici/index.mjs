/**
 * `undici` 的替身（ESM 入口）—— 只覆盖 dsh-market 实际使用的三个导出：
 * `Agent`、`EnvHttpProxyAgent`、`fetch`。
 *
 * 【为什么需要】`--jitless` 下 V8 关掉 WASM，而 undici 的 HTTP 解析器是 WASM 版
 * llhttp ⇒ 每次 `fetch` 都抛 `WebAssembly is not defined`（本机实测：Node v24.7.0，
 * `node --jitless` 直接 import undici 后 fetch 即失败）。dsh-market 的 `src/net.ts`
 * 是 `import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'`，
 * 全局 fetch 垫片拦不到它，因此只能在**模块层**替换这个包。
 *
 * 【实现来源】复用本工程 `payload/jitless/fetch-shim.js` 的纯 JS fetch（落在原生
 * `node:http/https` + `node:stream/web` 上）。入口路径由 `DSH_OHOS_JITLESS_ENTRY`
 * 给出（bootstrap 设置 = `<assetDir>/jitless/index.js`），同目录取 `fetch-shim.js`。
 *
 * 【语义边界】不实现 HTTP/2、连接池、`dispatcher` 语义与代理隧道：`Agent` 只是
 * 占位（市场把 dispatcher 传进来，本实现忽略）。设备上不出网代理，够用；如实登记在
 * `packages/market-ohos/README*.md`。
 *
 * @module undici（DSH OHOS 替身）
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const requireFromHere = createRequire(import.meta.url)

/** @type {{ shimFetch: Function, Headers: Function, Request: Function, Response: Function, FormData: Function, Blob: Function, File: Function } | null} */
let cached = null

/**
 * 载入纯 JS fetch 实现。
 * @returns {typeof cached} the shim module.
 * @throws {Error} when the compat entry is not configured (misassembled payload).
 */
function shim() {
  if (cached !== null) return cached
  const entry = process.env.DSH_OHOS_JITLESS_ENTRY
  if (typeof entry !== 'string' || entry === '') {
    throw new Error(
      'undici(ohos shim): DSH_OHOS_JITLESS_ENTRY is not set, so the pure-JS fetch implementation cannot be located',
    )
  }
  cached = requireFromHere(join(dirname(entry), 'fetch-shim.js'))
  return cached
}

/**
 * `fetch` 替身（忽略 undici 的 `dispatcher`，其余 init 原样透传）。
 * @param {RequestInfo | URL | string} input - request target.
 * @param {RequestInit} [init] - fetch init.
 * @returns {Promise<Response>} the response.
 */
export async function fetch(input, init) {
  return await shim().shimFetch(input, init)
}

/** 占位 Agent：市场只把它塞进 `dispatcher`，本实现不使用连接池。 */
export class Agent {
  /**
   * @param {object} [options] - undici agent options (kept for introspection).
   */
  constructor(options = {}) {
    this.options = options
  }

  /** undici API parity; closing is a no-op here. */
  close() {
    return Promise.resolve()
  }

  /** undici API parity; destroying is a no-op here. */
  destroy() {
    return Promise.resolve()
  }
}

/** 占位代理 Agent：设备侧不走代理（见模块头「语义边界」）。 */
export class EnvHttpProxyAgent extends Agent {}

/** 占位 ProxyAgent，同上。 */
export class ProxyAgent extends Agent {}

/** no-op：本替身没有全局 dispatcher。 */
export function setGlobalDispatcher() {}

/** @returns {null} always null: there is no global dispatcher in this shim. */
export function getGlobalDispatcher() {
  return null
}

/** Re-export the platform globals the market may destructure, when present. */
export const Headers = globalThis.Headers
export const Request = globalThis.Request
export const Response = globalThis.Response
export const FormData = globalThis.FormData
export const Blob = globalThis.Blob
export const File = globalThis.File

export default { fetch, Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher, getGlobalDispatcher }
