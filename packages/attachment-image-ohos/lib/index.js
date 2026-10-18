/**
 * `@dsh-ohos/attachment-image` — the S4 `sharp` replacement.
 *
 * Upstream `@deepseek-ai/dsh-attachment-local` loads sharp through a
 * process-level lazy require and has NO injection point
 * (`packages/attachment/attachment-local/src/sharp.ts:7`; report B.7:411-424).
 * The only way to replace it is to materialize a same-named package, so this
 * package is that replacement: `payload/shims/sharp.js` looks for
 * `node_modules/sharp/package.json` (marker `DSH_OHOS_SHIM sharp`) and the
 * payload pipeline must point that name at this package.
 *
 * It therefore exports a CALLABLE sharp factory as both the default export and
 * the `module.exports` interop export (Node ≥22.12 `require(esm)` honors the
 * latter), while the named exports keep the helper surface available to the
 * plugin layer:
 *
 *   const sharp = require('sharp')          // -> callable
 *   const { sharp } = await import('@dsh-ohos/attachment-image')
 *
 * Compatibility surface used by upstream
 * (`packages/attachment/attachment-local/src/{image,normalization,encoding,request-image}.ts`):
 * `metadata()`, `rotate()`, `toColourspace('srgb')`,
 * `resize({ width, height, fit: 'inside', withoutEnlargement: true })`,
 * `webp({ quality, effort })` / `jpeg({ quality })`,
 * `toBuffer({ resolveWithObject: true })`, `clone()`.
 *
 * `metadata()` is pure JS (PNG/JPEG/GIF/WebP headers). Every pixel operation is
 * delegated to the host bridge `image.normalize`; a missing bridge or an
 * `ok:false` answer throws — there is no silent fallback (S4 / C2).
 *
 * @module @dsh-ohos/attachment-image
 */

import { readFileSync } from 'node:fs'
import { HostBridgeError, invoke as invokeHost } from '@dsh-ohos/host-bridge'
import { ImageHeaderError, orientedSize, readImageMetadata } from './image.js'

/** Marker recorded by the S4 shim probe. */
export const SHIM_MARKER = 'DSH_OHOS_SHIM sharp'

/** Host capability used for every pixel operation. */
export const BRIDGE_CAPABILITY = 'image.normalize'

/** Encoding can legitimately take a while; the generic 15 s default is short. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000

/** Quality ladder used by upstream (`attachment-local/src/encoding.ts:33-38`). */
export const QUALITY_LADDER = Object.freeze([85, 75, 60])

/**
 * Normalize a sharp input value to bytes.
 * @param {Buffer | Uint8Array | ArrayBuffer | string | { path?: string }} input
 * @returns {Buffer}
 */
export function toInputBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (typeof input === 'string') return readFileSync(input)
  if (input !== null && typeof input === 'object' && typeof input.path === 'string') return readFileSync(input.path)
  throw new TypeError('sharp: input must be a Buffer, Uint8Array, ArrayBuffer, file path, or { path }')
}

/**
 * Sharp's `fit: 'inside'` arithmetic for the info block when the host does not
 * report dimensions.
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number | undefined} targetWidth
 * @param {number | undefined} targetHeight
 * @param {boolean} withoutEnlargement
 * @returns {{ width: number, height: number }}
 */
export function resizeInside(sourceWidth, sourceHeight, targetWidth, targetHeight, withoutEnlargement) {
  const ratio = Math.min(
    targetWidth !== undefined ? targetWidth / sourceWidth : Number.POSITIVE_INFINITY,
    targetHeight !== undefined ? targetHeight / sourceHeight : Number.POSITIVE_INFINITY,
  )
  const scale = withoutEnlargement ? Math.min(1, ratio) : ratio
  if (!Number.isFinite(scale)) return { width: sourceWidth, height: sourceHeight }
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

function assertQuality(value, name) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new TypeError(`sharp: ${name} must be an integer in [1, 100]`)
  return value
}

/** One immutable-until-cloned sharp pipeline. */
export class SharpPipeline {
  /**
   * @param {Buffer} input
   * @param {Record<string, any>} [options]
   * @param {Record<string, any>} [state]
   */
  constructor(input, options = {}, state = undefined) {
    this.input = input
    this.options = options
    this.state = state ?? {
      rotate: false,
      colourspace: undefined,
      resize: undefined,
      format: undefined,
    }
    /** Sharp's callable factory marker. */
    this.isSharpReplacement = true
  }

  /**
   * Real container metadata (no pixel decode).
   * @returns {Promise<Record<string, any>>}
   */
  async metadata() {
    return readImageMetadata(this.input)
  }

  /**
   * EXIF auto-orientation (sharp's argument-less `rotate()`).
   * @param {number | undefined} angle
   * @returns {this}
   */
  rotate(angle) {
    if (angle !== undefined && angle !== 0) {
      throw new TypeError('sharp: arbitrary rotation is not supported on HarmonyOS; rotate() only applies EXIF orientation')
    }
    this.state.rotate = true
    return this
  }

