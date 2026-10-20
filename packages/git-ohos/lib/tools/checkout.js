/**
 * The model-facing `git_checkout` tool: switch branches, check out a ref, restore paths.
 *
 * Two shapes in one tool, because they are one git verb: with `paths` the command restores
 * those paths from `ref` and leaves HEAD where it is (git's `restore` semantics), without
 * `paths` it switches the working tree to `ref`. `force: false` is the default on purpose —
 * a checkout that would overwrite local changes must fail and say so, not discard them.
 *
 * @module @dsh-ohos/git/tools/checkout
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { shortOid } from '../report.js'
import { resolveRevision } from './commit.js'

/**
 * Register the `git_checkout` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 */
export function applyGitCheckoutTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_checkout',
    description: 'Switch the working tree to `ref` (a branch name, a tag, or a full or abbreviated '
      + 'commit id; ancestry syntax such as HEAD~1 is not implemented by the git library in this '
      + 'deployment). Or, when `paths` is '
      + 'given — restore just those paths from `ref` and leave HEAD untouched. A branch name switches to that '
      + 'branch; a commit id leaves HEAD detached at it. Local modifications that the checked-out content would '
      + 'overwrite make the call fail with the conflicting path named, unless `force: true` (which discards them, '
      + 'so use it deliberately). `track: false` stops the checkout from configuring branch tracking. Fails when '
      + '`ref` cannot be resolved or `dir` is not a repository; a `dir` outside the session workspace is refused '
      + 'with an escalation hint.',
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
        description: 'What to check out: "HEAD", a branch name, a tag, or a full or abbreviated commit id. '
          + 'Ancestry syntax such as "HEAD~1" is not implemented by the git library in this deployment; read the id '
          + 'you need from git_log.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restore only these paths from `ref` and keep HEAD where it is. Omit to switch the branch.',
      },
      force: {
        type: 'boolean',
        description: 'Overwrite local modifications instead of failing. Defaults to false.',
      },
      track: {
        type: 'boolean',
        description: 'When switching to a remote branch, configure it as the tracking branch. Defaults to true.',
      },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          ref: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          head: { type: 'string', required: true },
          restored: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.restored.length > 0
          ? `Restored ${value.restored.length} path(s) from ${value.ref}: ${value.restored.join(', ')}.\n`
            + `HEAD is unchanged at ${value.head}${value.branch === '' ? ' (detached)' : ` on branch "${value.branch}"`}.`
          : `Checked out ${value.ref} at ${value.head}. HEAD is now `
            + `${value.branch === '' ? 'detached' : `on branch "${value.branch}"`}.`,
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_checkout', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        const paths = Array.isArray(args.paths) ? args.paths : []
        // A branch name must stay a branch name (checking out an object id would detach HEAD), so
        // only an abbreviated id is rewritten — into the full id `checkout` understands.
        const { ref } = await resolveRevision(git, fs, dir, args.ref)
        await git.checkout({
          fs,
          dir,
          ref,
          ...paths.length === 0 ? {} : { filepaths: paths },
          // A path restore must never move HEAD; switching a branch must update it.
          noUpdateHead: paths.length > 0,
          force: args.force === true,
          track: args.track !== false,
          signal: exec.signal,
        })
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
          ref: args.ref,
          branch,
          head: head === '' ? '(unborn)' : shortOid(head, 40),
          restored: paths,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_checkout', args, exec))
      }
    },
  }))
}
