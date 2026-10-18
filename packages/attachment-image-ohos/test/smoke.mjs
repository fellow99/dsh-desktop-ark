/**
 * Smoke test for `@dsh-ohos/attachment-image` (pure Node).
 *
 * `@dsh-ohos/host-bridge` is mapped to `test/bridge-mock.mjs` via
 * `module.registerHooks`. Image buffers are built by hand, so metadata parsing
 * is checked against real container headers (PNG / JPEG+EXIF / GIF / WebP).
 *
 * Covers: header parsing and truncation failures, EXIF orientation, the
 * sharp-compatible pipeline surface, bridge encoding (`image.normalize`),
 * explicit failure on a missing bridge or `ok:false`, clone independence, and
 * `require(esm)` callable interop (the S4 replacement target).
 *
 * Run: `node test/smoke.mjs`
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@dsh-ohos/host-bridge') {
      return { url: new URL('./bridge-mock.mjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const sharpModule = await import('../lib/index.js')
const image = await import('../lib/image.js')
const bridge = await import('@dsh-ohos/host-bridge')

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4) // the parser does not verify CRCs
  return Buffer.concat([length, typeBuffer, data, crc])
}

function png(width, height, { colorType = 6, bitDepth = 8, animated = false } = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  const chunks = [signature, pngChunk('IHDR', ihdr)]
  if (animated) {
    const actl = Buffer.alloc(8)
    actl.writeUInt32BE(2, 0)
    actl.writeUInt32BE(4, 4)
    chunks.push(pngChunk('acTL', actl))
  }
  chunks.push(pngChunk('IDAT', Buffer.from([1, 2, 3])))
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function exifApp1(orientation) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4)
  tiff.write('II', 0, 'ascii')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const header = Buffer.alloc(4)
  header[0] = 0xff
  header[1] = 0xe1
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

function jpeg(width, height, orientation) {
  const sof = Buffer.alloc(4 + 6 + 3 * 3)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(2 + 6 + 3 * 3, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  const eoi = Buffer.from([0xff, 0xd9])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), exifApp1(orientation), sof, eoi])
}

function gif(width, height) {
  const header = Buffer.from('GIF89a', 'ascii')
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(width, 0)
  lsd.writeUInt16LE(height, 2)
  lsd[4] = 0 // no global color table
  const descriptor = Buffer.alloc(10)
  descriptor[0] = 0x2c
  descriptor.writeUInt16LE(width, 1)
  descriptor.writeUInt16LE(height, 3)
  descriptor[9] = 0 // no local color table
  const data = Buffer.from([2, 1, 0x2c, 0x00, 0x3b]) // LZW min size, one sub-block, terminator, trailer
  return Buffer.concat([header, lsd, descriptor, data])
}

function webpLossy(width, height) {
  const payload = Buffer.alloc(10)
  payload.writeUInt16LE(width, 6)
  payload.writeUInt16LE(height, 8)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.write('VP8 ', 0, 'ascii')
  chunkHeader.writeUInt32LE(payload.length, 4)
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunkHeader, payload])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

await test('metadata: PNG dimensions, alpha, animated pages', async () => {
  const meta = await sharpModule.default(png(3, 2)).metadata()
  assert.equal(meta.format, 'png')
  assert.equal(meta.width, 3)
  assert.equal(meta.height, 2)
  assert.equal(meta.hasAlpha, true)
  assert.equal(meta.channels, 4)
  assert.equal(meta.pages, 1)
  const animated = await sharpModule.default(png(5, 4, { animated: true })).metadata()
  assert.equal(animated.pages, 4)
})

await test('metadata: JPEG dimensions + EXIF orientation, orientedSize swap', async () => {
  const meta = await sharpModule.default(jpeg(640, 480, 6)).metadata()
  assert.equal(meta.format, 'jpeg')
  assert.equal(meta.width, 640)
  assert.equal(meta.height, 480)
  assert.equal(meta.orientation, 6)
  assert.deepEqual(image.orientedSize(meta), { width: 480, height: 640 })
  assert.deepEqual(image.orientedSize({ width: 640, height: 480, orientation: 1 }), { width: 640, height: 480 })
})

await test('metadata: GIF and WebP headers', async () => {
  const gifMeta = await sharpModule.default(gif(12, 7)).metadata()
  assert.equal(gifMeta.format, 'gif')
  assert.equal(gifMeta.width, 12)
  assert.equal(gifMeta.height, 7)
  assert.equal(gifMeta.pages, 1)
  const webpMeta = await sharpModule.default(webpLossy(300, 200)).metadata()
  assert.equal(webpMeta.format, 'webp')
  assert.equal(webpMeta.width, 300)
  assert.equal(webpMeta.height, 200)
})

await test('metadata: truncated / unsupported input throws (never invents dimensions)', async () => {
  await assert.rejects(() => sharpModule.default(png(3, 2).subarray(0, 20)).metadata(), error => {
    assert.equal(error.name, 'ImageHeaderError')
    assert.equal(error.code, 'SHARP_METADATA_FAILED')
    return true
  })
  await assert.rejects(() => sharpModule.default(Buffer.from('not an image')).metadata(), /unsupported image format/)
  await assert.rejects(() => sharpModule.default(Buffer.alloc(0)).metadata(), /empty/)
})

await test('pipeline surface: rotate / toColourspace / resize / webp|jpeg / clone', () => {
  const pipeline = sharpModule.default(png(10, 10))
  assert.equal(pipeline.rotate(), pipeline)
  assert.equal(pipeline.toColourspace('srgb'), pipeline)
  assert.equal(pipeline.resize({ width: 5, height: 5, fit: 'inside', withoutEnlargement: true }), pipeline)
  assert.equal(pipeline.webp({ quality: 75, effort: 0 }), pipeline)
  assert.throws(() => pipeline.rotate(90), /arbitrary rotation/)
  assert.throws(() => pipeline.toColourspace('cmyk'), /only "srgb"/)
  assert.throws(() => pipeline.resize({ fit: 'cover' }), /only fit "inside"/)
  assert.throws(() => pipeline.resize({ width: 0 }), /positive integer/)
  assert.throws(() => pipeline.jpeg({ quality: 101 }), /quality/)
  const clone = pipeline.clone()
  clone.jpeg({ quality: 60 })
  assert.equal(pipeline.state.format.type, 'webp')
  assert.equal(clone.state.format.type, 'jpeg')
  assert.notEqual(clone.state, pipeline.state)
})

await test('toBuffer: bridge request shape, resolveWithObject info', async () => {
  bridge.calls.length = 0
  bridge.state.fail = undefined
  const output = Buffer.from('encoded-bytes')
  bridge.state.response = { ok: true, data: output.toString('base64'), format: 'webp', width: 5, height: 5 }
  const result = await sharpModule.default(png(10, 10))
    .rotate()
    .toColourspace('srgb')
    .resize({ width: 5, height: 5 })
    .webp({ quality: 75, effort: 0 })
    .toBuffer({ resolveWithObject: true })
  assert.ok(Buffer.isBuffer(result.data))
  assert.equal(result.data.toString(), 'encoded-bytes')
  assert.equal(result.info.format, 'webp')
  assert.equal(result.info.width, 5)
  assert.equal(result.info.height, 5)
  assert.equal(result.info.size, output.length)
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].name, 'image.normalize')
  assert.equal(bridge.calls[0].args.rotate, true)
  assert.equal(bridge.calls[0].args.colourspace, 'srgb')
  assert.equal(bridge.calls[0].args.quality, 75)
  assert.equal(bridge.calls[0].args.sourceFormat, 'png')
  assert.equal(Buffer.from(bridge.calls[0].args.data, 'base64').subarray(1, 4).toString(), 'PNG')
})

await test('toBuffer: bridge failure and a data-less response both throw', async () => {
  bridge.state.fail = new bridge.HostBridgeError('host-rejected', 'host-bridge: image.normalize failed [not-implemented]: P2', {
    hostError: 'not-implemented',
    hint: 'image bridge P2',
  })
  try {
    await assert.rejects(() => sharpModule.default(png(2, 2)).toBuffer(), error => {
      assert.equal(error.code, 'host-rejected')
      assert.equal(error.hostError, 'not-implemented')
      assert.equal(error.hint, 'image bridge P2')
      return true
    })
  } finally {
    bridge.state.fail = undefined
  }
  bridge.state.response = { ok: true }
  await assert.rejects(() => sharpModule.default(png(2, 2)).toBuffer(), /returned no data/)
})

await test('resizeInside: fit-inside arithmetic with withoutEnlargement', () => {
  assert.deepEqual(sharpModule.resizeInside(100, 50, 40, 40, true), { width: 40, height: 20 })
  assert.deepEqual(sharpModule.resizeInside(100, 50, 200, 200, true), { width: 100, height: 50 })
  assert.deepEqual(sharpModule.resizeInside(100, 50, 200, 200, false), { width: 200, height: 100 })
  assert.deepEqual(sharpModule.resizeInside(100, 50, undefined, undefined, true), { width: 100, height: 50 })
})

await test('require(esm): the package is a callable sharp replacement (S4 interop)', () => {
  const require = createRequire(import.meta.url)
  const required = require('../lib/index.js')
  assert.equal(typeof required, 'function')
  assert.equal(required, sharpModule.sharp)
  const pipeline = required(png(4, 4))
  assert.equal(pipeline.isSharpReplacement, true)
})

if (failures > 0) {
  console.error(`attachment-image smoke: ${failures} failure(s)`)
  process.exitCode = 1
} else {
  console.log('attachment-image smoke: all checks passed')
}
