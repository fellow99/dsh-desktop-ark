/**
 * The model-facing `git_commit` tool, and the identity resolution the other commit-creating
 * tools share.
 *
 * Identity comes from three places, in priority order: the call's `authorName`/`authorEmail`
 * arguments, then the repository's own `user.name`/`user.email` (written by `git_config`),
 * then the plugin config defaults — which are deliberately obvious placeholders
 * (`../dsh-desktop-hos/docs/204-插件-GIT.md` §9.3), never a real person. The report always says which one was
 * used, so a commit made under the placeholder is visible rather than a silent surprise.
 *
 * @module @dsh-ohos/git/tools/commit
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'

/**
 * Resolve the author and committer identity for one commit-creating call.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} root - the repository root.
 * @param {object} config - the resolved plugin config.
 * @param {{authorName?: string, authorEmail?: string}} [args] - the call's explicit overrides.
 * @returns the identity plus the source it came from.
 */
export async function resolveIdentity(git, fs, root, config, args = {}) {
  const configuredName = await git.getConfig({ fs, dir: root, path: 'user.name' })
  const configuredEmail = await git.getConfig({ fs, dir: root, path: 'user.email' })
  const repoName = typeof configuredName === 'string' && configuredName !== '' ? configuredName : undefined
  const repoEmail = typeof configuredEmail === 'string' && configuredEmail !== '' ? configuredEmail : undefined
  const overridden = args.authorName !== undefined || args.authorEmail !== undefined
  const name = args.authorName ?? repoName ?? config.authorName
  const email = args.authorEmail ?? repoEmail ?? config.authorEmail
  const source = overridden
    ? 'the tool arguments'
    : repoName !== undefined || repoEmail !== undefined
      ? 'this repository\'s user.name / user.email'
      : 'the plugin config default (this repository has no user.name / user.email — set them with git_config)'
  return { name, email, source }
}

/**
 * Resolve a caller-supplied revision to the form the git implementation accepts.
 *
 * `resolveRef` understands exact ref names and full object ids only: ancestry syntax
 * (`HEAD~1`, `HEAD^`), reflog syntax and **abbreviated** ids all raise `NotFoundError` in
 * isomorphic-git 1.44.2. An abbreviated id is exactly what `git_log` prints, so a hex prefix is
 * expanded with `expandOid` (the primitive the design lists for this) and anything else fails
 * with a message that says what is supported instead of a bare "could not find".
 *
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @param {string} revision - the branch, tag or object id the caller named.
 * @returns the original revision when `resolveRef` accepted it, plus the full object id.
 * @throws when the revision cannot be resolved.
 */
export async function resolveRevision(git, fs, dir, revision) {
  try {
    return { ref: revision, oid: await git.resolveRef({ fs, dir, ref: revision }) }
  } catch (error) {
    if (/^[0-9a-f]{4,39}$/i.test(revision)) {
      try {
        const oid = await git.expandOid({ fs, dir, oid: revision })
        return { ref: oid, oid }
      } catch (expanded) {
        throw new Error(`@dsh-ohos/git: the abbreviated object id "${revision}" could not be expanded `
          + `(${expanded instanceof Error ? expanded.message : String(expanded)}).`)
      }
    }
    throw new Error(`@dsh-ohos/git: "${revision}" cannot be resolved in ${dir} `
      + `(${error instanceof Error ? error.message : String(error)}). Use a branch name, a tag, "HEAD", or the `
      + 'full or abbreviated object id of a commit. Ancestry syntax such as "HEAD~1" is not implemented by the '
      + 'git library in this deployment: read the parent id from git_log and pass that.')
  }
}

/**
 * Register the `git_commit` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitCommitTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_commit',
    description: 'Record the staged changes in `dir` as a new commit. Only what is staged is committed, so run '
      + '`git_add` first; `all: true` stages every modified and new file first for convenience, but it does not '
      + 'record deletions (use `git_add` with action "remove" for a deleted file). `message` becomes the commit '
      + 'message (a single line with a blank line and a body is fine). `amend: true` replaces the previous commit '
      + 'instead of adding a new one. The identity is taken from `authorName`/`authorEmail` when given, else from '
      + 'this repository\'s user.name/user.email, else from the plugin defaults — the report names the source used. '
      + 'Committing with an unresolved merge in the index is refused by the underlying git implementation, which '
      + 'names the unmerged paths. Fails when there is nothing staged; a `dir` outside the session workspace is '
      + 'refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Commit message. Required even with `amend`.',
      },
      all: {
        type: 'boolean',
        description: 'Stage every modified or new file before committing (a convenience for a small change). '
          + 'Deletions are not staged by this option. Defaults to false.',
      },
      amend: {
        type: 'boolean',
        description: 'Replace the commit HEAD currently points at instead of adding a new commit. Defaults to false.',
      },
      authorName: { type: 'string', description: 'Author name for this commit, overriding the config value.' },
      authorEmail: { type: 'string', description: 'Author email for this commit, overriding the config value.' },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          oid: { type: 'string', required: true },
          branch: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          author: { type: 'string', required: true },
          identitySource: { type: 'string', required: true },
          amended: { type: 'boolean', required: true },
          stagedFirst: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.amended ? 'Amended' : 'Created'} commit ${value.oid}`
          + `${value.branch === '' ? ' on a detached HEAD' : ` on branch "${value.branch}"`}.\n`
          + `Subject: ${value.subject}\n`
          + `Author:  ${value.author} (from ${value.identitySource})\n`
          + `${value.stagedFirst ? 'Every modified or new file was staged first (deletions are not staged by `all`).\n' : ''}`
          + 'Push it with git_push when the remote should have it.',
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_commit', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        if (typeof args.message !== 'string' || args.message.trim() === '') {
          throw new Error('git_commit: message must be a non-empty commit message')
        }
        const stagedFirst = args.all === true
        if (stagedFirst) {
          // `git.add` skips ignored files and cannot see a deletion; both are documented in the
          // tool description rather than papered over here.
          await git.add({ fs: opened.fs, dir: opened.root, filepath: '.', signal: exec.signal })
        }
        const identity = await resolveIdentity(git, opened.fs, opened.root, deps.config, args)
        const author = { name: identity.name, email: identity.email }
        const oid = await git.commit({
          fs: opened.fs,
          dir: opened.root,
          message: args.message,
          author,
          committer: author,
          amend: args.amend === true,
          signal: exec.signal,
        })
        let branch
        try {
          branch = await git.currentBranch({ fs: opened.fs, dir: opened.root, fullname: false })
        } catch {
          branch = undefined
        }
        return {
          root: opened.root,
          oid,
          branch: branch ?? '',
          subject: args.message.split('\n')[0],
          author: `${identity.name} <${identity.email}>`,
          identitySource: identity.source,
          amended: args.amend === true,
          stagedFirst,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_commit', args, exec))
      }
    },
  }))
}
