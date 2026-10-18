/**
 * Sentinel-line framing for the persistent `/system/bin/sh` used by
 * `@dsh-ohos/shell`.
 *
 * HarmonyOS has no PTY, so `ctx.shell` runs one long-lived `sh` and delimits
 * each call with a random marker:
 *
 *   printf '%s\n' '__DSH_BEGIN_<nonce>__'
 *   (
 *   cd -- '<workdir>' || exit 125
 *   <command>
 *   )
 *   printf '\n%s %s\n' '__DSH_END_<nonce>__' "$?"
 *
 * The command runs in a subshell, so `cd`, variable assignments, and `exit`
 * cannot leak into the next call ("`cd` must not persist across calls").
 * The marker line is stripped from captured output; the exit status is parsed
 * from the end marker.
 *
 * @module @dsh-ohos/shell/framing
 */

/** Prefix of the per-call begin marker. */
export const BEGIN_PREFIX = '__DSH_BEGIN_'

/** Prefix of the per-call end marker. */
export const END_PREFIX = '__DSH_END_'

/** Exit status reserved for "cannot enter the requested working directory". */
export const CD_FAILED = 125

/**
 * Quote one value as a single POSIX shell word.
 * @param {string} value
 * @returns {string}
 */
export function quoteForPosixShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Build the script text written to the persistent shell's stdin.
 * @param {{ nonce: string, workdir: string, command: string }} input
 * @returns {string}
 */
export function buildScript({ nonce, workdir, command }) {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(nonce)) {
    throw new TypeError('shell-ohos: nonce must be 16-64 lowercase hex characters')
  }
  if (typeof workdir !== 'string' || workdir === '') throw new TypeError('shell-ohos: workdir must be a non-empty absolute path')
  if (typeof command !== 'string') throw new TypeError('shell-ohos: command must be a string')
  const begin = `${BEGIN_PREFIX}${nonce}__`
  const end = `${END_PREFIX}${nonce}__`
  return [
    `printf '%s\\n' ${quoteForPosixShell(begin)}`,
    '(',
    `cd -- ${quoteForPosixShell(workdir)} || exit ${CD_FAILED}`,
    command,
    ')',
    `printf '\\n%s %s\\n' ${quoteForPosixShell(end)} "$?"`,
    '',
  ].join('\n')
}

/**
 * Incremental parser for one framed call.
 *
 * Feed decoded stdout text with {@link FrameParser.push}; each push returns the
 * newly available output body (markers excluded). When the end marker arrives,
 * `result` is set to `{ exitCode, rest }` and further pushes are ignored.
 */
export class FrameParser {
  /** @param {string} nonce */
  constructor(nonce) {
    this.beginToken = `${BEGIN_PREFIX}${nonce}__`
    this.endToken = `${END_PREFIX}${nonce}__`
    this.buffer = ''
    this.started = false
    this.completed = false
    /** @type {{ exitCode: number, rest: string } | undefined} */
    this.result = undefined
  }

  /**
   * @param {string} text
   * @returns {{ body: string, started: boolean, completed: boolean, exitCode?: number, rest?: string }}
   */
  push(text) {
    if (this.completed) return { body: '', started: this.started, completed: true, ...(this.result ?? {}) }
    this.buffer += text
    if (!this.started) {
      const beginAt = this.buffer.indexOf(this.beginToken)
      if (beginAt < 0) {
        // Keep only enough to match a marker split across chunks.
        const keep = this.beginToken.length + 8
        if (this.buffer.length > keep) this.buffer = this.buffer.slice(-keep)
        return { body: '', started: false, completed: false }
      }
      const lineEnd = this.buffer.indexOf('\n', beginAt + this.beginToken.length)
      if (lineEnd < 0) {
        this.buffer = this.buffer.slice(beginAt)
        return { body: '', started: false, completed: false }
      }
      this.buffer = this.buffer.slice(lineEnd + 1)
      this.started = true
    }

    const endAt = this.buffer.indexOf(this.endToken)
    if (endAt < 0) {
      // Hold back a tail long enough to contain a split end marker.
      const keep = this.endToken.length + 20
      if (this.buffer.length > keep) {
        const body = this.buffer.slice(0, -keep)
        this.buffer = this.buffer.slice(-keep)
        return { body, started: true, completed: false }
      }
      return { body: '', started: true, completed: false }
    }

    // The end marker is printed after a separator newline; strip exactly one.
    let body = this.buffer.slice(0, endAt)
    if (body.endsWith('\n')) body = body.slice(0, -1)
    const after = this.buffer.slice(endAt + this.endToken.length)
    const match = /^[ \t]+(\d{1,3})\r?\n?/.exec(after)
    if (match === null) {
      // The status digits are not here yet: wait for more bytes.
      this.buffer = this.buffer.slice(this.buffer.indexOf(this.endToken))
      return { body, started: true, completed: false }
    }
    const exitCode = Number(match[1])
    const rest = after.slice(match[0].length)
    this.completed = true
    this.result = { exitCode, rest }
    this.buffer = ''
    return { body, started: true, completed: true, exitCode, rest }
  }
}
