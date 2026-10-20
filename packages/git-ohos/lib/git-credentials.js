/**
 * git's own credential file, `<dsh config dir>/.git-credentials`.
 *
 * This is the format `git credential-store` writes and reads (git's "Credential Storage" chapter):
 * plain text, **one credential per line, each line a URL carrying the userinfo** —
 *
 * ```
 * https://alice:s3cret@git.example.com
 * http://bob:pw%3Awith%3Acolons@git.example.com:8080
 * ```
 *
 * Keeping that shape rather than inventing one buys three things a bespoke store cannot: a user can
 * copy the file from a workstation, `git` itself (and every other tool that speaks this format) can
 * read it, and it can be edited by hand with a text editor. The file lives in dsh's own config
 * directory so a single `$DSH_HOME` copy carries the shell's git credentials with it.
 *
 * Permissions matter here: the file holds cleartext, so {@link writeCredentials} creates it with
 * mode `0600` (git does the same) and never widens the mode of an existing file.
 *
 * Nothing here talks to the plugin's own credential store — `lib/auth.js` owns the precedence
 * between the two sources; this module only knows how to parse, match, and write the file.
 *
 * @module @dsh-ohos/git/git-credentials
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The file's name below the dsh config directory. */
export const GIT_CREDENTIALS_BASENAME = '.git-credentials'

/** Line terminator used when writing; git accepts both, `\n` keeps the file diff-friendly. */
const EOL = '\n'

/**
 * The dsh config directory: `$DSH_HOME` when the deployment sets it, else `~/.dsh`.
 * @param env - environment to read (defaults to `process.env`); injectable for tests.
 * @returns the directory that holds `.credentials.yaml`, `profiles/`, and this file.
 */
export function dshConfigDir(env = process.env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') return env.DSH_HOME
  return join(env.HOME || env.USERPROFILE || homedir(), '.dsh')
}

/**
 * Absolute path of the credential file.
 * @param env - environment to read (defaults to `process.env`).
 * @returns the path of `<dsh config dir>/.git-credentials`.
 */
export function gitCredentialsPath(env = process.env) {
  return join(dshConfigDir(env), GIT_CREDENTIALS_BASENAME)
}

/**
 * Parse the file into credential records.
 *
 * Tolerant on purpose: blank lines and `#` comments are skipped, and a line that is not a URL (or
 * that carries no userinfo) is ignored rather than throwing — a hand-edited file should never make
 * every git operation in the shell fail.
 *
 * @param text - the file's contents.
 * @returns one record per usable line, in file order.
 */
export function parseCredentials(text) {
  const entries = []
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim()
    if (raw === '' || raw.startsWith('#')) continue
    let url
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.username === '' && url.password === '') continue
    entries.push({
      line: index + 1,
      protocol: url.protocol.replace(/:$/, '').toLowerCase(),
      host: url.host.toLowerCase(),
      path: url.pathname === '' ? '/' : url.pathname,
      username: safeDecode(url.username),
      password: safeDecode(url.password),
      raw,
    })
  }
  return entries
}

/**
 * Pick the credential git would use for a URL.
 *
 * Matching follows `git credential-store`: protocol and host must be equal (git compares the host
 * case-insensitively, port included), a record whose path is a prefix of the request's path wins
 * over one with the bare host, a record carrying the same username wins over an anonymous one, and
 * among equally specific records the last one in the file wins — the same "later lines override
 * earlier ones" reading `git credential-store` documents.
 *
 * @param entries - records from {@link parseCredentials}.
 * @param url - the remote URL being authenticated.
 * @returns the chosen credential, or `undefined` when the file has nothing for that URL.
 */
export function matchCredential(entries, url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase()
  const host = parsed.host.toLowerCase()
  const path = parsed.pathname === '' ? '/' : parsed.pathname
  let best
  let bestScore = -1
  for (const entry of entries) {
    if (entry.protocol !== protocol || entry.host !== host) continue
    if (entry.path !== '/' && entry.path !== '' && !path.startsWith(entry.path)) continue
    // Path specificity outweighs "carries a username": a credential scoped to a path is the more
    // deliberate answer, while a username only narrows a host-wide line. Equal scores fall back to
    // the last line in the file, the override rule `git credential-store` documents.
    const score = (entry.path === '/' || entry.path === '' ? 0 : 2) + (entry.username === '' ? 0 : 1)
    if (score >= bestScore) {
      bestScore = score
      best = entry
    }
  }
  return best === undefined
    ? undefined
    : { username: best.username, password: best.password, source: 'git-credentials', line: best.line }
}

