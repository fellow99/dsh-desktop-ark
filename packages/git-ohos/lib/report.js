/**
 * Model-facing rendering of isomorphic-git return values.
 *
 * Every function here is a pure `data -> text` mapping: no IO, no git calls, no policy
 * decisions. The tools collect plain data (blobs, matrices, `PushResult`s) and hand it over,
 * which keeps the wording in one place and makes it testable without a repository.
 *
 * Three house rules, from `../dsh-desktop-hos/docs/204-插件-GIT.md` §10 and §13:
 *
 * - **No empty answers.** A renderer that receives nothing says so in words ("no changes",
 *   "no commits", "the stash is empty"); an empty string reads as a silent success.
 * - **Failures keep the server's words.** `renderPushResult` prints the remote's own `error`
 *   verbatim — a rejected push is never dressed up as a success.
 * - **Nothing about credentials.** These renderers never see a credential, and every URL they
 *   print goes through `scrubUrl` — an address that carries its own `user:password@` can therefore
 *   never put that password into the conversation (AC-8).
 *
 * @module @dsh-ohos/git/report
 */

import { scrubUrl } from './url.js'

/**
 * `git status --short` codes for the status matrix, straight from the documented mapping of
 * `(head, workdir, stage)` triples (see isomorphic-git's `statusMatrix`).
 */
const SHORT_STATUS = new Map([
  ['0,0,0', ''],
  ['0,0,3', 'AD'],
  ['0,2,0', '??'],
  ['0,2,2', 'A '],
  ['0,2,3', 'AM'],
  ['1,0,0', 'D '],
  ['1,0,1', ' D'],
  ['1,0,3', 'MD'],
  // `1,1,0` is a *staged* deletion — HEAD has the file, the index does not, and the worktree copy
  // that still matches HEAD is now untracked. git prints `D ` in the first column and does not
  // list the path a second time; printing ` D` here made the path look worktree-deleted and made
  // it appear in two groups at once.
  ['1,1,0', 'D '],
  ['1,1,1', ''],
  ['1,1,3', 'MM'],
  ['1,2,0', 'D '],
  ['1,2,1', ' M'],
  ['1,2,2', 'M '],
  ['1,2,3', 'MM'],
])

/** Single-letter code for one change-list status. */
const CHANGE_LETTERS = { added: 'A', modified: 'M', deleted: 'D', 'type-change': 'T' }

/**
 * The short form of an object id, as it appears in every rendered list.
 * @param {string | undefined} oid - the full object id.
 * @param {number} [length] - how many leading characters to keep.
 * @returns the short id, or `undefined` when there is no id.
 */
export function shortOid(oid, length = 10) {
  if (typeof oid !== 'string' || oid === '') return undefined
  return oid.length <= length ? oid : oid.slice(0, length)
}

/**
 * Format a git author/committer timestamp with the timezone it was recorded in, so a commit
 * made anywhere in the world reads unambiguously.
 * @param {number} timestamp - seconds since the Unix epoch, UTC.
 * @param {number} [timezoneOffset] - minutes from local time to UTC, as git records it.
 * @returns an ISO-8601-like local timestamp with an explicit offset.
 */
