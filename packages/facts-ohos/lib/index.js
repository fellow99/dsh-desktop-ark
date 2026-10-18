/**
 * `@dsh-ohos/facts` — `GET /_ohos/facts` diagnostics endpoint, disabled by
 * default.
 *
 * Upstream has no facts/diagnostics service and no `/health`-style route
 * (`report B.9:489`). The supported way to add one is a function plugin that
 * registers an exact route through `ctx.effect(() => ctx.webServer.register(...))`
 * (`packages/host/webserver/src/index.ts:366-373`).
 *
 * Contract:
 * - config is exactly `{ enabled }`, default `false` (bundle row
 *   `facts-ohos`); when false the plugin registers nothing;
 * - every request goes through `ctx.connection.requestRejection(req)` first —
 *   the same cookie/Host fence as the rest of the web UI (401/403);
 * - the payload is a snapshot of runtime facts, and NEVER a token: only
 *   non-sensitive `DSH_OHOS_*` entries are exposed, plus an explicit
 *   `redacted` list;
 * - release builds must keep `enabled: false` (FR-105-013). The README records
 *   that this switch is diagnostics-only.
 *
 * @module @dsh-ohos/facts
 */

import { HOST_CAPABILITIES, isAvailable as hostBridgeAvailable } from '@dsh-ohos/host-bridge'

/** Cordis function-plugin name (matches the bundle row id). */
export const name = 'facts-ohos'

/** The route carrier and the authentication fence. */
export const inject = ['webServer', 'connection']

/** Exact route path. */
export const FACTS_PATH = '/_ohos/facts'

/** Credential-shaped names that must never appear in the payload. */
export const SENSITIVE_ENV_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL|SESSION/i

/** Host capabilities that are implemented in this build (`HostCapabilities.ets:189-195`). */
export const IMPLEMENTED_CAPABILITIES = Object.freeze(HOST_CAPABILITIES.slice(0, 6))

/** Host capabilities registered as `not-implemented` placeholders. */
export const PLACEHOLDER_CAPABILITIES = Object.freeze(HOST_CAPABILITIES.slice(6))

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Non-sensitive `DSH_OHOS_*` environment entries.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ values: Record<string, string>, redacted: string[] }}
 */
export function dshOhosEnv(env = process.env) {
  const values = {}
  const redacted = []
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('DSH_OHOS_')) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) {
      redacted.push(key)
      continue
    }
    if (value !== undefined) values[key] = value
  }
  return { values, redacted: redacted.sort() }
}

/**
 * Collect shim markers. The payload shims print `[shim] <marker> installed`
 * but do not (yet) publish a machine-readable list, so this reads a
 * conventional channel and says so when it is empty.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, any>} [globalObject]
 * @returns {{ source: string, markers: string[], note?: string }}
 */
export function readShims(env = process.env, globalObject = globalThis) {
  const fromEnv = env.DSH_OHOS_SHIMS
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return {
      source: 'env:DSH_OHOS_SHIMS',
      markers: fromEnv.split(',').map(entry => entry.trim()).filter(entry => entry !== ''),
    }
  }
  const globalValue = globalObject?.__DSH_OHOS_SHIMS__
  if (Array.isArray(globalValue)) {
    return {
      source: 'global:__DSH_OHOS_SHIMS__',
      markers: globalValue
        .map(entry => (typeof entry === 'string' ? entry : entry?.marker))
        .filter(marker => typeof marker === 'string' && marker !== ''),
    }
  }
  return {
    source: 'unavailable',
    markers: [],
    note: 'no shim registry was published by payload/bootstrap.js; each shim logs its own `[shim] <marker> installed` line',
  }
}

/**
 * Loaded bundle rows from the loader service, when present.
 * @param {Record<string, any>} ctx
 * @returns {Array<{ id: string, name: string | null, disabled: boolean }>}
 */
export function readBundleRows(ctx) {
  let store
  try {
    const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : ctx?.loader
    store = loader?.store
  } catch {
    return []
  }
  if (store === null || typeof store !== 'object') return []
  const rows = []
  for (const [key, entry] of Object.entries(store)) {
    if (entry === null || typeof entry !== 'object') continue
    const options = entry.options ?? entry
    rows.push({
      id: typeof options.id === 'string' && options.id !== '' ? options.id
        : typeof entry.id === 'string' && entry.id !== '' ? entry.id : key,
      name: typeof options.name === 'string' ? options.name : null,
      disabled: options.disabled === true,
    })
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Build the facts payload.
 * @param {Record<string, any>} ctx
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, any>} [globalObject]
 * @returns {Record<string, any>}
 */
export function collectFacts(ctx, env = process.env, globalObject = globalThis) {
  const webServer = ctx?.webServer ?? (() => {
    try {
      return ctx?.get?.('webServer')
    } catch {
      return undefined
    }
  })()
  let port = null
  let origin = null
  try {
    port = Number.isInteger(webServer?.port) ? webServer.port : null
    origin = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : null
  } catch (error) {
    origin = { error: messageOf(error) }
  }
  let bridgeAvailable = false
  try {
    bridgeAvailable = hostBridgeAvailable()
  } catch {
    bridgeAvailable = false
  }
  const environment = dshOhosEnv(env)
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    node: {
      version: process.version,
      modules: process.versions.modules ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    process: { pid: process.pid },
    profile: env.DSH_PROFILE ?? env.DSH_OHOS_PROFILE ?? null,
    webServer: { port, origin },
    bundleRows: readBundleRows(ctx),
    env: environment.values,
    redactedEnv: environment.redacted,
    shims: readShims(env, globalObject),
    capabilities: {
      sandbox: 'none',
      sandboxEnforcement: 'none',
      kernelIsolation: false,
      pty: false,
      attachments: {
        metadata: 'pure-js (png/jpeg/gif/webp headers)',
        pixelOperations: bridgeAvailable ? 'via host bridge image.normalize (still a placeholder handler)' : 'unavailable (host bridge not wired)',
      },
      hostBridge: {
        available: bridgeAvailable,
        capabilities: [...HOST_CAPABILITIES],
        implemented: [...IMPLEMENTED_CAPABILITIES],
        placeholders: [...PLACEHOLDER_CAPABILITIES],
      },
    },
    honesty: {
      tokens: 'never included; only non-sensitive DSH_OHOS_* names are listed',
      diagnostics: 'this endpoint is diagnostics-only and disabled by default in release builds',
    },
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Register the endpoint when enabled.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  if (config?.enabled !== true) {
    try {
      ctx.logger?.('facts-ohos')?.info?.('facts endpoint disabled (config.enabled=false); release builds must keep it disabled')
    } catch {
      // Logging is optional.
    }
    return
  }
  const connection = ctx.connection
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    throw new Error('facts-ohos: ctx.connection.requestRejection is required to authenticate the diagnostics endpoint')
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: FACTS_PATH,
        handler: (req, res) => {
          const rejection = connection.requestRejection(req)
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.setHeader('allow', 'GET')
            res.end()
            return
          }
          try {
            sendJson(res, 200, collectFacts(ctx))
          } catch (error) {
            sendJson(res, 500, { code: 'facts-failed', message: messageOf(error) })
          }
        },
      }),
    `facts: GET ${FACTS_PATH}`,
  )
}

