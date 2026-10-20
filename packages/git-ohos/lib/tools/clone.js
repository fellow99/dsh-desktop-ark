/**
 * The model-facing `git_clone` tool: fetch a remote repository into a local working tree.
 *
 * Credentials never appear in the arguments: `deps.credentials.callbacks(url)` supplies
 * isomorphic-git's `onAuth`/`onAuthFailure` pair, which reads the credential store for this
 * host (see `../dsh-desktop-hos/docs/204-插件-GIT.md` §9). When the server asks for credentials and none are
 * stored, or stored ones are refused, the raw 401 is replaced by a message naming the exact
 * credential to create.
 *
 * @module @dsh-ohos/git/tools/clone
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { scrubErrorUrl, scrubUrl } from '../url.js'

/**
 * Build the HTTP client and abort signal for one network call.
 *
 * isomorphic-git's public API takes an `AbortSignal` only for `push`, but every network call
 * it makes goes through the HTTP client it was handed, whose `request` accepts a `signal`
 * (this is how `http/node` aborts a live `simple-get`). Injecting the composed signal here is
 * therefore what makes both cancellation and `networkTimeoutMs` real for `clone`.
 *
 * @param {object} http - the `isomorphic-git/http/node` client.
 * @param {AbortSignal | undefined} outer - the calling agent's signal, when there is one.
 * @param {number} timeoutMs - the configured wall-clock budget.
 * @returns the guarded client plus a predicate telling a timeout from a cancellation.
 */
export function guardedHttp(http, outer, timeoutMs) {
  const budget = AbortSignal.timeout(timeoutMs)
  const signal = outer === undefined ? budget : AbortSignal.any([outer, budget])
  return {
    signal,
    expired: () => budget.aborted,
    http: {
      request: request => http.request({ ...request, signal: request.signal ?? signal }),
    },
  }
}

/**
 * Register the `git_clone` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {import('../auth.js').GitCredentials} deps.credentials - the credential lookup.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitCloneTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_clone',
    description: 'Clone a remote repository into `dir` (the working tree is created there). `url` is the remote '
      + 'URL, for example "https://git.example.com/team/project.git"; `git@host:path` and `ssh://` URLs are '
      + 'rewritten to https by the git implementation, which has no SSH client. `depth` limits history '
      + '(use 1 for a shallow clone of a large repository), `singleBranch` fetches only `ref`, `noTags` skips '
      + 'tags. Public repositories need no credentials; for a private one, store "<username>:<password>" under '
      + 'GIT_CREDENTIAL_<HOST> first (Settings → Git 凭据, or $DSH_HOME/.credentials.yaml) — a missing or refused '
      + 'credential is reported with that exact name instead of a bare 401. A `dir` outside the session workspace '
      + 'is refused with an escalation hint. A clone that exceeds the network timeout is aborted and reports how '
      + 'long it ran.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Destination directory for the clone (the working tree). Created when missing, and expected '
          + 'to be empty; existing files are never overwritten silently. Resolved against the session workspace.',
      },
      url: {
        type: 'string',
        required: true,
        description: 'Remote repository URL, for example "https://git.example.com/team/project.git".',
      },
      ref: { type: 'string', description: 'Branch or tag to check out. Defaults to the remote\'s default branch.' },
      depth: {
        type: 'number',
        description: 'Number of commits to fetch per ref. Omit for the complete history; use 1 for a shallow '
          + 'clone, which is much faster and smaller on a large repository.',
      },
      singleBranch: {
        type: 'boolean',
        description: 'Fetch only the branch named by `ref` (or the default branch) instead of every branch.',
      },
      noTags: { type: 'boolean', description: 'Do not fetch tags. Defaults to false (tags are fetched).' },
      remote: { type: 'string', description: 'Name for the created remote. Defaults to "origin".' },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          url: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          head: { type: 'string', required: true },
          remote: { type: 'string', required: true },
          depth: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Cloned ${value.url} into ${value.root} as remote "${value.remote}".\n`
          + `Checked out ${value.branch === '' ? 'a detached HEAD' : `branch "${value.branch}"`} `
          + `at ${value.head}.\n`
          + `History: ${value.depth === 0 ? 'complete' : `shallow, ${value.depth} commit(s) per ref`}.`,
      }],
    },
    async execute(args, exec) {
      let policy
      const started = Date.now()
      let guard
      try {
        const opened = await deps.fence.open('git_clone', args, exec, args.dir)
        policy = opened.policy
        const { git, http } = await loadGit()
        guard = guardedHttp(http, exec.signal, deps.config.networkTimeoutMs)
        const remote = args.remote ?? 'origin'
        await git.clone({
          fs: opened.fs,
          http: guard.http,
          dir: opened.root,
          url: args.url,
          remote,
          ...args.ref === undefined ? {} : { ref: args.ref },
          ...args.depth === undefined ? {} : { depth: args.depth },
          singleBranch: args.singleBranch === true,
          noTags: args.noTags === true,
          signal: guard.signal,
          ...deps.credentials.callbacks(args.url),
        })
        const branch = await git.currentBranch({ fs: opened.fs, dir: opened.root, fullname: false })
        const head = await git.resolveRef({ fs: opened.fs, dir: opened.root, ref: 'HEAD' })
        return {
          root: opened.root,
          url: scrubUrl(args.url),
          branch: branch ?? '',
          head,
          remote,
          depth: args.depth ?? 0,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw await mapNetworkError(error, {
          tool: 'git_clone',
          url: args.url,
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
 * Turn one failed network call into the error the model should read.
 * @param {unknown} error - the error the git call threw.
 * @param {object} context - the failing call's context.
 * @param {string} context.tool - the tool name, for the message.
 * @param {string} context.url - the remote URL that was contacted.
 * @param {number} context.elapsedMs - how long the call ran.
 * @param {{expired: () => boolean} | undefined} context.guard - the timeout guard, when one was built.
 * @param {object} context.deps - the tool dependencies (credentials, fence, config).
 * @param {object | undefined} context.policy - the policy stamped onto the call.
 * @param {object} context.args - the call's escalation arguments.
 * @param {object} context.exec - the tool-execution context.
 * @returns the error to throw.
 */
export async function mapNetworkError(error, context) {
  const { deps, guard } = context
  // The server demanded credentials and isomorphic-git cancelled the request: report the exact
  // credential to create (or to fix) instead of the bare "operation was canceled".
  const status = error instanceof Error ? error.data?.statusCode : undefined
  const authFailure = error instanceof Error
    && (error.code === 'UserCanceledError' || ((error.code === 'HttpError') && (status === 401 || status === 403)))
  if (authFailure) {
    const stored = await deps.credentials.lookup(context.url)
    return new Error(stored === undefined
      ? deps.credentials.missingMessage(context.url)
      : deps.credentials.rejectedMessage(context.url))
  }
  if (guard !== undefined && guard.expired()) {
    return new Error(`@dsh-ohos/git: ${context.tool} did not finish within `
      + `${deps.config.networkTimeoutMs} ms (networkTimeoutMs) and was aborted after `
      + `${Math.round(context.elapsedMs / 1000)} s. For a large repository retry with a smaller \`depth\` and `
      + '`singleBranch: true`, or raise networkTimeoutMs for this deployment.')
  }
  // isomorphic-git and the HTTP layer sometimes quote the address they contacted, and the fence
  // preserves an error it cannot classify — so the text is redacted here, once, before it can
  // reach the model (AC-8).
  return scrubErrorUrl(
    deps.fence.mapError(
      error,
      context.policy ?? await deps.fence.resolvePolicy(context.tool, context.args, context.exec),
    ),
    context.url,
  )
}
