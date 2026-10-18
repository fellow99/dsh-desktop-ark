/**
 * Pure-JS image header parsing for `@dsh-ohos/attachment-image`.
 *
 * This is the part of the S4 `sharp` replacement that must work with no native
 * library: container headers give the real `format`/`width`/`height`/`pages`
 * and the JPEG EXIF orientation. Anything that needs pixels is delegated to the
 * host bridge (`image.normalize`); this module never decodes pixel data.
 *
 * Formats: PNG, JPEG, GIF, WebP. A truncated or unrecognized buffer throws —
 * `metadata()` must not invent dimensions (upstream sharp fails the same way
 * with `failOn: 'error'`; `packages/attachment/attachment-local/src/image.ts:93-99`).
 *
 * @module @dsh-ohos/attachment-image/image
 */

/** Thrown when the buffer is not a supported, complete image header. */
export class ImageHeaderError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'ImageHeaderError'
    this.code = 'SHARP_METADATA_FAILED'
  }
}

function need(buffer, length, what) {
  if (buffer.length < length) throw new ImageHeaderError(`sharp: truncated image header while reading ${what}`)
}

/**
 * Parse PNG: signature + IHDR (+ acTL for animated pages).
 * @param {Buffer} buffer
 * @returns {Record<string, any>}
 */
function pngMetadata(buffer) {
  need(buffer, 33, 'PNG signature/IHDR')
  let offset = 8
  let header
  let pages = 1
  let hasAnimation = false
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    if (length > buffer.length - dataStart) throw new ImageHeaderError(`sharp: truncated PNG chunk ${type}`)
    if (type === 'IHDR') {
      if (length < 13) throw new ImageHeaderError('sharp: PNG IHDR chunk is too short')
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
      }
    } else if (type === 'acTL') {
      hasAnimation = true
      if (length >= 8) pages = Math.max(1, buffer.readUInt32BE(dataStart + 4))
    } else if (type === 'IDAT' || type === 'IEND') {
      break
    }
    offset = dataStart + length + 4
  }
  if (header === undefined) throw new ImageHeaderError('sharp: PNG has no IHDR chunk')
  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsByColorType[header.colorType] ?? 4
  return {
    format: 'png',
    width: header.width,
    height: header.height,
    space: 'srgb',
    channels,
    depth: header.bitDepth === 16 ? 'ushort' : 'uchar',
    hasAlpha: header.colorType === 4 || header.colorType === 6,
    orientation: undefined,
    pages: hasAnimation ? pages : 1,
    hasProfile: false,
    icc: undefined,
    tifftagPhotoshop: undefined,
    comments: undefined,
  }
}

/**
 * Read the EXIF orientation from a JPEG APP1 payload.
 * Malformed EXIF is ignored (dimensions are still trustworthy).
 * @param {Buffer} data
 * @returns {number | undefined}
 */
export function jpegExifOrientation(data) {
  if (data.length < 14 || data.toString('ascii', 0, 6) !== 'Exif\0\0') return undefined
  const tiff = data.subarray(6)
  const byteOrder = tiff.toString('ascii', 0, 2)
  const little = byteOrder === 'II'
  if (!little && byteOrder !== 'MM') return undefined
  const read16 = offset => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset))
  const read32 = offset => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset))
  try {
    if (read16(2) !== 42) return undefined
    const ifd = read32(4)
    if (ifd + 2 > tiff.length) return undefined
    const count = read16(ifd)
    for (let index = 0; index < count; index += 1) {
      const entry = ifd + 2 + index * 12
      if (entry + 12 > tiff.length) return undefined
      const tag = read16(entry)
      if (tag !== 0x0112) continue
      const type = read16(entry + 2)
      if (type !== 3) return undefined
      const value = read16(entry + 8)
      return value >= 1 && value <= 8 ? value : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Parse JPEG: SOFn dimensions + APP1 EXIF orientation.
 * @param {Buffer} buffer
 * @returns {Record<string, any>}
 */
function jpegMetadata(buffer) {
  need(buffer, 4, 'JPEG SOI')
  let offset = 2
  let frame
  let orientation
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buffer.length) throw new ImageHeaderError('sharp: truncated JPEG segment')
    const dataStart = offset + 4
    const dataLength = length - 2
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (dataLength < 6) throw new ImageHeaderError('sharp: JPEG SOF segment is too short')
      frame = {
        depth: buffer[dataStart],
        height: buffer.readUInt16BE(dataStart + 1),
        width: buffer.readUInt16BE(dataStart + 3),
        channels: buffer[dataStart + 5],
      }
      break
    }
    if (marker === 0xe1 && dataLength > 6) {
      orientation = jpegExifOrientation(buffer.subarray(dataStart, dataStart + dataLength))
    }
    offset = dataStart + dataLength
  }
  if (frame === undefined) throw new ImageHeaderError('sharp: JPEG has no SOF frame header')
  return {
    format: 'jpeg',
    width: frame.width,
    height: frame.height,
    space: 'srgb',
    channels: frame.channels,
    depth: frame.depth === 16 ? 'ushort' : 'uchar',
    hasAlpha: false,
    orientation,
    pages: 1,
    hasProfile: false,
    icc: undefined,
    tifftagPhotoshop: undefined,
    comments: undefined,
  }
}

function skipSubBlocks(buffer, offset) {
  let cursor = offset
  while (cursor < buffer.length) {
    const size = buffer[cursor]
    cursor += 1
    if (size === 0) return cursor
    cursor += size
  }
  throw new ImageHeaderError('sharp: truncated GIF data sub-blocks')
}

