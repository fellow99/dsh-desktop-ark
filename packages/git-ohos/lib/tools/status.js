/**
 * The model-facing `git_status` tool: what changed, grouped the way `git status` groups it.
 *
 * The `conflicted` group deserves a word. isomorphic-git keeps unmerged index entries inside
 * the index object and exposes no API for them, so the only observable evidence of an
 * unresolved merge in the working tree is the conflict-marker block git itself leaves in the
 * file. This tool therefore reports a changed path as conflicted when its working-tree copy
 * still holds a complete `<<<<<<<` / `=======` / `>>>>>>>` marker set — the same thing a user
 * would see. The scan is size-capped and never fails the call.
 *
 * @module @dsh-ohos/git/tools/status
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { resolveWithin } from '../fs-adapter.js'
import { classifyStatusRow, renderStatus } from '../report.js'

/**
 * Whether a working-tree file still holds a complete git conflict marker set.
 * @param {string} text - the file's decoded content.
 * @returns true when the file looks like an unresolved merge result.
 */
function hasConflictMarkers(text) {
  let seenOurs = false
  let seenSplit = false
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<< ')) seenOurs = true
    else if (line.startsWith('=======')) seenSplit = true
    else if (line.startsWith('>>>>>>> ') && seenOurs && seenSplit) return true
  }
  return false
}

/**
 * Scan the changed working-tree files for the conflict markers an unresolved merge leaves.
 * Best-effort on purpose: the status matrix is the authoritative answer, and a file that
 * cannot be inspected (over the size cap, unreadable) is simply not claimed to be conflicted.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} root - the repository root.
 * @param {Array<[string, number, number, number]>} rows - the status matrix.
 * @param {number} maxBytes - the per-file scan cap.
 * @returns the paths whose working-tree copy holds conflict markers.
 */
async function scanForConflicts(fs, root, rows, maxBytes) {
  const found = []
  for (const [path, , workdir] of rows) {
    if (workdir !== 2) continue
    const absolute = resolveWithin(root, path)
    try {
      const stat = await fs.promises.stat(absolute)
      if (stat.size > maxBytes) continue
      if (hasConflictMarkers(await fs.promises.readFile(absolute, 'utf8'))) found.push(path)
    } catch {
      // A file that vanished mid-scan is reported by the matrix, not here.
    }
  }
  return found
}

/**
 * Register the `git_status` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitStatusTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_status',
    description: 'Show the state of the repository at `dir`: a header with the checked-out branch and HEAD, then '
      + 'the paths that are staged for commit, modified but not staged, deleted, untracked, and conflicted. '
      + '`paths` narrows the report to a path or directory prefix. A clean repository is reported as such. '
      + 'Conflict detection reads working-tree files for merge conflict markers (isomorphic-git exposes no '
      + 'unmerged-index API), so it covers everything `git merge` leaves behind. Fails when `dir` is not a git '
      + 'repository, naming `git_init` / `git_clone` as the fix; a `dir` outside the session workspace is refused '
      + 'with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Pathspecs (files or directory prefixes, repository-relative) to limit the report to. '
          + 'Omit to report the whole repository.',
      },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          head: { type: 'string', required: true },
          clean: { type: 'boolean', required: true },
          count: { type: 'number', required: true },
          conflicts: { type: 'array', required: true, items: { type: 'string' } },
          rows: { type: 'json', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: `${Array.isArray(args.paths) && args.paths.length > 0
          ? `Scope: ${args.paths.join(', ')}\n`
          : ''}${renderStatus(value.rows, {
          root: value.root,
          branch: value.branch === '' ? undefined : value.branch,
          head: value.head === '' ? undefined : value.head,
          conflicts: value.conflicts,
        })}`,
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_status', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const filepaths = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : ['.']
        const rows = await git.statusMatrix({
          fs: opened.fs,
          dir: opened.root,
          filepaths,
          signal: exec.signal,
        })
        let branch
        try {
          branch = await git.currentBranch({ fs: opened.fs, dir: opened.root, fullname: false })
        } catch {
          // A detached HEAD is reported as such rather than failing the whole status.
          branch = undefined
        }
        let head = ''
        try {
          head = await git.resolveRef({ fs: opened.fs, dir: opened.root, ref: 'HEAD' })
        } catch {
          // An unborn branch (a fresh repository) has no commit yet.
          head = ''
        }
        const conflicts = await scanForConflicts(opened.fs, opened.root, rows, deps.config.maxDiffBlobBytes)
        // The matrix carries a row per walked path, clean ones included, so count the rows that
        // actually differ rather than the rows themselves.
        const changeCount = rows.map(classifyStatusRow).filter(entry => entry.changed).length
        return {
          root: opened.root,
          branch: branch ?? '',
          head,
          clean: changeCount === 0,
          count: changeCount,
          conflicts,
          rows,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_status', args, exec))
      }
    },
  }))
}
