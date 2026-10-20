/**
 * Host half of `@dsh-ohos/git`: the model-facing git tool family.
 *
 * Scope of this file is **assembly only** — it constructs the two collaborators every tool
 * shares and hands them to each tool's own registration function:
 *
 * - `GitRepositoryFence` — resolves and vets the repository root once per call, and carries the
 *   sandbox-escalation ladder for repositories outside the session workspace.
 * - `GitCredentials` — resolves HTTP credentials from the credential store, so no tool parameter
 *   ever carries a secret.
 *
 * `inject` names only services this file itself needs. `credentials` and `sandboxPolicy` are read
 * through `ctx.get(...)` instead, deliberately: a host-plane row that injects a service which
 * never appears stays pending forever, and that failure mode takes the whole plugin tree down
 * (see `profiles/desktop/cordis.patch.yml` for the same reasoning applied to `open-in-app`).
 *
 * Named exports only — a default export makes the Loader discard `inject`.
 *
 * @module @dsh-ohos/git
 */

import { Config } from './config.js'
import { GitCredentials } from './auth.js'
import { GitRepositoryFence } from './fence.js'
import { applyGitInitTool } from './tools/init.js'
import { applyGitCloneTool } from './tools/clone.js'
import { applyGitStatusTool } from './tools/status.js'
import { applyGitDiffTool } from './tools/diff.js'
import { applyGitLogTool } from './tools/log.js'
import { applyGitShowTool } from './tools/show.js'
import { applyGitAddTool } from './tools/add.js'
import { applyGitCommitTool } from './tools/commit.js'
import { applyGitBranchTool } from './tools/branch.js'
import { applyGitCheckoutTool } from './tools/checkout.js'
import { applyGitResetTool } from './tools/reset.js'
import { applyGitMergeTool } from './tools/merge.js'
import { applyGitCherryPickTool } from './tools/cherry-pick.js'
import { applyGitRevertTool } from './tools/revert.js'
import { applyGitStashTool } from './tools/stash.js'
import { applyGitTagTool } from './tools/tag.js'
import { applyGitRemoteTool } from './tools/remote.js'
import { applyGitFetchTool } from './tools/fetch.js'
import { applyGitPullTool } from './tools/pull.js'
import { applyGitPushTool } from './tools/push.js'
import { applyGitConfigTool } from './tools/config.js'

/** Plugin name used by loader diagnostics and the profile row. */
export const name = '@dsh-ohos/git'

/** Services required before any tool registers. */
export const inject = ['tools', 'fs']

export { Config }

/**
 * Every registration function in the family, in tool-name order. A list rather than a long run
 * of statements so the count is checkable in one place — the device test asserts the tool table
 * grew by exactly this many entries.
 * @type {readonly ((ctx: object, deps: object) => void)[]}
 */
export const TOOL_REGISTRARS = [
  applyGitInitTool,
  applyGitCloneTool,
  applyGitStatusTool,
  applyGitDiffTool,
  applyGitLogTool,
  applyGitShowTool,
  applyGitAddTool,
  applyGitCommitTool,
  applyGitBranchTool,
  applyGitCheckoutTool,
  applyGitResetTool,
  applyGitMergeTool,
  applyGitCherryPickTool,
  applyGitRevertTool,
  applyGitStashTool,
  applyGitTagTool,
  applyGitRemoteTool,
  applyGitFetchTool,
  applyGitPullTool,
  applyGitPushTool,
  applyGitConfigTool,
]

/**
 * Register the whole git tool family.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param config - the resolved plugin config (schemastery filled every default).
 */
export function apply(ctx, config) {
  const fence = new GitRepositoryFence(ctx)
  const credentials = new GitCredentials(ctx)
  const deps = { fence, credentials, config }

  for (const register of TOOL_REGISTRARS) register(ctx, deps)

  // The run-time self-report channel: the inspector cannot reach `ctx` (no host handle is
  // published), so this line in hilog is what proves the row activated on a device.
  console.log(`[dsh-ohos] @dsh-ohos/git: registered ${TOOL_REGISTRARS.length} tools`)
}