export function formatTimestamp(timestamp, timezoneOffset) {
  const offset = Number.isFinite(timezoneOffset) ? timezoneOffset : 0
  const shifted = new Date((timestamp - offset * 60) * 1000)
  const pad = value => String(Math.abs(value)).padStart(2, '0')
  const sign = offset <= 0 ? '+' : '-'
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  return `${date}T${time}${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
}

/**
 * Format one `Name <email>` pair, tolerating the empty email a git config may hold.
 * @param {object | undefined} identity - an author, committer or tagger object.
 * @returns the formatted identity, or `undefined` when there is none.
 */
function formatIdentity(identity) {
  if (identity === undefined || identity === null) return undefined
  const name = typeof identity.name === 'string' ? identity.name : ''
  const email = typeof identity.email === 'string' ? identity.email : ''
  return email === '' ? name : `${name} <${email}>`
}

/**
 * Classify one status-matrix row into the groups `git_status` reports.
 *
 * The matrix contains a row for **every** path it walked, including ones where nothing changed
 * (`1,1,1`), so `changed` is what callers count, not the row count.
 *
 * @param {[string, number, number, number]} row - one `[filepath, head, workdir, stage]` row.
 * @returns the path, its short code, the groups it belongs to, and whether it changed at all.
 */
export function classifyStatusRow(row) {
  const [path, head, workdir, stage] = row
  const code = SHORT_STATUS.get(`${head},${workdir},${stage}`) ?? '??'
  const untracked = stage === 0 && workdir === 2
  const staged = stage !== head && !(head === 0 && stage === 0)
  // The second column is the workdir-versus-index column, so it is 'M' whenever the working
  // tree holds something the index does not — including the case where the workdir still
  // matches HEAD while the index has moved on (the documented `MM` row).
  const modified = code[1] === 'M'
  const deleted = code[0] === 'D' || code[1] === 'D'
  return {
    path,
    code: code === '' ? '  ' : code,
    staged,
    modified,
    deleted,
    untracked,
    changed: staged || modified || deleted || untracked,
  }
}

/**
 * Render a repository's state: staged, modified, deleted, untracked and conflicted paths.
 * @param {Array<[string, number, number, number]>} rows - the `statusMatrix` result.
 * @param {object} [options] - rendering options.
 * @param {string} [options.root] - the repository root, printed as a header.
 * @param {string | undefined} [options.branch] - the checked-out branch, `undefined` when detached.
 * @param {string} [options.head] - the object id HEAD resolves to.
 * @param {string[]} [options.conflicts] - paths whose working-tree copy still holds conflict markers.
 * @returns the model-facing report; never empty.
 */
export function renderStatus(rows, options = {}) {
  const entries = rows.map(classifyStatusRow)
  const conflicting = new Set(options.conflicts ?? [])
  const lines = []
  if (options.root !== undefined) lines.push(`Repository: ${options.root}`)
  const head = shortOid(options.head)
  const branch = options.branch === undefined
    ? `detached HEAD${head === undefined ? '' : ` at ${head}`}`
    : `branch ${options.branch}${head === undefined ? '' : ` (HEAD ${head})`}`
  lines.push(`On ${branch}`)

  // Each path is listed under exactly one group, in the order git itself would report it: an entry
  // that is staged belongs to "Staged for commit" even when the same path is also deleted in the
  // working tree (`MD`) or deleted from the index (`D `), so no path is counted twice.
  const groups = [
    ['Staged for commit', entries.filter(entry => entry.staged)],
    ['Modified in the working tree, not staged', entries.filter(entry => !entry.staged && entry.modified && !entry.untracked)],
    ['Deleted', entries.filter(entry => !entry.staged && entry.deleted)],
    ['Untracked', entries.filter(entry => entry.untracked)],
  ]
  const conflicted = entries.filter(entry => conflicting.has(entry.path))
  const changed = entries.filter(entry => entry.changed)

  if (changed.length === 0 && conflicted.length === 0) {
    lines.push('')
    lines.push('No changes: HEAD, the index and the working tree all agree.')
    return lines.join('\n')
  }

  for (const [title, group] of groups) {
    if (group.length === 0) continue
    lines.push('')
    lines.push(`${title} (${group.length}):`)
    for (const entry of group) {
      const note = entry.path !== undefined && conflicting.has(entry.path) ? ' (conflicted)' : ''
      lines.push(`  ${entry.code} ${entry.path}${note}`)
    }
  }

  if (conflicted.length > 0) {
    lines.push('')
    lines.push(`Conflicted (${conflicted.length}) — resolve these before committing; the working tree `
      + 'still holds the merge conflict markers:')
    for (const entry of conflicted) lines.push(`  ${entry.code} ${entry.path}`)
  }

  return lines.join('\n')
}

/**
 * Render a list of commits, newest first.
 * @param {Array<{oid: string, commit: object}>} commits - the `log` result.
 * @param {object} [options] - rendering options.
 * @param {string} [options.ref] - the ref the walk started from.
 * @param {string} [options.root] - the repository root, printed as a header.
 * @returns the model-facing report; never empty.
 */
export function renderLog(commits, options = {}) {
  if (commits.length === 0) {
    return `No commits: ${options.ref ?? 'HEAD'} resolves to no commit yet (a freshly initialized `
      + 'repository has none until the first `git_commit`).'
  }
  const lines = []
  if (options.root !== undefined) lines.push(`Repository: ${options.root}`)
  lines.push(`${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} from `
    + `${options.ref ?? 'HEAD'}, newest first:`)
  for (const entry of commits) {
    const author = entry.commit.author ?? {}
    const subject = String(entry.commit.message ?? '').split('\n')[0]
    const extra = String(entry.commit.message ?? '').split('\n').length - 1
    const parents = Array.isArray(entry.commit.parent) ? entry.commit.parent : []
    lines.push(`- ${shortOid(entry.oid, 12)} ${formatTimestamp(author.timestamp, author.timezoneOffset)} `
      + `${formatIdentity(author)} [${parents.length === 0 ? 'root' : `${parents.length} parent(s)`}] ${subject}`
      + `${extra > 0 ? ` (+${extra} more lines)` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Render one commit's metadata: identity, date, parents, tree and full message.
 * @param {{oid: string, commit: object}} result - a `readCommit` (or `log`) entry.
 * @param {object} [options] - rendering options.
 * @param {string} [options.title] - a heading line (for example `git_show`).
 * @returns the model-facing report; never empty.
 */
export function renderCommitMeta(result, options = {}) {
  const commit = result.commit
  const lines = []
  if (options.title !== undefined) lines.push(options.title)
  lines.push(`commit ${result.oid}`)
  const author = formatIdentity(commit.author)
  if (author !== undefined) {
    lines.push(`Author:  ${author}`)
    lines.push(`Date:    ${formatTimestamp(commit.author.timestamp, commit.author.timezoneOffset)}`)
  }
  const committer = formatIdentity(commit.committer)
  if (committer !== undefined && (committer !== author
    || commit.committer.timestamp !== commit.author?.timestamp)) {
    lines.push(`Committer: ${committer}`)
    lines.push(`Committed: ${formatTimestamp(commit.committer.timestamp, commit.committer.timezoneOffset)}`)
  }
  const parents = Array.isArray(commit.parent) ? commit.parent : []
  lines.push(`Parents: ${parents.length === 0 ? 'none (root commit)' : parents.join(' ')}`)
  lines.push(`Tree:    ${commit.tree}`)
  if (typeof commit.gpgsig === 'string' && commit.gpgsig !== '') lines.push('Signed:  yes (PGP signature present)')
  lines.push('')
  const message = String(commit.message ?? '').replace(/\n+$/, '')
  lines.push(message === '' ? '(empty commit message)' : message)
  return lines.join('\n')
}

/**
 * Render a change list: the paths that differ between two sides.
 * @param {Array<{status: 'added'|'modified'|'deleted'|'type-change', path: string, detail?: string}>} changes - the changes.
 * @param {object} [options] - rendering options.
 * @param {string} [options.title] - the heading line; `git_show` uses it to name the commit.
 * @param {string} [options.empty] - the wording used when there are no changes.
 * @returns the model-facing report; never empty.
 */
export function renderChangeList(changes, options = {}) {
  if (changes.length === 0) {
    return options.empty ?? 'No changed paths: the two sides are identical.'
  }
  const lines = []
  if (options.title !== undefined) lines.push(options.title)
  lines.push(`${changes.length} changed ${changes.length === 1 ? 'path' : 'paths'}:`)
  for (const change of changes) {
    const detail = change.detail === undefined ? '' : `  ${change.detail}`
    lines.push(`  ${CHANGE_LETTERS[change.status] ?? '?'}  ${change.path}${detail}`)
  }
  return lines.join('\n')
}

/**
 * Render the paths that block an operation.
 *
 * `git_revert` and the conflict paths of a merge both use this: the model needs the exact list
 * to tell the user, and it must never look like a partial success.
 * @param {string[]} paths - the blocking paths.
 * @param {object} [options] - rendering options.
 * @param {string} [options.reason] - one line saying what the paths block.
 * @param {string} [options.next] - one line saying what to do about it.
 * @returns the model-facing report; never empty.
 */
export function renderConflicts(paths, options = {}) {
  if (paths.length === 0) return 'No conflicting paths.'
  const lines = [options.reason ?? `${paths.length} conflicting ${paths.length === 1 ? 'path' : 'paths'}:`]
  for (const path of paths) lines.push(`  - ${path}`)
  if (options.next !== undefined) lines.push(options.next)
  return lines.join('\n')
}

/**
 * Render local or remote-tracking branches.
 * @param {string[]} branches - the `listBranches` result.
 * @param {object} [options] - rendering options.
 * @param {string} [options.current] - the current branch, marked with `*`.
 * @param {string} [options.remote] - the remote whose tracking branches these are.
 * @returns the model-facing report; never empty.
 */
export function renderBranches(branches, options = {}) {
  const kind = options.remote === undefined ? 'local' : `remote-tracking (${options.remote})`
  if (branches.length === 0) {
    return options.remote === undefined
      ? 'No branches: this repository has no branch yet (a fresh repository gains one with its first commit).'
      : `No ${kind} branches: nothing has been fetched from "${options.remote}" yet.`
  }
  const lines = [`${branches.length} ${kind} ${branches.length === 1 ? 'branch' : 'branches'}:`]
  for (const branch of branches) lines.push(`  ${branch === options.current ? '*' : ' '} ${branch}`)
  if (options.current !== undefined) lines.push(`(* = checked out; HEAD is on "${options.current}")`)
  else lines.push('(* = checked out; HEAD is detached)')
  return lines.join('\n')
}

/**
 * Render tags.
 * @param {string[]} tags - the `listTags` result.
 * @returns the model-facing report; never empty.
 */
export function renderTags(tags) {
  if (tags.length === 0) return 'No tags in this repository.'
  return `${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}:\n${tags.map(tag => `  ${tag}`).join('\n')}`
}

/**
 * Render the configured remotes.
 * @param {Array<{remote: string, url: string}>} remotes - the `listRemotes` result.
 * @returns the model-facing report; never empty.
 */
export function renderRemotes(remotes) {
  if (remotes.length === 0) return 'No remotes configured in this repository.'
  const lines = [`${remotes.length} ${remotes.length === 1 ? 'remote' : 'remotes'}:`]
  for (const remote of remotes) lines.push(`  ${remote.remote}  ${scrubUrl(remote.url)}`)
  return lines.join('\n')
}

/**
 * Render the server's refs, as returned by `listServerRefs`.
 * @param {Array<{ref: string, oid: string, target?: string, peeled?: string}>} refs - the server refs.
 * @param {object} [options] - rendering options.
 * @param {string} [options.url] - the remote URL that was queried.
 * @param {string} [options.prefix] - the ref prefix that was requested.
 * @returns the model-facing report; never empty.
 */
export function renderServerRefs(refs, options = {}) {
  const where = options.url === undefined ? 'the remote' : scrubUrl(options.url)
  if (refs.length === 0) {
    return `${where} returned no refs${options.prefix === undefined ? '' : ` under "${options.prefix}"`}: `
      + 'the repository is empty, the prefix matches nothing, or the refs are hidden.'
  }
  const lines = [`${where}: ${refs.length} ${refs.length === 1 ? 'ref' : 'refs'}`
    + `${options.prefix === undefined ? '' : ` under "${options.prefix}"`}:`]
  for (const entry of refs) {
    const target = entry.target === undefined ? '' : ` -> ${entry.target}`
    const peeled = entry.peeled === undefined ? '' : ` (peels to ${shortOid(entry.peeled)})`
    lines.push(`  ${entry.ref}  ${shortOid(entry.oid)}${target}${peeled}`)
  }
  return lines.join('\n')
}

/**
 * Render a remote's capabilities, as returned by `getRemoteInfo2`.
 * @param {object} info - the `getRemoteInfo2` result.
 * @param {object} [options] - rendering options.
 * @param {string} [options.url] - the remote URL that was queried.
 * @returns the model-facing report; never empty.
 */
export function renderRemoteInfo(info, options = {}) {
  const where = options.url === undefined ? 'the remote' : scrubUrl(options.url)
  const capabilities = Object.keys(info.capabilities ?? {})
  const lines = [`${where}: git protocol version ${info.protocolVersion ?? 'unknown'}`]
  lines.push(capabilities.length === 0
    ? 'The server advertised no capabilities.'
    : `Capabilities (${capabilities.length}): ${capabilities.join(', ')}`)
  const refs = info.refs
  if (!Array.isArray(refs)) {
    lines.push('Refs: protocol version 2 does not return them here; use the "refs" action of git_remote '
      + '(listServerRefs) to list them.')
    return lines.join('\n')
  }
  lines.push(renderServerRefs(refs, options))
  return lines.join('\n')
}

/**
 * Render the stash reflog.
 * @param {string[]} entries - the `stash` `list` result.
 * @returns the model-facing report; never empty.
 */
export function renderStashEntries(entries) {
  if (entries.length === 0) return 'The stash is empty.'
  return `Stash (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, newest first):\n`
    + entries.map((entry, index) => `  [${index}] ${entry}`).join('\n')
}

/**
 * Render the outcome of a fetch.
 * @param {object} result - the `fetch` result.
 * @param {object} [options] - rendering options.
 * @param {string} [options.remote] - the remote that was fetched.
 * @param {string} [options.url] - the remote URL that was contacted.
 * @returns the model-facing report; never empty.
 */
export function renderFetchResult(result, options = {}) {
  const where = options.remote === undefined
    ? (options.url === undefined ? 'the remote' : scrubUrl(options.url))
    : `"${options.remote}"`
  const lines = []
  const head = shortOid(result.fetchHead)
  if (head === undefined) {
    lines.push(`Fetched ${where}: the remote reported no head to update, so there was nothing new.`)
  } else {
    lines.push(`Fetched ${where}: ${head} ${result.fetchHeadDescription ?? ''}`.trimEnd())
  }
  if (result.defaultBranch !== undefined && result.defaultBranch !== null) {
    lines.push(`Default branch on the remote: ${result.defaultBranch}`)
  }
  const pruned = result.pruned
  lines.push(Array.isArray(pruned) && pruned.length > 0
    ? `Pruned ${pruned.length} stale remote-tracking ${pruned.length === 1 ? 'branch' : 'branches'}: ${pruned.join(', ')}`
    : 'Nothing was pruned (no stale remote-tracking branch was found).')
  return lines.join('\n')
}

/**
 * Render the outcome of a merge.
 * @param {object} result - the `merge` result.
 * @returns the model-facing report; never empty.
 */
export function renderMergeResult(result) {
  const outcome = result.alreadyMerged === true
    ? 'Already up to date: nothing to merge.'
    : result.fastForward === true
      ? 'Merged with a fast-forward: no merge commit was created.'
      : 'Merge commit created.'
  const lines = [outcome]
  if (result.oid !== undefined) lines.push(`Resulting commit: ${result.oid}`)
  if (result.tree !== undefined) lines.push(`Resulting tree:   ${result.tree}`)
  return lines.join('\n')
}

/**
 * Render a `PushResult`, keeping the server's own words.
 *
 * The remote's `error` string is printed verbatim and is never replaced by a local
 * interpretation: a rejected push (non-fast-forward, protected branch, refused tag) must reach
 * the user as the server phrased it, and `ok: false` must never be rendered as a success.
 * @param {object | undefined} result - the `push` result.
 * @returns the model-facing report; never empty.
 */
export function renderPushResult(result) {
  if (result === undefined || result === null) {
    return 'The server returned no push result. Treat the push as unconfirmed and check the remote.'
  }
  const refs = Object.entries(result.refs ?? {})
  const failed = refs.filter(([, status]) => status?.ok !== true)
  const refusal = result.error === undefined || result.error === null ? '' : ` — ${result.error}`
  const lines = [result.ok === true && failed.length === 0
    ? `Push accepted by the server (${refs.length} ${refs.length === 1 ? 'ref' : 'refs'}):`
    : `Push was refused by the server${refusal}:`]
  if (failed.length === 0) {
    for (const [ref] of refs) lines.push(`  ${ref}: ok`)
  } else {
    for (const [ref, status] of refs) {
      lines.push(status?.ok === true
        ? `  ${ref}: ok`
        : `  ${ref}: NOT updated — ${status?.error ?? 'the server gave no reason'}`)
    }
  }
  if (Array.isArray(result.headers?.prune)) lines.push(`Pruned: ${result.headers.prune}`)
  return lines.join('\n')
}

/**
 * Render one git config value.
 * @param {string} path - the config key that was read.
 * @param {unknown} value - the value `getConfig` returned.
 * @returns the model-facing report; never empty.
 */
export function renderConfigValue(path, value) {
  if (value === undefined || value === null) return `${path} is not set in this repository's config.`
  return `${path} = ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`
}

/**
 * Render every value stored for one (possibly multi-valued) config key.
 * @param {string} path - the config key that was read.
 * @param {unknown[]} values - the `getConfigAll` result.
 * @returns the model-facing report; never empty.
 */
export function renderConfigValues(path, values) {
  if (values.length === 0) return `${path} is not set in this repository's config.`
  return `${path} (${values.length} value${values.length === 1 ? '' : 's'}):\n`
    + values.map(value => `  ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`).join('\n')
}

/**
 * Render a plain list of paths, or the explicit statement that there are none.
 * @param {string[]} paths - the paths.
 * @param {string} emptyText - the wording used when the list is empty.
 * @returns the model-facing report; never empty.
 */
export function renderPathList(paths, emptyText) {
  if (paths.length === 0) return emptyText
  return `${paths.length} ${paths.length === 1 ? 'path' : 'paths'}:\n`
    + paths.map(path => `  ${path}`).join('\n')
}
