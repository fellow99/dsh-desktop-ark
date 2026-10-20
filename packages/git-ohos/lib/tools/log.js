/**
 * The model-facing `git_log` tool: walk commit history.
 *
 * One limitation is worth naming: isomorphic-git's `log` follows **one** file path per call
 * (`filepath`, with `follow` for renames), so this tool takes a single `path` instead of a
 * pathspec list. Passing several paths would silently mean something else, which is exactly
 * what this plugin refuses to do.
 *
 * @module @dsh-ohos/git/tools/log
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderLog } from '../report.js'
import { resolveRevision } from './commit.js'

/**
 * Register the `git_log` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 */
export function applyGitLogTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_log',
    description: 'List commit history, newest first, with each commit\'s short id, author, date, parent count and '
      + 'subject. `ref` chooses where to start (a branch, tag, commit id, or "HEAD"). `depth` limits how many '
      + 'commits are returned; omit it for the full history. `path` follows the history of one file; `follow: true` '
      + 'keeps listing across renames. A repository with no commit yet is reported as such. Fails when `ref` cannot '
      + 'be resolved or `dir` is not a repository; a `dir` outside the session workspace is refused with an '
      + 'escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      ref: {
        type: 'string',
        description: 'Commit, branch or tag to start from; a full or abbreviated object id also works. Defaults to '
          + '"HEAD".',
      },
      depth: {
        type: 'number',
        description: 'Maximum number of commits to return. Omit for the complete history.',
      },
      path: {
        type: 'string',
        description: 'Repository-relative file path whose history to follow. Only one path is supported by the '
          + 'underlying git implementation; omit to walk the whole history.',
      },
      follow: {
        type: 'boolean',
        description: 'With `path`: keep following the file across renames. Defaults to false.',
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
          count: { type: 'number', required: true },
          commits: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderLog(value.commits, { ref: value.ref, root: value.root }),
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_log', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const requested = args.ref ?? 'HEAD'
        const { ref } = await resolveRevision(git, opened.fs, opened.root, requested)
        const commits = await git.log({
          fs: opened.fs,
          dir: opened.root,
          ref,
          ...args.depth === undefined ? {} : { depth: args.depth },
          ...args.path === undefined ? {} : { filepath: args.path },
          follow: args.follow === true,
          signal: exec.signal,
        })
        return { root: opened.root, ref, count: commits.length, commits }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_log', args, exec))
      }
    },
  }))
}
