/**
 * Plugin configuration for `@dsh-ohos/git`. Every deployment-varying tunable lives
 * here rather than as a hardcoded literal, so a profile row can override it without a
 * code change (the `DEFAULT_`-prefixed exports name the defaults).
 * @module @dsh-ohos/git/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * Default commit/merge author name. **Deliberately an obvious placeholder** — the plugin
 * must never bake a real person's identity into a shipped artifact. Real identities come
 * from the repository-local config the `git_config` tool writes.
 */
export const DEFAULT_AUTHOR_NAME = 'yourname'

/** Default commit/merge author email; same placeholder rationale as {@link DEFAULT_AUTHOR_NAME}. */
export const DEFAULT_AUTHOR_EMAIL = 'yourname@somehost'

/**
 * Per-file byte cap for `git_diff`. The unified diff is produced in memory, so one huge
 * blob must never be read whole; a file above this cap is reported as skipped rather than
 * silently truncated.
 */
export const DEFAULT_MAX_DIFF_BLOB_BYTES = 1024 * 1024

/**
 * Wall-clock budget for one network operation (`clone`/`fetch`/`pull`/`push`). Pure-JS git
 * over a slow link needs room, but an unbounded request would pin the host process.
 */
export const DEFAULT_NETWORK_TIMEOUT_MS = 5 * 60 * 1000

/** Plugin config schema; every key is optional and the defaults above apply. */
export const Config = z.object({
  authorName: z.string().default(DEFAULT_AUTHOR_NAME),
  authorEmail: z.string().default(DEFAULT_AUTHOR_EMAIL),
  maxDiffBlobBytes: z.natural().default(DEFAULT_MAX_DIFF_BLOB_BYTES),
  networkTimeoutMs: z.natural().default(DEFAULT_NETWORK_TIMEOUT_MS),
})
