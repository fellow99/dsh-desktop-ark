/**
 * Bounded output tails and spill files for the OHOS subprocess provider.
 *
 * This mirrors the upstream `@deepseek-ai/dsh-subprocess-local` collector
 * (`packages/subprocess/subprocess-local/src/output.ts:129-316`) so consumers
 * keep the exact seam semantics:
 * - `readFrom(fromByte)` uses whole-stream byte coordinates and never consumes:
 *   independent readers see the same bytes.
 * - a read whose offset fell out of the retained window is `lossy` and returns
 *   the whole retained tail; `spillPath` (when the complete stream fits under
 *   `spill.maxBytes`) names a file holding every byte.
 * - the retained window is the LAST `maxBytes` of the stream (tail-keep).
 *
 * @module @dsh-ohos/subprocess/output
 */

import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

let spillCounter = 0

/** Collects one stream with a bounded in-memory tail and optional spill file. */
export class TailCollector {
  /**
   * @param {number} maxBytes - in-memory tail cap.
   * @param {string} label - stream label used in spill file names.
   * @param {{ maxBytes: number, dir: string }} [spill] - spill storage; omit for tail-only.
   */
  constructor(maxBytes, label, spill) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('subprocess-ohos: collect maxBytes must be a positive finite number')
    this.maxBytes = maxBytes
    this.label = label
    this.spill = spill
    this.spillDisabled = spill === undefined
    this.chunks = []
    this.bytes = 0
    this.dropped = false
    this.total = 0
    this.spillFd = undefined
    this.spillFile = undefined
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (this.spill !== undefined && !this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(this.spill, chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /**
   * Append to the spill file, opening it lazily. Best effort: a filesystem
   * failure disables spilling and never interrupts collection (this runs in a
   * stream 'data' listener, where a throw would become an uncaught exception).
   * @param {{ maxBytes: number, dir: string }} spill
   * @param {Buffer} chunk
   */
  spillAll(spill, chunk) {
    if (this.total > spill.maxBytes) {
      this.discardSpill()
      return
    }
    try {
      if (this.spillFd === undefined) {
        mkdirSync(spill.dir, { recursive: true })
        const file = join(spill.dir, `dsh-ohos-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`)
        const fd = openSync(file, 'wx', 0o600)
        this.spillFile = file
        this.spillFd = fd
        for (const prior of this.chunks) writeSync(fd, prior)
      }
      writeSync(this.spillFd, chunk)
    } catch {
      this.discardSpill()
    }
  }

  discardSpill() {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // The unlink failure leaves at most maxSpillBytes behind.
      }
    }
  }

  /**
   * Incremental read in whole-stream byte coordinates.
   * @param {number} fromByte
   * @returns {{ text: string, nextOffset: number, lossy: boolean, spillPath?: string }}
   */
  readFrom(fromByte) {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...(this.spillFile !== undefined ? { spillPath: this.spillFile } : {}),
    }
  }

  /** Close the spill file once the stream ended; idempotent. */
  seal() {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }

  /** @returns {{ text: string, truncated: boolean, spillPath?: string }} */
  finalize() {
    this.seal()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...(this.spillFile !== undefined ? { spillPath: this.spillFile } : {}),
    }
  }
}

/**
 * Non-consuming reader view over one collector, shaped like the seam's
 * `SubprocessOutputReader`.
 * @param {TailCollector} collector
 * @returns {{ readFrom: (fromByte: number) => { text: string, nextOffset: number, lossy: boolean, spillPath?: string } }}
 */
export function readerOf(collector) {
  return { readFrom: fromByte => collector.readFrom(fromByte) }
}
