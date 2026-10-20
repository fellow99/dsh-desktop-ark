/**
 * Text-difference primitives for `git_diff` and `git_show`.
 *
 * isomorphic-git has no `diff` (see `../dsh-desktop-hos/docs/204-插件-GIT.md` F5), so the two tools that show
 * content differences pair isomorphic-git's blob access with jsdiff's `createTwoFilesPatch`
 * and render the result here. Everything in this module is a pure formatting concern except
 * the jsdiff call itself; nothing here touches the filesystem or the git object store, so the
 * callers stay in charge of *which* bytes are read and *whether* they may be read at all.
 *
 * Two honesty rules shape the API:
 *
 * - **Binary stays binary.** A file holding a NUL byte is reported as differing, never fed to
 *   the line differ — a text diff of a compiled artifact is noise the model cannot use (§11.2).
 * - **Oversize is skipped, never truncated.** `maxDiffBlobBytes` caps what one file may
 *   contribute. A file over the cap produces {@link oversizeDiffNote}; the caller must decide
 *   before reading (a working-tree file's size is known from `lstat`).
 *
 * @module @dsh-ohos/git/diff
 */

import { loadDiff } from './runtime.js'

/** Default number of unchanged context lines around a hunk. */
export const DEFAULT_CONTEXT_LINES = 3

/**
 * Text a caller prints when a file was not diffed because it exceeded the byte cap.
 * @param {string} label - the path label used in the diff header (`a/<path>` style).
 * @param {number} size - the file's size in bytes, when known.
 * @param {number} maxBytes - the configured cap that was exceeded.
 * @returns the model-facing explanation; it always says the diff is missing, never partial.
 */
export function oversizeDiffNote(label, size, maxBytes) {
  const measured = Number.isFinite(size) ? `it is ${size} bytes` : 'its size exceeded the cap'
  return `Skipped ${label}: ${measured}, over the ${maxBytes}-byte diff cap (maxDiffBlobBytes), `
    + 'so the diff was not produced. Nothing was truncated — narrow the pathspec, or raise '
    + 'maxDiffBlobBytes in the plugin config and retry.'
}

/**
 * Text a caller prints for a file that differs but has no text representation.
 * @param {string} beforeLabel - the base-side label.
 * @param {string} afterLabel - the target-side label.
 * @returns the same line `git diff` prints for binary files.
 */
export function binaryDiffNote(beforeLabel, afterLabel) {
  return `Binary files ${beforeLabel} and ${afterLabel} differ (no text diff).`
}

/**
 * Text a caller prints when two sides hold identical bytes.
 * @param {string} label - the path label used in the diff header.
 * @returns the model-facing explanation.
 */
export function noTextChangeNote(label) {
  return `${label}: no text change (the two sides hold identical bytes).`
}

/**
 * Whether a sequence of bytes is binary. A NUL byte anywhere marks the file binary: it is the
 * same cheap, encoding-agnostic test `git` itself uses for its `Binary files … differ` line.
 * @param {Uint8Array | Buffer | string} bytes - the candidate content.
 * @returns true when the content must not be rendered as text.
 */
export function isBinaryBytes(bytes) {
  if (typeof bytes === 'string') return bytes.includes('\u0000')
  if (bytes === undefined || bytes === null) return false
  for (const byte of bytes) {
    if (byte === 0) return true
  }
  return false
}

/**
 * Decode one side to text. Invalid UTF-8 is replaced rather than thrown: a file that decodes
 * badly is still worth showing, and {@link isBinaryBytes} already keeps real binaries out.
 * @param {Uint8Array | Buffer | string} bytes - the content to decode.
 * @returns the decoded text.
 */
export function decodeText(bytes) {
  if (typeof bytes === 'string') return bytes
  if (bytes === undefined || bytes === null) return ''
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * Count the added and removed lines of a unified diff, ignoring the header and any
 * `\ No newline at end of file` marker, so `stat` mode reports the same numbers as the
 * hunks a user would read.
 * @param {string} patch - the unified diff text.
 * @returns the added and removed line counts.
 */
function countPatchLines(patch) {
  let added = 0
  let removed = 0
  let inHunks = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunks = true
      continue
    }
    if (!inHunks || line.startsWith('\\')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * Render one file-versus-file change as a standard unified diff.
 *
 * The two sides are labelled `a/<path>` and `b/<path>` style by the caller, which keeps the
 * output byte-for-byte familiar to any model that has seen `git diff`. Callers must have
 * excluded binary and oversized content already; only text is handled here.
 *
 * @param {Uint8Array | Buffer | string} before - the base-side content.
 * @param {Uint8Array | Buffer | string} after - the target-side content.
 * @param {string} beforeLabel - the `---` label (for example `a/src/index.js`).
 * @param {string} afterLabel - the `+++` label (for example `b/src/index.js`).
 * @param {object} [options] - rendering options.
 * @param {number} [options.context] - unchanged context lines per hunk.
 * @returns the unified diff, with jsdiff's trailing newline removed.
 */
export async function unifiedDiff(before, after, beforeLabel, afterLabel, options = {}) {
  const diff = await loadDiff()
  const context = options.context ?? DEFAULT_CONTEXT_LINES
  const patch = diff.createTwoFilesPatch(
    beforeLabel,
    afterLabel,
    decodeText(before),
    decodeText(after),
    undefined,
    undefined,
    { context },
  )
  // jsdiff answers "these are identical" with a header and no hunk; saying that in words beats
  // handing the model a diff that looks like an empty change.
  if (patch === undefined || !patch.includes('@@')) return noTextChangeNote(beforeLabel)
  return patch.endsWith('\n') ? patch.slice(0, -1) : patch
}

/**
 * Summarise one file-versus-file change as added/removed line counts.
 * @param {Uint8Array | Buffer | string} before - the base-side content.
 * @param {Uint8Array | Buffer | string} after - the target-side content.
 * @param {object} [options] - rendering options.
 * @param {number} [options.context] - unchanged context lines kept in the intermediate patch.
 * @returns the added and removed line counts.
 */
export async function statOf(before, after, options = {}) {
  // `context: 0` keeps the intermediate patch small; the counts do not depend on it.
  const patch = await unifiedDiff(before, after, 'a', 'b', { context: options.context ?? 0 })
  return countPatchLines(patch)
}
