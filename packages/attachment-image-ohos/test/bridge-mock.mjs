/**
 * Bridge stub for the attachment-image smoke test.
 */

export class HostBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'HostBridgeError'
    this.code = code
    Object.assign(this, details)
  }
}

export const calls = []
export const state = { fail: undefined, response: { ok: true, data: '', format: 'webp', width: 3, height: 2 } }

export async function invoke(name, args, options) {
  calls.push({ name, args, options })
  if (state.fail !== undefined) throw state.fail
  return state.response
}
