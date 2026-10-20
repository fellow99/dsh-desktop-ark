/**
 * The model-facing `git_cherry_pick` tool: replay one commit onto the current branch.
 *
 * isomorphic-git's `cherryPick` keeps the picked commit's author and uses the caller's
 * committer (see its `commands/cherryPick.js`), so only the committer identity is supplied
 * here. As with `git_merge`, `abortOnConflict` stays on: a conflict throws, names the
 * conflicting paths, and leaves the working tree alone.
 *
 * @module @dsh-ohos/git/tools/cherry-pick
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderConflicts, shortOid } from '../report.js'
import { resolveIdentity, resolveRevision } from './commit.js'

/**
 * Register the `git_cherry_pick` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitCherryPickTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_cherry_pick',
    description: 'Apply the changes of one commit (`oid`: a full or abbreviated commit id, a branch or a tag) onto '
      + 'the checked-out branch as a new commit. The new commit keeps the picked commit\'s author and message and '
      + 'records you as the committer. `dryRun: true` reports whether the pick would succeed without writing '
      + 'anything. A conflict makes the call fail and lists the conflicting paths without touching the working tree '
      + '(abortOnConflict stays on). The reverse operation is git_revert, which is implemented separately because '
      + 'the underlying git library has no reversal primitive. Fails when `oid` cannot be resolved, when the commit '
      + 'is a merge commit or a root commit (the underlying implementation refuses both), or when `dir` is not a '
      + 'repository; a `dir` outside the session workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      oid: {
        type: 'string',
        required: true,
        description: 'The commit to pick: a full or abbreviated commit id, a tag, or a branch name.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Simulate the pick and report whether it would succeed, without writing. Defaults to false.',
      },
      committerName: { type: 'string', description: 'Committer name for the new commit, overriding the config.' },
      committerEmail: { type: 'string', description: 'Committer email for the new commit, overriding the config.' },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          oid: { type: 'string', required: true },
          committed: { type: 'string', required: true },
          dryRun: { type: 'boolean', required: true },
          committer: { type: 'string', required: true },
          identitySource: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.dryRun
          ? `Dry run: picking ${value.oid} onto the current branch would succeed. Nothing was written.`
          : `Picked ${value.oid} as new commit ${value.committed} `
            + `(committer ${value.committer}, from ${value.identitySource}).`,
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_cherry_pick', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        const identity = await resolveIdentity(git, fs, dir, deps.config, {
          ...args.committerName === undefined ? {} : { authorName: args.committerName },
          ...args.committerEmail === undefined ? {} : { authorEmail: args.committerEmail },
        })
        // The pick's author is the original commit's author; only the committer is ours.
        const committer = { name: identity.name, email: identity.email }
        const { oid } = await resolveRevision(git, fs, dir, args.oid)
        const committed = await git.cherryPick({
          fs,
          dir,
          oid,
          dryRun: args.dryRun === true,
          abortOnConflict: true,
          committer,
          signal: exec.signal,
        })
        return {
          root: dir,
          oid: args.oid,
          committed: shortOid(committed, 40) ?? '',
          dryRun: args.dryRun === true,
          committer: `${identity.name} <${identity.email}>`,
          identitySource: identity.source,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        const filepaths = error instanceof Error && Array.isArray(error.data?.filepaths)
          ? error.data.filepaths
          : undefined
        if (error instanceof Error && error.code === 'MergeConflictError' && filepaths !== undefined) {
          throw new Error(renderConflicts(filepaths, {
            reason: `Cherry-pick refused: ${filepaths.length} conflicting path(s). Nothing was written to the `
              + 'working tree or the index.',
            next: 'Pick a different commit, or apply the change by hand (git_show for the content, then edit, '
              + 'git_add, git_commit).',
          }))
        }
        throw deps.fence.mapError(
          error,
          policy ?? await deps.fence.resolvePolicy('git_cherry_pick', args, exec),
        )
      }
    },
  }))
}
