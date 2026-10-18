/**
 * `@dsh-ohos/sandbox` — `ctx.sandbox` provider for HarmonyOS: policy only.
 *
 * HarmonyOS offers no kernel confinement the app can rely on (no bwrap,
 * Landlock, Seatbelt, or Windows ACL equivalent), and the platform notes record
 * `sandbox: none` as a platform fact, not a defect. Consequently:
 * - `confine()` never rewrites `argv` and never claims a boundary it does not
 *   have. It returns the seam's `ConfinedArgv` shape with `enforcement:
 *   'partial'` (the closest vocabulary value: "cannot govern every promised
 *   file effect") plus explicit honest facts (`isolation: 'none'`,
 *   `enforced: false`) so consumers can surface "no sandbox" in the UI;
 * - the policy layer is real: {@link writableRoots} / {@link isPathWritable}
 *   derive the write allow-list from `SandboxExecutionPolicy` (mode +
 *   `workspaceRoot`) exactly like the upstream derivation
 *   (`packages/sandbox/sandbox/src/roots.ts:52-55`), extended with the three
 *   fixed user directories when they are available;
 * - there is no `writableRoots` config key — the upstream `Config` has only
 *   `mode`/`workspaceRoot` (`packages/sandbox/sandbox-policy/src/index.ts:71-79`)
 *   and roots are derived, never configured here.
 *
 * The strict alternative (upstream `sandbox-local` behavior) is
 * {@link SandboxUnavailableError}: `confineStrict()` throws it whenever a
 * confining mode is requested, for deployments that prefer fail-closed.
 *
 * @module @dsh-ohos/sandbox
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { Service } from '@deepseek-ai/cordis'

/** Closed sandbox mode vocabulary (`packages/sandbox/sandbox/src/index.ts:30`). */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** Error code used by the fail-closed path (`sandbox/src/index.ts:125`). */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/** Fixed user directories exposed by the workspace picker (`Constants.ets:38-39`). */
export const USER_DIR_NAMES = Object.freeze(['Desktop', 'Documents', 'Download'])

/** Environment variables set by the ArkTS runtime. */
export const WORKSPACE_ENV = 'DSH_OHOS_WORKSPACE'
export const USER_ROOT_ENV = 'DSH_OHOS_USER_ROOT'

/** Honest capability facts for this provider. */
export const OHOS_SANDBOX_CAPABILITIES = Object.freeze({
  sandbox: 'none',
  kernelIsolation: false,
  enforcement: 'none',
  argvRewrite: false,
  policyLayer: true,
  note: 'HarmonyOS app domain has no kernel confinement; write policy is enforced by in-process checks only',
})

/** Seam-shaped failure for callers that require real confinement. */
export class SandboxUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {{ mode?: string, hint?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'SandboxUnavailableError'
    this.code = SANDBOX_UNAVAILABLE
    if (details.mode !== undefined) this.mode = details.mode
    if (details.hint !== undefined) this.hint = details.hint
  }
}

/**
 * Canonical path (symlinks resolved); a missing path is returned as written.
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Containment check on canonical paths.
 * @param {string} child
 * @param {string} root
 * @returns {boolean}
 */
