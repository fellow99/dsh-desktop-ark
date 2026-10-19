/**
 * `@dsh-ohos/workspace-picker-client` —— 工作区选择对话框的 **Host 半边**。
 *
 * 纯 UI 插件：Host 侧没有行为，只在 Loader 里占一行，让浏览器半边
 * （`exports["./client"]` + `package.json` 的 `dsh.client`）被客户端程序发现并加载。
 * 列表/新建/权限走的是 `@dsh-ohos/workspace-picker` 注册的 `/_ohos/picker/*` 路由，
 * 本包不复制那份逻辑。
 */

/** Cordis 插件名（与 bundle 行 id 一致）。 */
export const name = 'workspace-picker-client'

/** Host 半边没有行为。 */
export function apply() {}
