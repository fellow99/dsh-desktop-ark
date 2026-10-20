/**
 * The model-facing `git_tag` tool: lightweight and annotated tags, listed, created, deleted.
 * @module @dsh-ohos/git/tools/tag
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderTags } from '../report.js'
import { resolveRevision } from './commit.js'

/** The tag actions this tool exposes. */
const ACTIONS = ['list', 'create', 'delete']

/**
 * Register the `git_tag` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitTagTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_tag',
    description: 'List, create or delete tags. `action: "list"` (the default) prints them all. `action: "create"` '
      + 'creates `name` pointing at `object` (default "HEAD"; can be a commit id, branch or tag). With `message` it '
      + 'is an annotated tag (a real object carrying tagger, date and text); without it, a lightweight ref. An '
      + 'existing tag is only overwritten with `force: true`. `action: "delete"` removes the tag `name` locally — it '
      + 'does not touch the remote (delete a remote tag by pushing it with `delete: true`). The tagger identity of '
      + 'an annotated tag comes from `taggerName`/`taggerEmail`, else this repository\'s user.name/user.email, else '
      + 'the plugin defaults. Fails when `name` is missing, the target cannot be resolved, or `dir` is not a '
      + 'repository; a `dir` outside the session workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      action: { type: 'string', enum: ACTIONS, description: 'What to do. Defaults to "list".' },
      name: { type: 'string', description: 'Tag name: the tag to create or delete.' },
      object: { type: 'string', description: 'For action "create": what the tag points at. Defaults to "HEAD".' },
      message: {
        type: 'string',
        description: 'For action "create": the annotation text. Providing it makes the tag annotated.',
      },
      force: {
        type: 'boolean',
        description: 'For action "create": overwrite an existing tag of the same name. Defaults to false.',
      },
      taggerName: { type: 'string', description: 'For an annotated tag: the tagger name, overriding the config.' },
      taggerEmail: { type: 'string', description: 'For an annotated tag: the tagger email, overriding the config.' },
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
          annotated: { type: 'boolean', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.action === 'list'
          ? ''
          : value.action === 'create'
            ? `Created ${value.annotated ? 'annotated' : 'lightweight'} tag "${value.name}".\n\n`
            : `Deleted tag "${value.name}".\n\n`}${renderTags(value.tags)}`,
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_tag', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        const action = args.action ?? 'list'
        if (!ACTIONS.includes(action)) {
          throw new Error(`git_tag: unknown action "${action}" (expected one of ${ACTIONS.join(', ')})`)
        }
        if (action !== 'list' && (args.name === undefined || args.name.trim() === '')) {
          throw new Error(`git_tag: action "${action}" requires name`)
        }
        if (action === 'create') {
          const object = (await resolveRevision(git, fs, dir, args.object ?? 'HEAD')).ref
          if (args.message === undefined) {
            await git.tag({ fs, dir, ref: args.name, object, force: args.force === true, signal: exec.signal })
          } else {
            const name = await git.getConfig({ fs, dir, path: 'user.name' })
            const email = await git.getConfig({ fs, dir, path: 'user.email' })
            await git.annotatedTag({
              fs,
              dir,
              ref: args.name,
              object,
              message: args.message,
              force: args.force === true,
              tagger: {
                name: args.taggerName ?? (typeof name === 'string' && name !== '' ? name : deps.config.authorName),
                email: args.taggerEmail ?? (typeof email === 'string' && email !== '' ? email : deps.config.authorEmail),
              },
              signal: exec.signal,
            })
          }
        } else if (action === 'delete') {
          await git.deleteTag({ fs, dir, ref: args.name, signal: exec.signal })
        }
        const tags = await git.listTags({ fs, dir, signal: exec.signal })
        return { root: dir, action, name: args.name ?? '', annotated: args.message !== undefined, tags }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_tag', args, exec))
      }
    },
  }))
}
