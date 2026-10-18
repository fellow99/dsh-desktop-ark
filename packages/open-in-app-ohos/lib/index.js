/**
 * `@dsh-ohos/open-in-app` — replacement for the `open-in-app` bundle row.
 *
 * Upstream shape (`packages/host/open-in-app/src/index.ts:45-310`): a FUNCTION
 * plugin (no service) that registers three HTTP routes and asks
 * `ctx.connection.requestRejection(req)` before doing any work. That is exactly
 * what this package keeps; what changes is the launch mechanism:
 * - upstream probes desktop applications and spawns them; HarmonyOS has no such
 *   catalog in the app domain, so the catalog is the single host-mediated
 *   "system" handler;
 * - the actual open goes through the host bridge capability
 *   `shell.openExternal` (ArkTS `Want` / `context.openLink`);
 * - only `https:` links and existing paths INSIDE the workspace are accepted
 *   (FR-105-012). A bridge failure becomes HTTP 502 with the ArkTS
 *   `error`/`hint` text — never a fake 200.
 *
 * Routes (same absolute paths as `packages/host/open-in-app/src/shared.ts:11-23`):
 *   GET  /open-in-app/apps        -> { apps: ['system'] }
 *   GET  /open-in-app/icon/<id>   -> 404 (no host app icons on HarmonyOS)
 *   POST /open-in-app/open        -> 200 {ok:true} | 4xx | 502 {code:'launch-failed'}
 *
 * @module @dsh-ohos/open-in-app
 */

import { stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HostBridgeError, invoke as invokeHost } from '@dsh-ohos/host-bridge'

/** Route paths (verbatim from the upstream shared module). */
export const OPEN_IN_APP_APPS_PATH = '/open-in-app/apps'
export const OPEN_IN_APP_ICON_PREFIX_PATH = '/open-in-app/icon'
export const OPEN_IN_APP_OPEN_PATH = '/open-in-app/open'

/** Cordis function-plugin name (same as the upstream row's plugin). */
export const name = 'open-in-app'

/** Route carrier and trust fence. `subprocess` is not needed on HarmonyOS. */
export const inject = ['webServer', 'connection']

/** The only catalog id served on this platform. */
export const SYSTEM_APP_ID = 'system'

/** Catalog served by the apps route. */
export const APP_CATALOG = Object.freeze([SYSTEM_APP_ID])

/** Open-route bodies are tiny JSON objects; anything larger is hostile. */
export const MAX_BODY_BYTES = 64 * 1024

/** Workspace seam variable set by the ArkTS runtime. */
export const WORKSPACE_ENV = 'DSH_OHOS_WORKSPACE'

/** Defaults kept for wire compatibility with the upstream row config. */
export const DEFAULT_CONFIG = Object.freeze({ probeTimeoutMs: 10_000, iconTimeoutMs: 10_000, launchWatchMs: 1_000 })

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function methodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text; null past the ceiling.
 * @param {AsyncIterable<Buffer>} req
 * @returns {Promise<string | null>}
 */
export async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume?.()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate one open-route body: JSON object with string `app` and `path`.
 * @param {string} text
 * @returns {{ app: string, path: string } | null}
 */
export function parseOpenBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  return typeof body.app === 'string' && typeof body.path === 'string' ? { app: body.app, path: body.path } : null
}

/**
 * Workspace root from the environment (never `process.cwd()`).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function workspaceRoot(env = process.env) {
  const value = env[WORKSPACE_ENV]
  return typeof value === 'string' && isAbsolute(value) ? value : undefined
}

/**
 * Containment check on canonical paths.
 * @param {string} child
 * @param {string} root
 * @returns {boolean}
 */
export function isPathUnder(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string' || child === '' || root === '') return false
  const rel = relative(canonicalOr(root), canonicalOr(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel))
}

function canonicalOr(value) {
  try {
    return realpathSync.native(value)
  } catch {
    return value
  }
}

/**
 * Classify the open-route `path` value.
 * @param {string} value
 * @param {string | undefined} root - workspace root; when absent, path targets are refused.
 * @returns {{ kind: 'https', uri: string } | { kind: 'path', path: string } | { kind: 'invalid', reason: string }}
 */