  /**
   * @param {string} space
   * @returns {this}
   */
  toColourspace(space) {
    if (space !== 'srgb') throw new TypeError(`sharp: only "srgb" is supported on HarmonyOS (got ${JSON.stringify(space)})`)
    this.state.colourspace = space
    return this
  }

  /**
   * @param {{ width?: number, height?: number, fit?: string, withoutEnlargement?: boolean }} [options]
   * @returns {this}
   */
  resize(options = {}) {
    const { width, height, fit, withoutEnlargement } = options
    if (width !== undefined && (!Number.isInteger(width) || width < 1)) throw new TypeError('sharp: resize width must be a positive integer')
    if (height !== undefined && (!Number.isInteger(height) || height < 1)) throw new TypeError('sharp: resize height must be a positive integer')
    if (fit !== undefined && fit !== 'inside') throw new TypeError(`sharp: only fit "inside" is supported on HarmonyOS (got ${JSON.stringify(fit)})`)
    this.state.resize = {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      fit: fit ?? 'inside',
      withoutEnlargement: withoutEnlargement ?? true,
    }
    return this
  }

  /**
   * @param {{ quality?: number, effort?: number }} [options]
   * @returns {this}
   */
  webp(options = {}) {
    this.state.format = {
      type: 'webp',
      quality: assertQuality(options.quality, 'webp quality') ?? 85,
      effort: options.effort ?? 0,
    }
    return this
  }

  /**
   * @param {{ quality?: number }} [options]
   * @returns {this}
   */
  jpeg(options = {}) {
    this.state.format = { type: 'jpeg', quality: assertQuality(options.quality, 'jpeg quality') ?? 85 }
    return this
  }

  /**
   * Independent copy of this pipeline (upstream clones per quality candidate).
   * @returns {SharpPipeline}
   */
  clone() {
    return new SharpPipeline(this.input, this.options, JSON.parse(JSON.stringify(this.state)))
  }

  /**
   * Encode through the host bridge.
   * @param {{ resolveWithObject?: boolean }} [options]
   * @returns {Promise<Buffer | { data: Buffer, info: Record<string, any> }>}
   */
  async toBuffer(options = {}) {
    const metadata = readImageMetadata(this.input)
    const format = this.state.format?.type ?? (metadata.hasAlpha ? 'webp' : 'jpeg')
    const args = {
      data: this.input.toString('base64'),
      format,
      quality: this.state.format?.quality ?? 85,
      ...(this.state.format?.effort !== undefined ? { effort: this.state.format.effort } : {}),
      rotate: this.state.rotate === true,
      colourspace: this.state.colourspace ?? 'srgb',
      ...(this.state.resize?.width !== undefined ? { width: this.state.resize.width } : {}),
      ...(this.state.resize?.height !== undefined ? { height: this.state.resize.height } : {}),
      fit: this.state.resize?.fit ?? 'inside',
      withoutEnlargement: this.state.resize?.withoutEnlargement ?? true,
      sourceFormat: metadata.format,
    }
    let response
    try {
      response = await invokeHost(BRIDGE_CAPABILITY, args, { timeoutMs: DEFAULT_BRIDGE_TIMEOUT_MS })
    } catch (error) {
      if (error instanceof HostBridgeError) throw error
      throw new HostBridgeError('host-rejected', `sharp: image.normalize failed: ${error instanceof Error ? error.message : String(error)}`, {
        capability: BRIDGE_CAPABILITY,
        cause: error,
      })
    }
    if (typeof response.data !== 'string' || response.data === '') {
      throw new HostBridgeError('host-rejected', 'sharp: image.normalize returned no data (the ArkTS handler must answer {ok:true,data:<base64>})', {
        capability: BRIDGE_CAPABILITY,
        hint: typeof response.hint === 'string' ? response.hint : undefined,
      })
    }
    const data = Buffer.from(response.data, 'base64')
    if (options.resolveWithObject !== true) return data
    const oriented = orientedSize(metadata)
    const resized = resizeInside(
      oriented.width,
      oriented.height,
      this.state.resize?.width,
      this.state.resize?.height,
      this.state.resize?.withoutEnlargement ?? true,
    )
    const info = {
      format: typeof response.format === 'string' ? response.format : format,
      width: Number.isInteger(response.width) ? response.width : resized.width,
      height: Number.isInteger(response.height) ? response.height : resized.height,
      channels: Number.isInteger(response.channels) ? response.channels : metadata.hasAlpha ? 4 : 3,
      depth: 'uchar',
      space: 'srgb',
      size: data.length,
    }
    return { data, info }
  }
}

/**
 * Sharp-compatible factory.
 * @param {Buffer | Uint8Array | ArrayBuffer | string | { path?: string }} input
 * @param {{ failOn?: string, limitInputPixels?: boolean | number }} [options]
 * @returns {SharpPipeline}
 */
export function sharp(input, options = {}) {
  return new SharpPipeline(toInputBuffer(input), options)
}

export { ImageHeaderError, orientedSize, readImageMetadata }

export default sharp

// CommonJS interop: `require('sharp')` must return the callable factory (S4).
export { sharp as 'module.exports' }
