/**
 * The model-facing `git_branch` tool: list, create, delete and rename branches.
 * @module @dsh-ohos/git/tools/branch
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderBranches } from '../report.js'
import { resolveRevision } from './commit.js'

/** The branch actions this tool exposes. */
const ACTIONS = ['list', 'create', 'delete', 'rename']

/** Actions that address a branch by name. */
const NEEDS_NAME = new Set(['create', 'delete', 'rename'])

/**
 * Register the `git_branch` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 */
export function applyGitBranchTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_branch',
    description: 'Work with branches. `action: "list"` (the default) prints the local branches with the current '
      + 'one marked, or the remote-tracking branches of `remote` when that is given. `action: "create"` creates '
      + '`name` at `from` (a branch, tag, commit id or "HEAD"; default HEAD); `checkout: true` switches to it '
      + 'right away. `action: "delete"` deletes the branch `name` (never the checked-out one: the underlying git '
      + 'implementation refuses that). `action: "rename"` renames `oldName` to `name`. Fails when `name` is '
      + 'missing for an action that needs it, when the branch does not exist, or when `dir` is not a repository; a '
      + '`dir` outside the session workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'What to do. Defaults to "list".',
      },
      name: { type: 'string', description: 'Branch name: the branch to create, delete or rename to.' },
      oldName: { type: 'string', description: 'For action "rename": the branch to rename.' },
      from: { type: 'string', description: 'For action "create": the start point. Defaults to "HEAD".' },
      checkout: { type: 'boolean', description: 'For action "create": switch to the new branch. Defaults to false.' },
      remote: {
        type: 'string',
        description: 'For action "list": list the remote-tracking branches of this remote instead of the local ones.',
      },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          action: { type: 'string', required: true },
          current: { type: 'string', required: true },
          remote: { type: 'string', required: true },
          branches: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderBranches(value.branches, {
          current: value.current === '' ? undefined : value.current,
          ...value.remote === '' ? {} : { remote: value.remote },
        }),
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_branch', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const action = args.action ?? 'list'
        if (!ACTIONS.includes(action)) {
          throw new Error(`git_branch: unknown action "${action}" (expected one of ${ACTIONS.join(', ')})`)
        }
        if (NEEDS_NAME.has(action) && (args.name === undefined || args.name.trim() === '')) {
          throw new Error(`git_branch: action "${action}" requires name`)
        }
        const fs = opened.fs
        const dir = opened.root
        if (action === 'create') {
          const object = (await resolveRevision(git, fs, dir, args.from ?? 'HEAD')).ref
          await git.branch({
            fs,
            dir,
            ref: args.name,
            object,
            checkout: args.checkout === true,
            signal: exec.signal,
          })
        } else if (action === 'delete') {
          await git.deleteBranch({ fs, dir, ref: args.name, signal: exec.signal })
        } else if (action === 'rename') {
          if (args.oldName === undefined) throw new Error('git_branch: action "rename" requires oldName')
          await git.renameBranch({ fs, dir, oldref: args.oldName, ref: args.name, signal: exec.signal })
        }
        let current = ''
        try {
          current = (await git.currentBranch({ fs, dir, fullname: false })) ?? ''
        } catch {
          // A detached HEAD has no branch name; the renderer says so.
          current = ''
        }
        const remote = action === 'list' && args.remote !== undefined ? args.remote : ''
        const branches = remote === ''
          ? await git.listBranches({ fs, dir, signal: exec.signal })
          : await git.listBranches({ fs, dir, remote, signal: exec.signal })
        return { root: dir, action, current, remote, branches }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_branch', args, exec))
      }
    },
  }))
}
