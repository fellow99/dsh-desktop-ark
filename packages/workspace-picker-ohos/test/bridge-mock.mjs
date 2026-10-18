/**
 * Bridge stub for the workspace-picker smoke test: permission probes must fail
 * closed (the real bridge is absent off-device).
 */

export const invocations = []

export async function invoke(name, args) {
  invocations.push({ name, args })
  throw new Error('host bridge unavailable in smoke test')
}

export const USER_CHOICE_TIMEOUT_MS = 600_000
