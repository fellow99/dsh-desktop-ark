# `@dsh-ohos/host-bridge`

共享的 **Node → ArkTS 宿主能力客户端**。不是 cordis seam 服务，不被 bundle 行加载；其余 `@dsh-ohos/*` 插件 import 它。

## 传输

文件信箱，ArkTS 侧由 `@fellow99/node-bridge` 的 `HostBridge.startMailbox()` 实现（`entry/src/main/ets/app/DshRuntime.ets:97`）：

| 方向 | 文件 | 内容 |
|---|---|---|
| 请求 | `<dir>/<id>.req`（先写 `<id>.tmp` 再 `rename`） | `{"name":"<能力名>","args":"<JSON 字符串>"}` |
| 成功 | `<dir>/<id>.done` | `{"ok":true,...能力返回值...}` |
| 失败 | `<dir>/<id>.fail` | `{"ok":false,"error":"…","hint":"…"}` |

- 目录：`process.env.DSH_OHOS_MAILBOX`（ArkTS `Constants.mailboxDir()`）。空/不存在 ⇒ 抛 `HostBridgeUnavailable`（`code: 'host-unavailable'`），**绝不假成功**。
- `id`：`<epochMs>-<seq>-<rand>`，仅 `[A-Za-z0-9-]`。
- 轮询 50 ms；默认超时 15 s（`DEFAULT_TIMEOUT_MS`），逐次可放宽（`{ timeoutMs }`）；用户选择类用 `invokeUserChoice()`（600 s）。
- **串行**：ArkTS 侧 `mailboxTick` 一次只处理一个请求（`mailboxInflight`），因此客户端把所有调用排进一条队列（模块级实例共享）。
- 响应文件读取后立即删除；`.done` 里 `ok === false` 同样按失败处理（ArkTS `mailboxSettle` 的判定口径）。
- 失败一律 `HostBridgeError`，带 `code` 与原始 `hostError` / `hint` / `detail`：
  - `host-unavailable`：目录缺失/不可写；
  - `host-timeout`：到点没有响应文件；
  - `host-rejected`：`.fail`、`ok:false`、或响应不是合法 JSON；
  - `host-aborted`：调用方 `signal` 取消（扩展码，契约只列前三种）。

## 能力名（冻结）

`runtime.facts`、`log.hilog`、`perm.check`、`perm.request`、`perm.openAppInfo`、`shell.openExternal`、`fs.pickFolder`、`fs.pickFiles`、`fs.saveFile`、`notify.show`、`clipboard.readImage`、`clipboard.writeText`、`image.normalize`、`power.keepAwake`
（`entry/src/main/ets/host/HostCapabilities.ets:104-119`）。

后 8 项目前是**占位**：返回 `{"ok":false,"error":"not-implemented","hint":…}`。调用方必须显式失败并保留原文，不允许吞掉或降级成功。

## 用法

```js
import { invoke, invokeUserChoice, isAvailable, HostBridgeError } from '@dsh-ohos/host-bridge'

const facts = await invoke('runtime.facts', {})                       // 15 s 默认
const check = await invoke('perm.check', { name: 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY' })
const picked = await invokeUserChoice('fs.pickFolder', {})            // 600 s
```

`args` 允许对象或已序列化的 JSON 字符串（后者必须能 `JSON.parse`）。`invoke` 返回完整响应体（含 `ok:true`）。

## 已知限制

- 依赖共享 `node_modules` 布局：所有 `@dsh-ohos/*` 必须被物化到同一个解析根（本包没有 `dependencies`，见工程规划 §5.2）。
- 请求在超时/取消时会尽力清理 `.req`；若 ArkTS 已把它 `rename` 成 `.wip`，迟到的 `.done` 由宿主侧 `mailboxReap`（10 min 阈值）回收。
- `payload/host.js` 尚未提供 Node 侧实现，本包就是那层缺失的客户端。
