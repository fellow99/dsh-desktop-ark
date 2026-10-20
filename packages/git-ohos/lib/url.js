/**
 * URL redaction for everything that reaches the model or the conversation.
 *
 * Git makes it very easy to keep a password inside the remote address itself —
 * `https://user:token@git.example.com/team/project.git` is accepted by every git client, and
 * `../dsh-desktop-hos/docs/204-插件-GIT.md` §9.2 records that such an address is this plugin's one accepted
 * cleartext boundary. Credentials must therefore never be echoed back: a report that prints the
 * configured remote verbatim, or a failure message that quotes the URL it contacted, would put
 * the token into the transcript (AC-8).
 *
 * The rewrite is deliberately **lexical and lossless elsewhere**: only the userinfo — the part
 * before the first `@` of the authority — is replaced by `***`. Everything after it (host, port,
 * path, query) is returned byte-for-byte, so a redacted URL still identifies the remote and still
 * matches what the user sees in Settings → Git 凭据. A URL without userinfo is returned unchanged,
 * which keeps `credentialRefForUrl`-derived names and every ordinary report identical to what they
 * were before.
 *
 * @module @dsh-ohos/git/url
 */

/**
 * A scheme followed by an authority whose userinfo ends at the first `@`.
 *
 * The character class stops at `/`, `?` and `#`, so an `@` inside a path (`.../a@b/c`) can never
 * be mistaken for the userinfo terminator, and a relative path or a bare remote name (which has no
 * `scheme://`) never matches at all.
 */
const SCHEME_WITH_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i

/** What replaces a redacted userinfo. */
export const REDACTED_USERINFO = '***'

/**
 * Return a URL that is safe to print.
 * @param url - the remote address, possibly carrying `user:password@`.
 * @returns the address with its userinfo replaced by `***`, or the input unchanged.
 */
export function scrubUrl(url) {
  if (typeof url !== 'string') return ''
  return url.replace(SCHEME_WITH_USERINFO, `$1${REDACTED_USERINFO}@`)
}

/**
 * Whether printing this URL verbatim would disclose a credential.
 * @param url - the remote address.
 * @returns true when the URL carries userinfo.
 */
export function hasUserinfo(url) {
  return typeof url === 'string' && scrubUrl(url) !== url
}

/**
 * Redact a raw URL inside an error message.
 *
 * isomorphic-git and the HTTP layer sometimes quote the address they contacted, and those
 * messages are re-thrown to the model as-is (the fence preserves an error it cannot classify).
 * When — and only when — the message really contains the raw address, the text is rewritten and
 * the error's identity (`name`, `code`, `data`) is carried over so downstream classification
 * (status codes, `NotFoundError`, …) is unaffected.
 *
 * @param error - the error about to be attributed to a remote call.
 * @param url - the address that call used.
 * @returns the error to throw: the original when nothing leaked, else a redacted equivalent.
 */
export function scrubErrorUrl(error, url) {
  if (!hasUserinfo(url) || !(error instanceof Error) || typeof error.message !== 'string') return error
  if (!error.message.includes(url)) return error
  const redacted = new Error(error.message.split(url).join(scrubUrl(url)), { cause: error })
  redacted.name = error.name
  if (error.code !== undefined) redacted.code = error.code
  if (error.data !== undefined) redacted.data = error.data
  return redacted
}
