/**
 * The model-facing `git_remote` tool: the configured remotes, and a read-only probe of a
 * server's refs and capabilities.
 *
 * The probe actions (`refs`, `info`) contact the server and write nothing anywhere — no
 * repository needed, which is what makes them the right first call against a new remote
 * (`../dsh-desktop-hos/docs/204-插件-GIT.md` §17.1 AN-1 / §17.2 AR-1). Credentials come from the credential store
 * by host, exactly as for clone/fetch/pull/push.
 *
 * @module @dsh-ohos/git/tools/remote
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderRemoteInfo, renderRemotes, renderServerRefs } from '../report.js'
import { guardedHttp, mapNetworkError } from './clone.js'
import { scrubUrl } from '../url.js'

/** The remote actions this tool exposes. */
const ACTIONS = ['list', 'add', 'delete', 'refs', 'info']

/** Actions that read or write the local repository configuration. */
const LOCAL = new Set(['list', 'add', 'delete'])

/**
 * Resolve the URL one action should contact: the explicit `url`, else the configured URL of
 * `name`, so a probe can name a remote instead of pasting its address.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @param {object} args - the tool arguments.
 * @returns the URL to contact.
 */
async function resolveUrl(git, fs, dir, args) {
  if (typeof args.url === 'string' && args.url !== '') return args.url
  if (args.name === undefined || args.name === '') {
    throw new Error('git_remote: this action needs either url or the name of a configured remote')
  }
  const remotes = await git.listRemotes({ fs, dir })
  const found = remotes.find(remote => remote.remote === args.name)
  if (found === undefined) {
    throw new Error(`git_remote: no remote named "${args.name}" is configured in ${dir} (configured: `
      + `${remotes.length === 0 ? 'none' : remotes.map(remote => remote.remote).join(', ')})`)
  }
  return found.url
}

/**
 * Register the `git_remote` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {import('../auth.js').GitCredentials} deps.credentials - the credential lookup.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitRemoteTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_remote',
    description: 'Inspect and configure remotes, and probe a server without cloning. `action: "list"` (the default) '
      + 'prints the configured remotes with their URLs. `action: "add"` (needs `name` and `url`) configures a '
      + 'remote, overwriting an existing one of that name when `force: true`. `action: "delete"` (needs `name`) '
      + 'removes it. `action: "refs"` asks the server for its refs without writing anything locally — give it '
      + '`url`, or `name` of a configured remote to use its URL; `prefix` limits the refs (for example '
      + '"refs/heads/") and `forPush: true` queries what a push would be allowed instead of a fetch. `action: '
      + '"info"` reports the server\'s git protocol version and capabilities. The probe actions need no local '
      + 'repository and go through the credential store by host, so a missing or refused credential is reported '
      + 'with the exact credential name rather than a bare 401. The local actions fail without a repository, and a '
      + '`dir` outside the session workspace is refused with an escalation hint.',
    parameters: {
      action: { type: 'string', enum: ACTIONS, description: 'What to do. Defaults to "list".' },
      dir: {
        type: 'string',
        description: 'Repository root, required for the local actions ("list", "add", "delete") and for a probe '
          + 'that names a configured remote. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      name: { type: 'string', description: 'Remote name, for example "origin".' },
      url: {
        type: 'string',
        description: 'Remote URL, for example "https://git.example.com/team/project.git". Needed by "add" and '
          + 'accepted by the probe actions.',
      },
      force: { type: 'boolean', description: 'For action "add": overwrite an existing remote. Defaults to false.' },
      prefix: {
        type: 'string',
        description: 'For action "refs": only list refs starting with this prefix, for example "refs/tags/".',
      },
      forPush: {
        type: 'boolean',
        description: 'For the probe actions: ask about push permissions instead of fetch. Defaults to false.',
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
          name: { type: 'string', required: true },
          url: { type: 'string', required: true },
          remotes: { type: 'json', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (_args, value) => {
        if (value.action === 'refs') {
          return [{ type: 'text', text: renderServerRefs(value.result, { url: value.url }) }]
        }
        if (value.action === 'info') {
          return [{ type: 'text', text: renderRemoteInfo(value.result, { url: value.url }) }]
        }
        return [{
          type: 'text',
          text: `${value.action === 'add' ? `Configured remote "${value.name}" -> ${value.url}.\n\n` : ''}`
            + `${value.action === 'delete' ? `Removed remote "${value.name}".\n\n` : ''}`
            + renderRemotes(value.remotes),
        }]
      },
    },
    async execute(args, exec) {
      let policy
      let guard
      const started = Date.now()
      let url = args.url ?? ''
      try {
        const action = args.action ?? 'list'
        if (!ACTIONS.includes(action)) {
          throw new Error(`git_remote: unknown action "${action}" (expected one of ${ACTIONS.join(', ')})`)
        }
        const { git, http } = await loadGit()

        if (action === 'refs' || action === 'info') {
          // The probe needs the git namespace and an HTTP client only — no repository, so no
          // repository is opened and nothing is written anywhere. A `dir` is still consulted when
          // no `url` was given, and that lookup can wait on an approval, so the network timeout is
          // armed only once the address is known: arming it earlier let a slow approval eat the
          // whole budget and fail the probe before it ever connected.
          if (url === '') {
            const opened = await deps.fence.open('git_remote', args, exec, args.dir)
            policy = opened.policy
            url = await resolveUrl(git, opened.fs, opened.root, args)
          }
          guard = guardedHttp(http, exec.signal, deps.config.networkTimeoutMs)
          const callbacks = deps.credentials.callbacks(url)
          const result = action === 'refs'
            ? await git.listServerRefs({
              http: guard.http,
              url,
              ...args.prefix === undefined ? {} : { prefix: args.prefix },
              forPush: args.forPush === true,
              symrefs: true,
              peelTags: true,
              signal: guard.signal,
              ...callbacks,
            })
            : await git.getRemoteInfo2({
              http: guard.http,
              url,
              forPush: args.forPush === true,
              signal: guard.signal,
              ...callbacks,
            })
          return { root: '', action, name: args.name ?? '', url: scrubUrl(url), remotes: [], result }
        }

        if (args.dir === undefined) {
          throw new Error(`git_remote: action "${action}" needs dir (the repository to configure)`)
        }
        const opened = await deps.fence.open('git_remote', args, exec, args.dir)
        policy = opened.policy
        const fs = opened.fs
        const dir = opened.root
        if (action === 'add') {
          if (args.name === undefined || args.name === '') throw new Error('git_remote: action "add" requires name')
          if (args.url === undefined || args.url === '') throw new Error('git_remote: action "add" requires url')
          await git.addRemote({
            fs,
            dir,
            remote: args.name,
            url: args.url,
            force: args.force === true,
            signal: exec.signal,
          })
          url = args.url
        } else if (action === 'delete') {
          if (args.name === undefined || args.name === '') {
            throw new Error('git_remote: action "delete" requires name')
          }
          await git.deleteRemote({ fs, dir, remote: args.name, signal: exec.signal })
        }
        const remotes = await git.listRemotes({ fs, dir, signal: exec.signal })
        return { root: dir, action, name: args.name ?? '', url: scrubUrl(url), remotes, result: null }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw await mapNetworkError(error, {
          tool: 'git_remote',
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
