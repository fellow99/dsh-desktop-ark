/**
 * The model-facing `git_stash` tool.
 *
 * One quirk is handled here rather than exposed: isomorphic-git's stash commit reads
 * `user.name`/`user.email` from the repository config and accepts no author argument, so a
 * repository that has never been configured cannot stash at all. For `push` and `create` this
 * tool fills the missing keys in from the plugin config for the duration of the call and
 * restores the previous config afterwards — including deleting a key it had to create. The
 * plugin's placeholder identity therefore never becomes a surprise resident of `.git/config`.
 *
 * @module @dsh-ohos/git/tools/stash
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderStashEntries } from '../report.js'

/** The stash operations isomorphic-git implements. */
const OPS = ['push', 'pop', 'apply', 'drop', 'list', 'clear']

/** Operations that create a stash commit, and therefore need an identity. */
const NEEDS_IDENTITY = new Set(['push', 'create'])

/**
 * Run one stash operation with the repository's identity temporarily completed.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @param {object} config - the resolved plugin config.
 * @param {() => Promise<unknown>} run - the stash operation to run.
 * @returns whatever `run` returned.
 */
async function withStashIdentity(git, fs, dir, config, run) {
  const name = await git.getConfig({ fs, dir, path: 'user.name' })
  const email = await git.getConfig({ fs, dir, path: 'user.email' })
  const restore = []
  if (typeof name !== 'string' || name === '') {
    await git.setConfig({ fs, dir, path: 'user.name', value: config.authorName })
    restore.push(['user.name', typeof name === 'string' ? name : undefined])
  }
  // An empty `user.email` is as unusable as a missing one: it is exactly the predicate `commit`
  // and `tag` use when they read the repository identity, so a stash commit is never built with a
  // blank email while the other two substitute the configured default.
  if (typeof email !== 'string' || email === '') {
    await git.setConfig({ fs, dir, path: 'user.email', value: config.authorEmail })
    restore.push(['user.email', typeof email === 'string' ? email : undefined])
  }
  try {
    return await run()
  } finally {
    // `value: undefined` deletes the config entry, so a key this call created disappears again.
    for (const [path, original] of restore) {
      await git.setConfig({ fs, dir, path, value: original })
    }
  }
}

/**
 * Register the `git_stash` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitStashTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_stash',
    description: 'Store work away and get it back later. `op: "push"` (the default) stashes the modified tracked '
      + 'files together with the index and cleans the working tree; `op: "list"` prints the stash entries newest '
      + 'first; `op: "pop"` re-applies an entry and drops it; `op: "apply"` re-applies it and keeps it; `op: '
      + '"drop"` discards an entry; `op: "clear"` discards them all. `index` (default 0) selects the entry for '
      + 'apply/pop/drop, and `message` labels a push. Only tracked files are stashed, and untracked files stay in '
      + 'the working tree. Applying a stash overwrites the working tree without conflict detection, so commit or '
      + 'stash local work first. The identity of a stash commit comes from this repository\'s user.name/user.email, '
      + 'falling back to the plugin defaults (the repository config is left exactly as it was). Fails when `op` is '
      + 'unknown, the selected entry does not exist, or `dir` is not a repository; a `dir` outside the session '
      + 'workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      op: { type: 'string', enum: OPS, description: 'The stash operation. Defaults to "push".' },
      message: { type: 'string', description: 'For op "push": a label for the new stash entry.' },
      index: {
        type: 'number',
        description: 'For op "apply"/"pop"/"drop": which entry to use, 0 being the newest. Defaults to 0.',
      },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          op: { type: 'string', required: true },
          message: { type: 'string', required: true },
          entries: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.message}\n\n${renderStashEntries(value.entries)}`,
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_stash', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        const op = args.op ?? 'push'
        if (!OPS.includes(op)) {
          throw new Error(`git_stash: unknown op "${op}" (expected one of ${OPS.join(', ')})`)
        }
        const stash = () => git.stash({
          fs,
          dir,
          op,
          ...args.message === undefined ? {} : { message: args.message },
          refIdx: args.index ?? 0,
          signal: exec.signal,
        })
        if (NEEDS_IDENTITY.has(op)) await withStashIdentity(git, fs, dir, deps.config, stash)
        else await stash()
        const entries = await git.stash({ fs, dir, op: 'list', signal: exec.signal })
        const message = op === 'list'
          ? 'Stash entries:'
          : op === 'push'
            ? 'Stashed the modified tracked files and cleaned the working tree.'
            : op === 'clear'
              ? 'Dropped every stash entry.'
              : `Applied stash operation "${op}" (entry ${args.index ?? 0}).`
        return { root: dir, op, message, entries }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_stash', args, exec))
      }
    },
  }))
}
