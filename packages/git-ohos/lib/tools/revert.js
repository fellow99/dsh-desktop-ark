/**
 * The model-facing `git_revert` tool — built here because isomorphic-git has no reversal
 * primitive at all (`../dsh-desktop-hos/docs/204-插件-GIT.md` F5, §11.3; `cherryPick` has no `reversal` option in
 * 1.44.2 and none should be looked for).
 *
 * The algorithm, in the order the design fixes it:
 *
 * 1. Read the target commit and require **exactly one** parent. A merge commit (two parents) or
 *    a root commit (none) is refused by name — inverting those is not a revert.
 * 2. Enumerate the changed paths by walking the parent tree against the target tree.
 * 3. **Fail closed.** Before writing anything, compare every changed path's working-tree blob
 *    object id with the target commit's blob id for that path. Any difference means the working
 *    tree has diverged from what the commit produced, so the whole revert is refused and every
 *    divergent path is listed. Local work is never overwritten.
 * 4. Only then materialise the parent's content (deleting the path when the parent lacks it),
 *    stage the result and commit `Revert "<original subject>"`.
 *
 * @module @dsh-ohos/git/tools/revert
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { resolveWithin } from '../fs-adapter.js'
import { renderConflicts, renderPathList, shortOid } from '../report.js'
import { resolveIdentity, resolveRevision } from './commit.js'

/**
 * Whether one walk side is absent: `git.walk` reports a missing path as `null` for a tree that
 * lacks it and as `undefined` in other cases.
 * @param {object | null | undefined} entry - the walker entry for one side.
 * @returns true when this side has no such path.
 */
function isAbsent(entry) {
  return entry === undefined || entry === null
}

/**
 * Enumerate the leaf paths that differ between two commits.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @param {string} parentOid - the parent commit.
 * @param {string} targetOid - the commit being reverted.
 * @returns one entry per changed path, with each side's blob object id (null when absent).
 */
async function changesBetween(git, fs, dir, parentOid, targetOid) {
  const entries = await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref: parentOid }), git.TREE({ ref: targetOid })],
    map: async (filepath, [before, after]) => {
      if (filepath === '.git' || filepath.startsWith('.git/')) return null
      if (filepath === '.') return undefined
      const beforeType = isAbsent(before) ? undefined : await before.type()
      const afterType = isAbsent(after) ? undefined : await after.type()
      if (beforeType === 'tree' || afterType === 'tree') {
        // A directory that is missing on one side is carried by its children, which are walked
        // individually; a directory replaced by a file (or the reverse) cannot be inverted by a
        // path-level revert, so it is refused by name instead of half-applied.
        if (isAbsent(before) || isAbsent(after)) return undefined
        if (beforeType === afterType) return undefined
        return {
          path: filepath,
          parentOid: null,
          targetOid: null,
          unsupported: `a ${beforeType} replaced by a ${afterType}`,
        }
      }
      const parentBlob = isAbsent(before) ? null : await before.oid()
      const targetBlob = isAbsent(after) ? null : await after.oid()
      if (parentBlob === targetBlob) return undefined
      return { path: filepath, parentOid: parentBlob, targetOid: targetBlob }
    },
  })
  return (entries ?? []).filter(entry => entry !== undefined && entry !== null)
}

/**
 * The blob object id of one path in the working tree, or `null` when it is not there.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} root - the repository root.
 * @param {string} path - the repository-relative path.
 * @returns the blob id of the file's current content, or null.
 */
async function workdirBlobOid(git, fs, root, path) {
  let bytes
  try {
    bytes = await fs.promises.readFile(resolveWithin(root, path))
  } catch {
    return null
  }
  return (await git.hashBlob({ object: bytes })).oid
}

/**
 * Whether the **index** for one path differs from HEAD (i.e. something is staged there).
 *
 * The workdir check alone is not enough: a path can be staged (index holds X) and then edited in
 * the working tree back to the very content the commit produced. The revert would write the
 * parent blob and `git add` it, silently dropping the staged X — so a staged path is refused too
 * (FR-204-016: never discard local work).
 *
 * `statusMatrix` is the only index-readable public surface: its fourth column is
 * `1` = identical to HEAD, `2` = identical to the working tree, `3` = different from both,
 * `0` = absent. Anything but `1`/`0` means the index carries something HEAD does not.
 *
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @param {string} path - repository-relative path.
 * @param {AbortSignal} [signal] - the call's cancellation signal.
 * @returns true when the path has staged content.
 */
async function hasStagedContent(git, fs, dir, path, signal) {
  try {
    const rows = await git.statusMatrix({ fs, dir, filepaths: [path], signal })
    const row = rows.find(entry => entry[0] === path)
    if (row === undefined) return false
    return row[3] === 2 || row[3] === 3
  } catch {
    // A path the matrix cannot classify is treated as staged: refusing is the safe direction.
    return true
  }
}

