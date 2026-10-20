/**
 * The model-facing `git_fetch` tool: bring remote objects and refs into the repository without
 * touching the working tree or the checked-out branch.
 * @module @dsh-ohos/git/tools/fetch
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderFetchResult } from '../report.js'
import { guardedHttp, mapNetworkError } from './clone.js'
import { scrubUrl } from '../url.js'

/**
 * Register the `git_fetch` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {import('../auth.js').GitCredentials} deps.credentials - the credential lookup.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitFetchTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_fetch',
    description: 'Fetch objects and refs from a remote into this repository without merging anything and without '
      + 'touching the working tree. `remote` defaults to "origin"; `url` overrides the configured address. '
      + '`singleBranch: true` fetches only `remoteRef` (or the branch HEAD tracks), `depth` limits how much history '
      + 'is fetched, `tags: true` also fetches tags, and `prune: true` deletes remote-tracking branches that no '
      + 'longer exist on the remote. When the remote has nothing new the report says so. Credentials come from the '
      + 'credential store by host: a missing or refused credential is reported with the exact credential name '
      + 'instead of a bare 401, and a fetch that outlives the network timeout is aborted with the elapsed time. A '
      + '`dir` outside the session workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      remote: { type: 'string', description: 'Remote to fetch from. Defaults to "origin".' },
      url: {
        type: 'string',
        description: 'Remote URL, overriding the configured one, for example '
          + '"https://git.example.com/team/project.git".',
      },
      remoteRef: { type: 'string', description: 'The branch on the remote to fetch when singleBranch is true.' },
      singleBranch: { type: 'boolean', description: 'Fetch only one branch instead of all of them.' },
      depth: { type: 'number', description: 'Limit how much history is fetched, for example 1 for a shallow fetch.' },
      tags: { type: 'boolean', description: 'Also fetch tags. Defaults to false.' },
      prune: {
        type: 'boolean',
        description: 'Delete local remote-tracking branches that no longer exist on the remote. Defaults to false.',
      },
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
          result: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderFetchResult(value.result, {
          ...value.remote === '' ? {} : { remote: value.remote },
          ...value.url === '' ? {} : { url: value.url },
        }),
      }],
    },
    async execute(args, exec) {
      let policy
      let guard
      const started = Date.now()
      const remote = args.remote ?? 'origin'
      // Declared before the `try` so the catch can name the address the fetch failed against: the
      // credential key (`GIT_CREDENTIAL_<HOST>`) is derived from the URL, so a failure path that
      // only had the remote *name* ("origin") would report "no credentials are configured" without
      // ever naming the key the user has to create (FR-5.3).
      let url = args.url ?? ''
      try {
        const opened = await deps.fence.open('git_fetch', args, exec, args.dir)
        policy = opened.policy
        const { git, http } = await loadGit()
        url = args.url ?? await remoteUrl(git, opened.fs, opened.root, remote, exec.signal)
        guard = guardedHttp(http, exec.signal, deps.config.networkTimeoutMs)
        const result = await git.fetch({
          fs: opened.fs,
          http: guard.http,
          dir: opened.root,
          remote,
          ...args.url === undefined ? {} : { url: args.url },
          ...args.remoteRef === undefined ? {} : { remoteRef: args.remoteRef },
          singleBranch: args.singleBranch === true,
          ...args.depth === undefined ? {} : { depth: args.depth },
          tags: args.tags === true,
          prune: args.prune === true,
          signal: guard.signal,
          ...deps.credentials.callbacks(url),
        })
        return { root: opened.root, remote, url: scrubUrl(url), result }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw await mapNetworkError(error, {
          tool: 'git_fetch',
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
 * The configured URL of one remote, for the credential lookup and the report.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @param {string} remote - the remote name.
 * @param {AbortSignal} signal - the call's abort signal, so a cancel interrupts the lookup too.
 * @returns the configured URL, or `''` when the remote is unknown.
 */
async function remoteUrl(git, fs, dir, remote, signal) {
  const remotes = await git.listRemotes({ fs, dir, signal })
  return remotes.find(entry => entry.remote === remote)?.url ?? ''
}
