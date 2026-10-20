/**
 * The model-facing `git_reset` tool: `--soft`, `--mixed` and `--hard`.
 *
 * isomorphic-git has no single `reset`, so each mode is assembled from its primitives, and
 * each mode is described by exactly what it touches:
 *
 * - `soft`  moves the branch pointer (or a detached HEAD) and nothing else.
 * - `mixed` moves it and rewrites the index to the target tree, leaving the working tree.
 * - `hard`  moves it and overwrites the working tree with the target tree.
 *
 * The index rewrite of `mixed` is per path (`resetIndex`), run over the union of the index and
 * the target tree, so a path the target does not have is dropped from the index instead of
 * being left behind.
 *
 * @module @dsh-ohos/git/tools/reset
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderStatus, shortOid } from '../report.js'
import { resolveRevision } from './commit.js'

/** The reset modes this tool exposes. */
export const RESET_MODES = ['soft', 'mixed', 'hard']

/**
 * The fully qualified ref of the checked-out branch, or `undefined` for a detached HEAD.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @returns `refs/heads/<name>`, or `undefined`.
 */
async function headBranchRef(git, fs, dir) {
  try {
    return (await git.currentBranch({ fs, dir, fullname: true })) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Register the `git_reset` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 */
export function applyGitResetTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_reset',
    description: 'Move the current branch to `ref` (default HEAD). `mode: "soft"` moves only the branch pointer, '
      + 'leaving the index and the working tree exactly as they are. `mode: "mixed"` (the default) also rewrites '
      + 'the index to match `ref`, so the changes stay in the working tree but are no longer staged. `mode: "hard"` '
      + 'additionally overwrites the working tree with `ref`, which DISCARDS uncommitted changes — it is the only '
      + 'mode that loses work, and it refuses nothing. With `paths` and `mode: "mixed"` only those paths are '
      + 'unstaged (the branch pointer is left alone, as in git); `paths` with soft or hard is rejected. Fails when '
      + '`ref` cannot be resolved or `dir` is not a repository; a `dir` outside the session workspace is refused '
      + 'with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      mode: {
        type: 'string',
        enum: RESET_MODES,
        description: 'How much to reset: "soft" (pointer only), "mixed" (pointer + index, the default), or "hard" '
          + '(pointer + index + working tree, discarding local changes).',
      },
      ref: {
        type: 'string',
        description: 'Commit, branch or tag to reset to; a full or abbreviated object id also works. Defaults to '
          + '"HEAD".',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'With mode "mixed": unstage only these paths and leave the branch pointer where it is.',
      },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          ref: { type: 'string', required: true },
          target: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          head: { type: 'string', required: true },
          moved: { type: 'boolean', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
          rows: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Reset (${value.mode}) to ${value.ref} = ${value.target}.\n`
          + (value.paths.length > 0
            ? `Unstaged ${value.paths.length} path(s); the branch pointer was not moved.\n`
            : value.moved
              ? `${value.branch === '' ? 'Detached HEAD' : `Branch "${value.branch}"`} now points at ${value.head}.\n`
              : 'No branch pointer needed moving.\n')
          + `\n${renderStatus(value.rows, { root: value.root, branch: value.branch === '' ? undefined : value.branch, head: value.head, conflicts: [] })}`,
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_reset', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        const mode = args.mode ?? 'mixed'
        if (!RESET_MODES.includes(mode)) {
          throw new Error(`git_reset: unknown mode "${mode}" (expected one of ${RESET_MODES.join(', ')})`)
        }
        const ref = args.ref ?? 'HEAD'
        const paths = Array.isArray(args.paths) ? args.paths : []
        const { oid: target } = await resolveRevision(git, fs, dir, ref)
        const branchRef = await headBranchRef(git, fs, dir)
        let moved = false

        // `paths` with mixed is git's "unstage these paths": the pointer must not move.
        if (paths.length > 0) {
          if (mode !== 'mixed') {
            throw new Error(`git_reset: paths are only meaningful with mode "mixed" (never with "${mode}")`)
          }
          for (const path of paths) {
            await git.resetIndex({ fs, dir, filepath: path, ref, signal: exec.signal })
          }
        } else {
          const head = await git.resolveRef({ fs, dir, ref: 'HEAD' })
          const movesPointer = head !== target
          if (mode === 'soft' || mode === 'mixed') {
            if (movesPointer) {
              await git.writeRef({
                fs,
                dir,
                ref: branchRef ?? 'HEAD',
                value: target,
                force: true,
                signal: exec.signal,
              })
              moved = true
            }
          }
          if (mode === 'mixed') {
            // Rewrite the index over the union of the index's paths and the target tree's paths,
            // so paths absent from the target are dropped from the index rather than lingering.
            const indexed = await git.listFiles({ fs, dir, signal: exec.signal })
            const wanted = await git.listFiles({ fs, dir, ref: target, signal: exec.signal })
            for (const path of new Set([...indexed, ...wanted])) {
              await git.resetIndex({ fs, dir, filepath: path, ref: target, signal: exec.signal })
            }
          }
          if (mode === 'hard') {
            // `--hard` is the one mode that must **not** move the pointer first: a checkout that
            // failed after `writeRef` would leave the branch pointing at the target while the
            // working tree still held the old content — a repository matching no commit. So the
            // working tree and index are rewritten first, by checking the target commit out (which
            // detaches HEAD onto it, the same intermediate state native git passes through), then
            // the branch is moved, then HEAD is re-attached to that branch. Every failure before
            // the final step leaves the old branch pointer over the old working tree.
            await git.checkout({ fs, dir, ref: target, force: true, signal: exec.signal })
            if (movesPointer) {
              await git.writeRef({
                fs,
                dir,
                ref: branchRef ?? 'HEAD',
                value: target,
                force: true,
                signal: exec.signal,
              })
              moved = true
            }
            if (branchRef !== undefined) {
              await git.checkout({ fs, dir, ref: branchRef, force: true, signal: exec.signal })
            }
          }
        }

        const rows = await git.statusMatrix({ fs, dir, signal: exec.signal })
        let branch = ''
        try {
          branch = (await git.currentBranch({ fs, dir, fullname: false })) ?? ''
        } catch {
          branch = ''
        }
        let head = ''
        try {
          head = await git.resolveRef({ fs, dir, ref: 'HEAD' })
        } catch {
          head = ''
        }
        return {
          root: dir,
          mode,
          ref,
          target,
          branch,
          head: head === '' ? '(unborn)' : shortOid(head, 40),
          moved,
          paths,
          rows,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_reset', args, exec))
      }
    },
  }))
}
