/**
 * Bridge stub for the workspace-picker smoke test.
 *
 * 真机上 `perm.check` / `perm.request` 由 ArkTS 的 `HostCapabilities` 提供；
 * 测试里用可编程状态模拟四种情形：桥不可用（fail）、已授权、拒绝、平台不受理、
 * 以及**平台完全不应答**（`authResults: []`，真机 ATM 记 "It does not need to request permission"）。
 */

export const state = {
  invocations: [],
  /** perm.check 返回的 granted */
  grantCheck: false,
  /** perm.request 返回的 authResults[0] === 0 */
  grantRequest: false,
  /** true = 抛错（模拟宿主桥不可用） */
  fail: true,
  /** true = perm.request 返回 authResult=2（平台不受理） */
  requestVoid: false,
  /** true = perm.request 返回空 authResults（平台根本没应答） */
  emptyResults: false,
}

/**
 * 替换/更新桩状态（测试用）。
 * @param {Partial<typeof state>} next
 */
export function setState(next) {
  Object.assign(state, next)
}

export const invocations = []

export async function invoke(name, args) {
  state.invocations.push({ name, args })
  invocations.push({ name, args })
  if (state.fail) throw new Error('host bridge unavailable in smoke test')
  if (name === 'perm.check') return { ok: true, granted: state.grantCheck === true, permission: args?.name ?? '' }
  if (name === 'perm.request') {
    if (state.emptyResults === true) return { ok: true, authResults: [], permissions: [], requested: 1, answered: 0 }
    if (state.requestVoid === true) return { ok: true, authResults: [2] }
    return { ok: true, authResults: [state.grantRequest === true ? 0 : -1] }
  }
  return { ok: false, error: 'unregistered' }
}

export const USER_CHOICE_TIMEOUT_MS = 600_000
