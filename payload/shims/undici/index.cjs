/**
 * `undici` 替身的 CJS 入口（与 `index.mjs` 同一实现；dshmarket 走 ESM，本入口只为
 * `require('undici')` 的调用方兜底）。
 *
 * @module undici（DSH OHOS 替身，CJS）
 */
'use strict'

const { dirname, join } = require('node:path')

let cached = null

function shim() {
  if (cached !== null) return cached
  const entry = process.env.DSH_OHOS_JITLESS_ENTRY
  if (typeof entry !== 'string' || entry === '') {
    throw new Error(
      'undici(ohos shim): DSH_OHOS_JITLESS_ENTRY is not set, so the pure-JS fetch implementation cannot be located',
    )
  }
  cached = require(join(dirname(entry), 'fetch-shim.js'))
  return cached
}

async function fetchImpl(input, init) {
  return await shim().shimFetch(input, init)
}

class Agent {
  constructor(options = {}) {
    this.options = options
  }

  close() {
    return Promise.resolve()
  }

  destroy() {
    return Promise.resolve()
  }
}

class EnvHttpProxyAgent extends Agent {}
class ProxyAgent extends Agent {}

function setGlobalDispatcher() {}
function getGlobalDispatcher() {
  return null
}

module.exports = {
  fetch: fetchImpl,
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Headers: globalThis.Headers,
  Request: globalThis.Request,
  Response: globalThis.Response,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
  File: globalThis.File,
}
module.exports.default = module.exports
