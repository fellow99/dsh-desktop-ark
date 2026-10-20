/**
 * The model-facing `git_config` tool: read and write the repository's config.
 *
 * This is where identity comes from (`../dsh-desktop-hos/docs/204-插件-GIT.md` §9.3): `setConfig` with path
 * `user.name` / `user.email` makes every later commit, merge and stash use that identity
 * instead of the plugin's placeholder defaults. Values are written literally, exactly as they
 * would appear in `.git/config`; git parses `true`/`false` and numbers back into their types
 * when reading.
 *
 * @module @dsh-ohos/git/tools/config
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { renderConfigValue, renderConfigValues } from '../report.js'

/** The config actions this tool exposes. */
const ACTIONS = ['get', 'get-all', 'set', 'unset']

/**
 * Register the `git_config` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 */
export function applyGitConfigTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_config',
    description: 'Read and write this repository\'s git config. `action: "get"` (the default) reads one key; '
      + '"get-all" reads every value of a multi-valued key (for example remote.origin.fetch); "set" writes `value` '
      + 'at `path` (`append: true` adds another value instead of replacing); "unset" removes the key. Sets are '
      + 'repository-local, so `user.name` and `user.email` set here become the identity of later commits, merges '
      + 'and stashes, taking precedence over the plugin defaults. Only the repository config is touched — there is '
      + 'no global config in this deployment. Reading or writing a key that does not exist is reported as such '
      + 'rather than as an error. Fails when `path` is missing or `dir` is not a repository; a `dir` outside the '
      + 'session workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      action: { type: 'string', enum: ACTIONS, description: 'What to do. Defaults to "get".' },
      path: {
        type: 'string',
        required: true,
        description: 'The config key, for example "user.name", "user.email" or "remote.origin.url".',
      },
      value: {
        type: 'string',
        description: 'For action "set": the value to store. Written literally, as git config would.',
      },
      append: {
        type: 'boolean',
        description: 'For action "set": append another value instead of replacing the existing one. Defaults false.',
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
          path: { type: 'string', required: true },
          value: { type: 'json', required: true },
          values: { type: 'json', required: true },
        },
      },
      render: (_args, value) => {
        if (value.action === 'get') {
          return [{ type: 'text', text: `${value.path} in ${value.root}\n${renderConfigValue(value.path, value.value)}` }]
        }
        if (value.action === 'get-all') {
          return [{ type: 'text', text: `${value.path} in ${value.root}\n${renderConfigValues(value.path, value.values)}` }]
        }
        if (value.action === 'unset') {
          return [{
            type: 'text',
            text: `Removed ${value.path} from the repository config.\n`
              + renderConfigValue(value.path, value.value),
          }]
        }
        return [{
          type: 'text',
          text: `Wrote ${value.path} in ${value.root}:\n${renderConfigValue(value.path, value.value)}`,
        }]
      },
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_config', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const fs = opened.fs
        const dir = opened.root
        const action = args.action ?? 'get'
        if (!ACTIONS.includes(action)) {
          throw new Error(`git_config: unknown action "${action}" (expected one of ${ACTIONS.join(', ')})`)
        }
        const path = args.path
        if (typeof path !== 'string' || path.trim() === '') {
          throw new Error('git_config: path must be a non-empty config key')
        }

        if (action === 'set') {
          if (args.value === undefined) throw new Error('git_config: action "set" requires value')
          await git.setConfig({
            fs,
            dir,
            path,
            value: args.value,
            append: args.append === true,
            signal: exec.signal,
          })
        } else if (action === 'unset') {
          // `undefined` deletes the entry — the documented way to remove a key.
          await git.setConfig({ fs, dir, path, value: undefined, signal: exec.signal })
        }

        const values = await git.getConfigAll({ fs, dir, path, signal: exec.signal })
        const value = await git.getConfig({ fs, dir, path, signal: exec.signal })
        return {
          root: dir,
          action,
          path,
          // The output schema cannot express `undefined`, so an unset key is carried as `null` and
          // `renderConfigValue` reads `null` back as "not set" — the model never sees the literal
          // word `null` for a key that simply does not exist (§10's honesty rule).
          value: value === undefined ? null : value,
          values,
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_config', args, exec))
      }
    },
  }))
}