/**
 * Parse GIF: logical screen + a structural walk counting image descriptors.
 * @param {Buffer} buffer
 * @returns {Record<string, any>}
 */
function gifMetadata(buffer) {
  need(buffer, 13, 'GIF logical screen descriptor')
  const width = buffer.readUInt16LE(6)
  const height = buffer.readUInt16LE(8)
  const packed = buffer[10]
  let offset = 13
  if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1)
  let pages = 0
  while (offset < buffer.length) {
    const block = buffer[offset]
    if (block === 0x3b) break
    if (block === 0x21) {
      offset = skipSubBlocks(buffer, offset + 2)
      continue
    }
    if (block === 0x2c) {
      pages += 1
      if (offset + 10 > buffer.length) throw new ImageHeaderError('sharp: truncated GIF image descriptor')
      const imagePacked = buffer[offset + 9]
      offset += 10
      if ((imagePacked & 0x80) !== 0) offset += 3 * 2 ** ((imagePacked & 0x07) + 1)
      offset = skipSubBlocks(buffer, offset + 1)
      continue
    }
    break
  }
  return {
    format: 'gif',
    width,
    height,
    space: 'srgb',
    channels: 4,
    depth: 'uchar',
    hasAlpha: true,
    orientation: undefined,
    pages: Math.max(1, pages),
    hasProfile: false,
    icc: undefined,
    tifftagPhotoshop: undefined,
    comments: undefined,
  }
}

function webpChunkOffset(buffer, type) {
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString('ascii', offset, offset + 4)
    const length = buffer.readUInt32LE(offset + 4)
    if (chunkType === type) return offset + 8
    offset += 8 + length + (length % 2)
  }
  return -1
}

function webpCountChunks(buffer, type) {
  let offset = 12
  let count = 0
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString('ascii', offset, offset + 4)
    const length = buffer.readUInt32LE(offset + 4)
    if (chunkType === type) count += 1
    offset += 8 + length + (length % 2)
  }
  return count
}

/**
 * Parse WebP: VP8 / VP8L / VP8X (canvas, alpha, animation).
 * @param {Buffer} buffer
 * @returns {Record<string, any>}
 */
function webpMetadata(buffer) {
  need(buffer, 20, 'WebP RIFF header')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    throw new ImageHeaderError('sharp: not a WebP container')
  }
  const vp8x = webpChunkOffset(buffer, 'VP8X')
  if (vp8x !== -1 && vp8x + 10 <= buffer.length) {
    const flags = buffer[vp8x]
    const width = buffer.readUIntLE(vp8x + 4, 3) + 1
    const height = buffer.readUIntLE(vp8x + 7, 3) + 1
    const animated = webpChunkOffset(buffer, 'ANIM') !== -1
    const pages = animated ? Math.max(1, webpCountChunks(buffer, 'ANMF')) : 1
    return {
      format: 'webp',
      width,
      height,
      space: 'srgb',
      channels: (flags & 0x10) !== 0 ? 4 : 3,
      depth: 'uchar',
      hasAlpha: (flags & 0x10) !== 0,
      orientation: undefined,
      pages,
      hasProfile: false,
      icc: undefined,
      tifftagPhotoshop: undefined,
      comments: undefined,
    }
  }
  const lossy = webpChunkOffset(buffer, 'VP8 ')
  if (lossy !== -1 && lossy + 10 <= buffer.length) {
    return {
      format: 'webp',
      width: buffer.readUInt16LE(lossy + 6) & 0x3fff,
      height: buffer.readUInt16LE(lossy + 8) & 0x3fff,
      space: 'srgb',
      channels: 3,
      depth: 'uchar',
      hasAlpha: false,
      orientation: undefined,
      pages: 1,
      hasProfile: false,
      icc: undefined,
      tifftagPhotoshop: undefined,
      comments: undefined,
    }
  }
  const lossless = webpChunkOffset(buffer, 'VP8L')
  if (lossless !== -1 && lossless + 5 <= buffer.length) {
    const bits = buffer.readUInt32LE(lossless + 1)
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      space: 'srgb',
      channels: (bits >> 28) & 1 ? 4 : 3,
      depth: 'uchar',
      hasAlpha: ((bits >> 28) & 1) === 1,
      orientation: undefined,
      pages: 1,
      hasProfile: false,
      icc: undefined,
      tifftagPhotoshop: undefined,
      comments: undefined,
    }
  }
  throw new ImageHeaderError('sharp: WebP container has no decodable frame header')
}

/**
 * Read metadata from an image header buffer.
 * @param {Buffer | Uint8Array} input
 * @returns {Record<string, any>}
 * @throws {ImageHeaderError}
 */
export function readImageMetadata(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length === 0) throw new ImageHeaderError('sharp: input image is empty')
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) return pngMetadata(buffer)
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return jpegMetadata(buffer)
  if (buffer.length >= 6) {
    const signature = buffer.toString('ascii', 0, 6)
    if (signature === 'GIF87a' || signature === 'GIF89a') return gifMetadata(buffer)
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return webpMetadata(buffer)
  throw new ImageHeaderError('sharp: unsupported image format (expected PNG, JPEG, GIF, or WebP)')
}

/**
 * Dimensions after EXIF auto-orientation (orientations 5-8 swap the axes).
 * @param {{ width: number, height: number, orientation?: number }} metadata
 * @returns {{ width: number, height: number }}
 */
export function orientedSize(metadata) {
  const swap = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8
  return swap ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height }
}