/**
 * Format one credential the way the file stores it: a URL with userinfo.
 *
 * `encodeURIComponent` is applied to both fields because the format is a URL — a password holding
 * `@`, `:` or `/` must survive the round trip, and a raw `:` in the userinfo would be read back as
 * the username/password separator.
 *
 * @param credential - the credential to serialise.
 * @param credential.protocol - `https` or `http`.
 * @param credential.host - host, port included.
 * @param credential.username - the username.
 * @param credential.password - the password.
 * @returns one file line, without its terminator.
 */
export function formatCredential({ protocol, host, username, password }) {
  return `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`
}

/**
 * Read and parse the file.
 *
 * A missing file is not an error — it means "no git-format credentials yet" — and an unreadable one
 * (permissions, a directory in the way) degrades to the same answer instead of failing a git call.
 *
 * @param env - environment to read (defaults to `process.env`).
 * @returns `{ path, exists, entries }`.
 */
export function readCredentials(env = process.env) {
  const path = gitCredentialsPath(env)
  try {
    return { path, exists: true, entries: parseCredentials(readFileSync(path, 'utf8')) }
  } catch {
    return { path, exists: false, entries: [] }
  }
}

/**
 * Insert or replace one credential, leaving every other line (and every comment) untouched.
 *
 * The write goes through a sibling temp file and a rename so a crash cannot leave a half-written
 * credential file behind, and the result is forced to `0600` — a file that started world-readable
 * (someone's `cp` from a backup) must not stay that way once we have touched it.
 *
 * @param credential - the credential to store.
 * @param credential.protocol - `https` or `http`.
 * @param credential.host - host, port included.
 * @param credential.username - the username.
 * @param credential.password - the password.
 * @param env - environment to read (defaults to `process.env`).
 * @returns the path written.
 */
export function writeCredentials({ protocol, host, username, password }, env = process.env) {
  const path = gitCredentialsPath(env)
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    text = ''
  }
  const lines = text.split(/\r?\n/)
  // Keep the file's trailing-newline shape predictable: drop the empty tail split() produces.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const wanted = formatCredential({ protocol, host, username, password })
  const wantedKey = keyOf({ protocol, host, username })
  let replaced = false
  for (let index = 0; index < lines.length; index += 1) {
    const entry = parseCredentials(lines[index])[0]
    if (entry === undefined) continue
    if (keyOf(entry) !== wantedKey) continue
    if (lines[index] === wanted) {
      replaced = true
      break
    }
    lines[index] = wanted
    replaced = true
    break
  }
  if (!replaced) lines.push(wanted)
  const body = `${lines.join(EOL)}${EOL}`
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, body, { mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // A filesystem that cannot chmod (this platform refuses some modes) still gets the write; the
    // mode request above already carries the intent where it is honoured.
  }
  renameSync(temp, path)
  return path
}

/**
 * Remove one credential, leaving the rest of the file alone.
 * @param target - the credential's identity: protocol, host and username.
 * @param target.protocol - `https` or `http`.
 * @param target.host - host, port included.
 * @param target.username - the username.
 * @param env - environment to read (defaults to `process.env`).
 * @returns true when a line was removed.
 */
export function removeCredentials({ protocol, host, username }, env = process.env) {
  const path = gitCredentialsPath(env)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const wantedKey = keyOf({ protocol, host, username })
  const kept = []
  let removed = false
  for (const line of text.split(/\r?\n/)) {
    const entry = parseCredentials(line)[0]
    if (entry !== undefined && keyOf(entry) === wantedKey) {
      removed = true
      continue
    }
    kept.push(line)
  }
  if (!removed) return false
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  const body = kept.length === 0 ? '' : `${kept.join(EOL)}${EOL}`
  if (body === '') {
    try {
      unlinkSync(path)
    } catch {
      writeFileSync(path, '', { mode: 0o600 })
    }
    return true
  }
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, body, { mode: 0o600 })
  renameSync(temp, path)
  return true
}

/**
 * Whether the file exists and is non-empty, for a caller that only needs the state.
 * @param env - environment to read (defaults to `process.env`).
 * @returns true when at least one credential line is present.
 */
export function hasCredentials(env = process.env) {
  const { exists, entries } = readCredentials(env)
  return exists && entries.length > 0
}

/**
 * The identity a credential is stored under: protocol + host + username.
 *
 * Path is deliberately not part of it: git's own helper treats a line's path as a *match restriction*
 * on an otherwise host-wide credential, so replacing "the credential for this host and user" must not
 * depend on which path the line happened to carry.
 * @param credential - protocol, host and username.
 * @returns a comparable key.
 */
function keyOf({ protocol, host, username }) {
  return `${String(protocol).toLowerCase()}|${String(host).toLowerCase()}|${username}`
}

/**
 * `decodeURIComponent` that tolerates the percent sequences a hand-edited file can get wrong.
 * @param value - the raw userinfo field.
 * @returns the decoded field, or the input when it is not valid percent-encoding.
 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