export function isPathUnder(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string' || child === '' || root === '') return false
  const rel = relative(canonicalPath(root), canonicalPath(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Validate one execution policy.
 * @param {{ mode?: string, workspaceRoot?: string }} policy
 * @returns {{ mode: string, workspaceRoot: string }}
 * @throws {Error}
 */
export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object') throw new Error('sandbox-ohos: policy must be an object')
  if (!SANDBOX_MODES.includes(policy.mode)) {
    throw new Error(`sandbox-ohos: unknown mode ${JSON.stringify(policy.mode)}; expected one of ${SANDBOX_MODES.join(', ')}`)
  }
  if (typeof policy.workspaceRoot !== 'string' || !isAbsolute(policy.workspaceRoot)) {
    throw new Error('sandbox-ohos: workspaceRoot must be an absolute execution-world path')
  }
  return { mode: policy.mode, workspaceRoot: policy.workspaceRoot }
}

/**
 * The roots one execution may WRITE under, derived from the policy.
 *
 * `read-only` allows nothing; `workspace-write` allows the workspace root, the
 * platform temp areas (upstream parity), and — when `userRoot` is known — the
 * three fixed user directories (`Desktop`/`Documents`/`Download`).
 * `danger-full-access` is unbounded and represented by an empty list.
 * @param {{ mode: string, workspaceRoot: string }} policy
 * @param {{ userRoot?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string[]}
 */
export function writableRoots(policy, options = {}) {
  const { mode, workspaceRoot } = validatePolicy(policy)
  if (mode !== 'workspace-write') return []
  const env = options.env ?? process.env
  const userRoot = options.userRoot ?? (typeof env[USER_ROOT_ENV] === 'string' && isAbsolute(env[USER_ROOT_ENV]) ? env[USER_ROOT_ENV] : undefined)
  const candidates = [workspaceRoot, '/tmp', tmpdir()]
  if (userRoot !== undefined) for (const name of USER_DIR_NAMES) candidates.push(join(userRoot, name))
  return [...new Set(candidates.filter(candidate => typeof candidate === 'string' && isAbsolute(candidate)).map(canonicalPath))]
}

/**
 * Whether `path` is writable under `policy`.
 * - `danger-full-access` → true;
 * - `read-only` → false;
 * - `workspace-write` → containment in {@link writableRoots}.
 * This is a trusted-code policy check, not a kernel boundary.
 * @param {string} path
 * @param {{ mode: string, workspaceRoot: string }} policy
 * @param {{ userRoot?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean}
 */
export function isPathWritable(path, policy, options = {}) {
  if (typeof path !== 'string' || path === '') return false
  const { mode } = validatePolicy(policy)
  if (mode === 'danger-full-access') return true
  if (mode === 'read-only') return false
  return writableRoots(policy, options).some(root => isPathUnder(path, root))
}

/**
 * `ctx.sandbox` for HarmonyOS.
 */
export class OhosSandboxProvider extends Service {
  constructor(ctx) {
    super(ctx, 'sandbox')
  }

  /**
   * The honest capability facts (`sandbox: 'none'`).
   * @returns {typeof OHOS_SANDBOX_CAPABILITIES}
   */
  capabilities() {
    return OHOS_SANDBOX_CAPABILITIES
  }

  /**
   * Return the (unchanged) argv with explicit non-enforcement facts.
   * @param {readonly string[]} argv
   * @param {{ mode: string, workspaceRoot: string }} policy
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async confine(argv, policy, signal) {
    signal?.throwIfAborted()
    if (!Array.isArray(argv) || argv.length === 0) throw new Error('sandbox-ohos: confine requires a non-empty argv')
    const validated = validatePolicy(policy)
    return {
      argv: [...argv],
      // The closest seam value: confinement exists in policy only, so no
      // promised file effect is governed by a kernel boundary.
      enforcement: 'partial',
      denialSignatures: [],
      runnerFailureRules: [],
      // Honest extension fields (structural typing: ignored by consumers that
      // only read ConfinedArgv; read by ours and the facts endpoint).
      isolation: 'none',
      enforced: false,
      mode: validated.mode,
      workspaceRoot: canonicalPath(validated.workspaceRoot),
    }
  }

  /**
   * Fail-closed variant: refuse every confining mode.
   * @param {readonly string[]} argv
   * @param {{ mode: string, workspaceRoot: string }} policy
   * @param {AbortSignal} [signal]
   * @returns {Promise<never>}
   */
  async confineStrict(argv, policy, signal) {
    signal?.throwIfAborted()
    const validated = validatePolicy(policy)
    if (validated.mode !== 'danger-full-access') {
      throw new SandboxUnavailableError(
        `sandbox-ohos: mode "${validated.mode}" cannot be enforced on HarmonyOS (no kernel confinement backend)`,
        { mode: validated.mode, hint: 'use danger-full-access for an explicit unbounded run, or accept the policy-only provider' },
      )
    }
    return this.confine(argv, validated, signal)
  }

  /**
   * Derived writable roots for one policy.
   * @param {{ mode: string, workspaceRoot: string }} policy
   * @returns {string[]}
   */
  writableRoots(policy) {
    return writableRoots(policy)
  }

  /**
   * Policy-layer write check for the fs side.
   * @param {string} path
   * @param {{ mode: string, workspaceRoot: string }} policy
   * @returns {boolean}
   */
  isPathWritable(path, policy) {
    return isPathWritable(path, policy)
  }
}

export default OhosSandboxProvider