export function classifyTarget(value, root = workspaceRoot()) {
  if (typeof value !== 'string' || value.trim() === '') return { kind: 'invalid', reason: 'path must be a non-empty string' }
  // Filesystem first: on Windows `C:\dir\file` parses as a `c:` URL, and the
  // workspace is a filesystem path on every platform.
  if (isAbsolute(value)) {
    if (root === undefined || root === null) return { kind: 'invalid', reason: `${WORKSPACE_ENV} is not set; workspace paths cannot be opened` }
    const canonical = canonicalOr(value)
    if (!isPathUnder(canonical, root)) return { kind: 'invalid', reason: 'path is outside the workspace (only workspace files may be opened)' }
    return { kind: 'path', path: canonical }
  }
  let url
  try {
    url = new URL(value)
    if (url.protocol === 'https:') return { kind: 'https', uri: value }
    return { kind: 'invalid', reason: `only https: links and workspace paths are allowed, got ${url.protocol}` }
  } catch {
    // Not a URL and not an absolute path: reject below.
  }
  return { kind: 'invalid', reason: 'path must be an absolute workspace path or an https: link' }
}

/**
 * Bridge failure → 502 payload that keeps the ArkTS error and hint text.
 * @param {unknown} error
 * @returns {{ code: 'launch-failed', message: string, error?: string, hint?: string }}
 */
export function launchFailure(error) {
  if (error instanceof HostBridgeError) {
    return {
      code: 'launch-failed',
      message: error.message,
      error: error.hostError ?? error.code,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    }
  }
  return { code: 'launch-failed', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Register the apps, icon, and open routes behind the connection trust fence.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ probeTimeoutMs?: number, iconTimeoutMs?: number, launchWatchMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
    const value = config[key] ?? fallback
    if (!Number.isFinite(value) || value < 1 || value > 600_000) {
      throw new Error(`open-in-app: ${key} must be a number in [1, 600000]`)
    }
  }
  const connection = ctx.connection
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    throw new Error('open-in-app: ctx.connection.requestRejection is required (the connection capability provides it)')
  }
  const rejected = (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: OPEN_IN_APP_APPS_PATH,
        handler: (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET')
            return
          }
          sendJson(res, 200, { apps: [...APP_CATALOG] })
        },
      }),
    `open-in-app: GET ${OPEN_IN_APP_APPS_PATH}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: OPEN_IN_APP_ICON_PREFIX_PATH,
        handler: (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET')
            return
          }
          const pathname = new URL(String(req.url), 'http://localhost').pathname
          const id = pathname.slice(OPEN_IN_APP_ICON_PREFIX_PATH.length).replace(/^\//, '')
          sendJson(res, 404, { code: 'not-found', message: `no icon for ${id}` })
        },
      }),
    `open-in-app: GET ${OPEN_IN_APP_ICON_PREFIX_PATH}/<id>`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: OPEN_IN_APP_OPEN_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST')
            return
          }
          const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
          if (essence !== 'application/json') {
            sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
            return
          }
          let text
          try {
            text = await readBoundedBody(req)
          } catch {
            sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
            return
          }
          if (text === null) {
            sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
            return
          }
          const parsed = parseOpenBody(text)
          if (parsed === null) {
            sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON with string "app" and "path"' })
            return
          }
          if (!APP_CATALOG.includes(parsed.app)) {
            sendJson(res, 400, { code: 'bad-request', message: `unknown or unavailable app: ${parsed.app}` })
            return
          }
          const target = classifyTarget(parsed.path)
          if (target.kind === 'invalid') {
            sendJson(res, 400, { code: 'bad-request', message: target.reason })
            return
          }
          let uri = target.uri
          if (target.kind === 'path') {
            let info
            try {
              info = await stat(target.path)
            } catch {
              sendJson(res, 404, { code: 'not-found', message: `path does not exist: ${target.path}` })
              return
            }
            if (info.isDirectory()) {
              // Upstream opens a directory in the chosen app; ArkTS openExternal
              // cannot address directories yet, so fail explicitly.
              sendJson(res, 400, { code: 'bad-request', message: 'only files can be opened on this platform (directories are not supported yet)' })
              return
            }
            uri = pathToFileURL(target.path).href
          }
          try {
            await invokeHost('shell.openExternal', { uri })
          } catch (error) {
            sendJson(res, 502, launchFailure(error))
            return
          }
          sendJson(res, 200, { ok: true })
        },
      }),
    `open-in-app: POST ${OPEN_IN_APP_OPEN_PATH}`,
  )
}

