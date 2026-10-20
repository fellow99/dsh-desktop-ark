/**
 * The model-facing `git_push` tool.
 *
 * The rule that shapes this file: a push is whatever the **server** says it is. isomorphic-git
 * throws `GitPushError` whenever a ref was not updated and attaches the server's own
 * `PushResult`, so this tool prints that result verbatim — `ok`, each ref's `error` — and never
 * retries, never forces and never reports a rejection as a success (`../dsh-desktop-hos/docs/204-插件-GIT.md` §13).
 *
 * @module @dsh-ohos/git/tools/push
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderPushResult } from '../report.js'
import { guardedHttp, mapNetworkError } from './clone.js'
import { scrubUrl } from '../url.js'

/**
 * The server's push result, when an error carries one.
 * @param {unknown} error - the error the push threw.
 * @returns the `PushResult`, or `undefined`.
 */
function serverResult(error) {
  const result = error instanceof Error ? error.data?.result : undefined
  return result !== null && typeof result === 'object' ? result : undefined
}

/**
 * Register the `git_push` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {import('../auth.js').GitCredentials} deps.credentials - the credential lookup.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitPushTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_push',
    description: 'Push a branch or tag to a remote. `remote` defaults to "origin"; `ref` defaults to the '
      + 'checked-out branch and may be a branch or a tag; `remoteRef` names the ref to create on the server (for '
      + 'example pushing local "main" to remote "dsh-204-test"). `force: true` is `git push --force` and can '
      + 'discard commits on the server; `delete: true` deletes the remote ref instead of pushing it. The result '
      + 'always reports the server\'s own answer, per ref: a rejected push (non-fast-forward, protected branch, '
      + 'refused tag) is reported with the server\'s `error` text and is never retried, forced or dressed up as a '
      + 'success. Credentials come from the credential store by host; a missing or refused credential is reported '
      + 'with the exact credential name instead of a bare 401. A push that outlives the network timeout is aborted '
      + 'with the elapsed time. A `dir` outside the session workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      remote: { type: 'string', description: 'Remote to push to. Defaults to "origin".' },
      url: {
        type: 'string',
        description: 'Remote URL, overriding the configured one, for example '
          + '"https://git.example.com/team/project.git".',
      },
      ref: { type: 'string', description: 'The local branch or tag to push. Defaults to the checked-out branch.' },
      remoteRef: { type: 'string', description: 'The ref name to update on the remote.' },
      force: { type: 'boolean', description: 'Push even without a fast-forward (discards remote commits). Defaults false.' },
      delete: { type: 'boolean', description: 'Delete the remote ref instead of pushing it. Defaults to false.' },
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
          ref: { type: 'string', required: true },
          forced: { type: 'boolean', required: true },
          deleted: { type: 'boolean', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `git_push ${value.deleted ? 'delete ' : ''}${value.forced ? '--force ' : ''}`
          + `${value.ref} -> ${value.remote}${value.url === '' ? '' : ` (${value.url})`}\n\n`
          + renderPushResult(value.result),
      }],
    },
    async execute(args, exec) {
      let policy
      let guard
      const started = Date.now()
      const remote = args.remote ?? 'origin'
      // Declared before the `try` so the catch can name the address the push failed against: the
      // credential key (`GIT_CREDENTIAL_<HOST>`) is derived from the URL, so a failure path that
      // only had the remote *name* ("origin") would report "no credentials are configured" without
      // ever naming the key the user has to create (FR-5.3).
      let url = args.url ?? ''
      try {
        const opened = await deps.fence.open('git_push', args, exec, args.dir)
        policy = opened.policy
        const { git, http } = await loadGit()
        const remotes = await git.listRemotes({ fs: opened.fs, dir: opened.root, signal: exec.signal })
        url = args.url ?? remotes.find(entry => entry.remote === remote)?.url ?? ''
        const ref = args.ref ?? (await git.currentBranch({
          fs: opened.fs,
          dir: opened.root,
          fullname: false,
          signal: exec.signal,
        })) ?? ''
        if (ref === '') {
          throw new Error('git_push: HEAD is detached and no ref was given; pass ref (the branch or tag to push)')
        }
        guard = guardedHttp(http, exec.signal, deps.config.networkTimeoutMs)
        const result = await git.push({
          fs: opened.fs,
          http: guard.http,
          dir: opened.root,
          remote,
          ref,
          ...args.url === undefined ? {} : { url: args.url },
          ...args.remoteRef === undefined ? {} : { remoteRef: args.remoteRef },
          force: args.force === true,
          delete: args.delete === true,
          // `push` is the one isomorphic-git call that takes an AbortSignal itself.
          signal: guard.signal,
          ...deps.credentials.callbacks(url),
        })
        return {
          root: opened.root,
          remote,
          url: scrubUrl(url),
          ref,
          forced: args.force === true,
          deleted: args.delete === true,
          result,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        // A rejected push arrives as an error carrying the server's PushResult: print it in the
        // server's own words rather than inventing an interpretation.
        const carried = serverResult(error)
        if (carried !== undefined) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`${message}\n\n${renderPushResult(carried)}`)
        }
        throw await mapNetworkError(error, {
          tool: 'git_push',
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
