/**
 * Bridge stub for the facts smoke test (capability list + availability probe).
 */

export const HOST_CAPABILITIES = [
  'runtime.facts',
  'log.hilog',
  'perm.check',
  'perm.request',
  'perm.openAppInfo',
  'shell.openExternal',
  'fs.pickFolder',
  'fs.pickFiles',
  'fs.saveFile',
  'notify.show',
  'clipboard.readImage',
  'clipboard.writeText',
  'image.normalize',
  'power.keepAwake',
]

export function isAvailable() {
  return false
}
