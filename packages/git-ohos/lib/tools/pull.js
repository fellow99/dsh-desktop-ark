/**
 * The model-facing `git_pull` tool: fetch, then merge into the checked-out branch.
 *
 * `pull` returns nothing, so the report is built from the repository's own state: the HEAD
 * object id before and after the call turn "already up to date" and "updated by a merge or a
 * fast-forward" into observable facts rather than claims.
 *
 * @module @dsh-ohos/git/tools/pull
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { resolveIdentity } from './commit.js'
import { guardedHttp, mapNetworkError } from './clone.js'
import { scrubUrl } from '../url.js'

/**
 * Register the `git_pull` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {import('../auth.js').GitCredentials} deps.credentials - the credential lookup.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitPullTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_pull',
    description: 'Fetch a remote and merge it into the checked-out branch in one step. `remote` defaults to '
      + '"origin"; `ref` names the branch to merge into (default: the checked-out branch) and `remoteRef` the '
      + 'branch to take from the remote (default: its configured upstream). `fastForwardOnly: true` refuses '
      + 'anything that would need a merge commit instead of creating one. The report states whether HEAD moved, '
      + 'and a merge that conflicts fails and lists the conflicting paths without touching the working tree. The '
      + 'identity of a merge commit comes from `authorName`/`authorEmail`, else this repository\'s user.name/'
      + 'user.email, else the plugin defaults. Credentials come from the credential store by host; a missing or '
      + 'refused credential is reported with the exact credential name, and a pull that outlives the network '
      + 'timeout is aborted with the elapsed time. A `dir` outside the session workspace is refused with an '
      + 'escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      remote: { type: 'string', description: 'Remote to pull from. Defaults to "origin".' },
      url: {
        type: 'string',
        description: 'Remote URL, overriding the configured one, for example '
          + '"https://git.example.com/team/project.git".',
      },
      ref: { type: 'string', description: 'The local branch to merge into. Defaults to the checked-out branch.' },
      remoteRef: { type: 'string', description: 'The branch on the remote to take. Defaults to the tracking branch.' },
      fastForwardOnly: {
        type: 'boolean',
        description: 'Refuse a pull that would need a merge commit instead of creating one. Defaults to false.',
      },
      authorName: { type: 'string', description: 'Author/committer name for a merge commit this pull creates.' },
      authorEmail: { type: 'string', description: 'Author/committer email for a merge commit this pull creates.' },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          remote: { type: 'string', required: true },
          url: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
          updated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.updated
          ? `Pulled from ${value.remote}${value.url === '' ? '' : ` (${value.url})`}: `
            + `${value.branch === '' ? 'HEAD' : `branch "${value.branch}"`} moved ${value.before} -> ${value.after}.`
          : `Already up to date: pulling from ${value.remote} left `
            + `${value.branch === '' ? 'HEAD' : `branch "${value.branch}"`} at ${value.after}. Nothing was merged.`,
      }],
    },
    async execute(args, exec) {
      let policy
      let guard
      const started = Date.now()
      const remote = args.remote ?? 'origin'
      // Hoisted: the error path needs the remote list to name the URL that failed.
      let remotes = []
      let url = ''
      try {
        const opened = await deps.fence.open('git_pull', args, exec, args.dir)
        policy = opened.policy
        const { git, http } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        remotes = await git.listRemotes({ fs, dir })
        url = args.url ?? urlFrom(remotes, remote)
        const before = await git.resolveRef({ fs, dir, ref: 'HEAD' })
        const identity = await resolveIdentity(git, fs, dir, deps.config, args)
        const actor = { name: identity.name, email: identity.email }
        guard = guardedHttp(http, exec.signal, deps.config.networkTimeoutMs)
        await git.pull({
          fs,
          http: guard.http,
          dir,
          remote,
          ...args.url === undefined ? {} : { url: args.url },
          ...args.ref === undefined ? {} : { ref: args.ref },
          ...args.remoteRef === undefined ? {} : { remoteRef: args.remoteRef },
          fastForwardOnly: args.fastForwardOnly === true,
          author: actor,
          committer: actor,
          signal: guard.signal,
          ...deps.credentials.callbacks(url),
        })
        const after = await git.resolveRef({ fs, dir, ref: 'HEAD' })
        let branch = ''
        try {
          branch = (await git.currentBranch({ fs, dir, fullname: false })) ?? ''
        } catch {
          branch = ''
        }
        return { root: dir, remote, url: scrubUrl(url), branch, before, after, updated: before !== after }
      } catch (error) {
        if (exec.signal.aborted) throw error
        const filepaths = error instanceof Error && Array.isArray(error.data?.filepaths)
          ? error.data.filepaths
          : undefined
        if (error instanceof Error && error.code === 'MergeConflictError' && filepaths !== undefined) {
          throw new Error(`Pulling from "${remote}" conflicts in ${filepaths.length} path(s) and was not applied: `
            + `${filepaths.join(', ')}. The fetched objects are in the repository; merge deliberately with git_merge, `
            + 'or resolve by hand. Nothing was written to the working tree.')
        }
        throw await mapNetworkError(error, {
          tool: 'git_pull',
          url,
          elapsedMs: Date.now() - started,
          guard,
          deps,
          policy,
          args,
          exec,
        })
      }
    },
  }))
}

/**
 * The configured URL of one remote, for the two error paths that run outside the happy path.
 * @param {Array<{remote: string, url: string}>} remotes - the configured remotes.
 * @param {string} remote - the remote name.
 * @returns the URL, or `''` when unknown.
 */
function urlFrom(remotes, remote) {
  return remotes.find(entry => entry.remote === remote)?.url ?? ''
}
