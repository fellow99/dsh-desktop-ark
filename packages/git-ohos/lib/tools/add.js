/**
 * The model-facing `git_add` tool: move work in and out of the index.
 *
 * `git.add` skips ignored files without saying so, so this tool reports every requested path
 * that the `.gitignore` rules kept out, together with the `force: true` remedy — a silent
 * skip would look like a successful stage.
 *
 * @module @dsh-ohos/git/tools/add
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderPathList, renderStatus } from '../report.js'

/** The index actions this tool exposes. */
const ACTIONS = ['add', 'remove', 'unstage', 'ignored']

/**
 * Register the `git_add` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 */
export function applyGitAddTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_add',
    description: 'Change the staging area (the index) for `paths`. `action: "add"` stages the current content of '
      + 'each path (a directory stages everything inside it); `action: "remove"` records a deletion in the index '
      + 'for a file that is already gone from the working tree; `action: "unstage"` resets an index entry to HEAD, '
      + 'which unstages a newly added file as well; `action: "ignored"` writes nothing and only reports whether '
      + 'each path is matched by .gitignore. Ignored paths are reported instead of staged unless `force: true`. '
      + 'The report shows the resulting index state for the requested paths, so a path that changed nothing reads '
      + 'as such instead of looking staged. Fails for a path that leaves the repository; a `dir` outside the '
      + 'session workspace is refused with an escalation hint.',
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
        description: 'What to do with the index. Defaults to "add".',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Repository-relative paths (files or directories) to operate on.',
      },
      force: {
        type: 'boolean',
        description: 'With action "add": stage the paths even when .gitignore matches them. Defaults to false.',
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
          paths: { type: 'array', required: true, items: { type: 'string' } },
          ignored: { type: 'array', required: true, items: { type: 'string' } },
          rows: { type: 'json', required: true },
          branch: { type: 'string', required: true },
          head: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const ignored = value.ignored.length === 0
          ? ''
          : `\n\nLeft alone because .gitignore matches them (action "add" with force: true overrides this):\n`
            + renderPathList(value.ignored, '')
        const what = value.action === 'ignored'
          ? 'Index unchanged: action "ignored" only reports.'
          : `Index updated for ${value.paths.length} requested path(s).`
        return [{
          type: 'text',
          text: `${what}${ignored}\n\nIndex state now:\n${renderStatus(value.rows, {
            root: value.root,
            branch: value.branch === '' ? undefined : value.branch,
            head: value.head,
            conflicts: [],
          })}`,
        }]
      },
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_add', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const action = args.action ?? 'add'
        if (!ACTIONS.includes(action)) {
          throw new Error(`git_add: unknown action "${action}" (expected one of ${ACTIONS.join(', ')})`)
        }
        const paths = args.paths
        if (paths.length === 0) throw new Error('git_add: paths must contain at least one path')
        for (const path of paths) {
          if (path.trim() === '') throw new Error('git_add: paths must not contain an empty path')
        }

        const ignored = []
        for (const path of paths) {
          if (await git.isIgnored({ fs: opened.fs, dir: opened.root, filepath: path })) ignored.push(path)
        }

        if (action === 'add') {
          await git.add({
            fs: opened.fs,
            dir: opened.root,
            filepath: paths,
            force: args.force === true,
            signal: exec.signal,
          })
        } else if (action === 'remove') {
          await git.remove({ fs: opened.fs, dir: opened.root, filepath: paths, signal: exec.signal })
        } else if (action === 'unstage') {
          // No explicit `ref`: that is what makes an unborn branch (a repository without a first
          // commit) behave as "drop the index entry" instead of failing to resolve HEAD.
          for (const path of paths) {
            await git.resetIndex({ fs: opened.fs, dir: opened.root, filepath: path, signal: exec.signal })
          }
        }

        const rows = await git.statusMatrix({
          fs: opened.fs,
          dir: opened.root,
          filepaths: paths,
          signal: exec.signal,
        })
        // Read after the change, so the report's header describes the same state the rows do — the
        // render calls `renderStatus`, which otherwise has no branch to name and prints "On detached
        // HEAD" even on a branch (the same call shape `git_reset` already uses).
        let branch = ''
        try {
          branch = (await git.currentBranch({
            fs: opened.fs,
            dir: opened.root,
            fullname: false,
            signal: exec.signal,
          })) ?? ''
        } catch {
          branch = ''
        }
        let head = ''
        try {
          head = await git.resolveRef({ fs: opened.fs, dir: opened.root, ref: 'HEAD' })
        } catch {
          head = ''
        }
        return { root: opened.root, action, paths, ignored, rows, branch, head }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_add', args, exec))
      }
    },
  }))
}
