/**
 * Bridge stub for the notify smoke test.
 */

export const calls = []
export const state = { fail: undefined }

export async function invoke(name, args, options) {
  calls.push({ name, args, options })
  if (state.fail !== undefined) throw state.fail
  return { ok: true }
}