/**
 * Register the `git_revert` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitRevertTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_revert',
    description: 'Create a new commit that undoes `ref` (a commit id — full or abbreviated — a tag, or a branch '
      + 'name; ancestry syntax such as "HEAD~1" is not implemented by the git library, so read the id from git_log '
      + 'instead). This tool implements the '
      + 'reversal itself, because the underlying git library has no reverse-apply primitive, and it does so '
      + 'fail-closed: the commit must have exactly one parent (a merge commit or a root commit is refused by name), '
      + 'and every path the commit touched must still hold exactly the content that commit produced in the working '
      + 'tree. If any of them has been modified since, the call is refused and lists every divergent path — local '
      + 'work is never overwritten. When it does proceed it writes the parent\'s content into the working tree, '
      + 'stages those paths (a path the parent did not have is deleted and its removal recorded in the index), and '
      + 'commits with the message `Revert "<original subject>"`. The identity comes from `authorName`/'
      + '`authorEmail`, else this repository\'s user.name/user.email, else the plugin defaults. Fails when `ref` '
      + 'cannot be resolved or `dir` is not a repository; a `dir` outside the session workspace is refused with an '
      + 'escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      ref: {
        type: 'string',
        required: true,
        description: 'The commit to undo: "HEAD", a branch, a tag, or a full or abbreviated commit id.',
      },
      authorName: { type: 'string', description: 'Author/committer name for the revert commit.' },
      authorEmail: { type: 'string', description: 'Author/committer email for the revert commit.' },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          ref: { type: 'string', required: true },
          target: { type: 'string', required: true },
          parent: { type: 'string', required: true },
          message: { type: 'string', required: true },
          oid: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
          author: { type: 'string', required: true },
          identitySource: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Reverted ${shortOid(value.target, 12)} (${value.message}) as new commit ${value.oid}.\n`
          + `Author: ${value.author} (from ${value.identitySource}).\n\n`
          + renderPathList(value.paths, 'No path differed between the commit and its parent, so nothing changed.'),
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_revert', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        const { oid: target } = await resolveRevision(git, fs, dir, args.ref)
        const read = await git.readCommit({ fs, dir, oid: target, signal: exec.signal })
        const parents = Array.isArray(read.commit.parent) ? read.commit.parent : []
        if (parents.length !== 1) {
          throw new Error(`git_revert: ${args.ref} (${target}) has ${parents.length} parent commit(s); this tool `
            + 'reverts a commit with exactly one parent. A merge commit cannot be inverted this way, and a root '
            + 'commit has nothing to restore from — revert its effect with git_checkout plus git_commit instead.')
        }
        const parent = parents[0]
        const changes = await changesBetween(git, fs, dir, parent, target)
        const unsupported = changes.filter(change => change.unsupported !== undefined)
        if (unsupported.length > 0) {
          throw new Error(renderConflicts(unsupported.map(change => `${change.path} (${change.unsupported})`), {
            reason: 'git_revert refused: a path changed between a directory and a file, which this path-level '
              + 'revert cannot invert safely:',
            next: 'Undo those paths by hand with git_checkout, git_add and git_commit.',
          }))
        }

        // Fail closed: nothing is written until every touched path still holds what the commit
        // produced — in the working tree **and** in the index. A divergence anywhere refuses the
        // whole revert and names the paths.
        const divergent = []
        for (const change of changes) {
          const currentWorkdir = await workdirBlobOid(git, fs, dir, change.path)
          const staged = await hasStagedContent(git, fs, dir, change.path, exec.signal)
          if (currentWorkdir !== change.targetOid || staged) divergent.push(change.path)
        }
        if (divergent.length > 0) {
          throw new Error(renderConflicts(divergent, {
            reason: `git_revert refused: ${divergent.length} path(s) touched by ${args.ref} no longer hold the `
              + 'content that commit produced (or hold staged changes), so reverting would overwrite local '
              + 'work. Not one byte was written:',
            next: 'Commit or discard those changes first, then retry the same git_revert.',
          }))
        }

        const deleted = []
        const written = []
        for (const change of changes) {
          const absolute = resolveWithin(dir, change.path)
          if (change.parentOid === null) {
            await fs.promises.unlink(absolute)
            deleted.push(change.path)
            continue
          }
          const blob = await git.readBlob({ fs, dir, oid: change.parentOid, signal: exec.signal })
          const slash = change.path.lastIndexOf('/')
          if (slash > 0) await fs.promises.mkdir(resolveWithin(dir, change.path.slice(0, slash)), { recursive: true })
          await fs.promises.writeFile(absolute, blob.blob)
          written.push(change.path)
        }
        // A restored file is staged with `add`; a path the parent did not have must be staged as
        // a removal (`add` cannot record a deletion — it only reads what exists).
        if (written.length > 0) {
          await git.add({ fs, dir, filepath: written, signal: exec.signal })
        }
        if (deleted.length > 0) {
          await git.remove({ fs, dir, filepath: deleted, signal: exec.signal })
        }
        const identity = await resolveIdentity(git, fs, dir, deps.config, args)
        const actor = { name: identity.name, email: identity.email }
        const subject = String(read.commit.message ?? '').split('\n')[0]
        const message = `Revert "${subject}"`
        const oid = await git.commit({
          fs,
          dir,
          message,
          author: actor,
          committer: actor,
          signal: exec.signal,
        })
        return {
          root: dir,
          ref: args.ref,
          target,
          parent,
          message,
          oid,
          paths: changes.map(change => change.path),
          author: `${identity.name} <${identity.email}>`,
          identitySource: identity.source,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_revert', args, exec))
      }
    },
  }))
}
