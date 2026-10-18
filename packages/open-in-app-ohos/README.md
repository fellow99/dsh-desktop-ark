# `@dsh-ohos/open-in-app`

替换上游 `open-in-app` 行：函数插件 + 三条 HTTP 路由（`ctx.webServer.register`），实际打开走宿主桥 `shell.openExternal`。

## 形态（与上游同构）

`packages/host/open-in-app/src/index.ts:45-310`：

```js
export const name = 'open-in-app'
export const inject = ['webServer', 'connection']
export function apply(ctx, config) { … }
```

每条路由第一句都是 `ctx.connection.requestRejection(req)`（401/403 直接写回），与上游 `index.ts:184-191` 相同。

| 路由 | 行为 |
|---|---|
| `GET /open-in-app/apps` | `{ apps: ['system'] }` |
| `GET /open-in-app/icon/<id>` | `404 { code:'not-found' }`（HarmonyOS 没有宿主 app 图标） |
| `POST /open-in-app/open` | 校验后调桥；成功 `200 {ok:true}`，桥失败 `502 {code:'launch-failed', error, hint}` |

## 放行规则（FR-105-012）

- `path` 是 `https:` URL → 直接交给 `shell.openExternal`；
- 其它 scheme（含 `file:`、`javascript:`）→ 400；
- 绝对路径 → 必须 canonical 后落在 `DSH_OHOS_WORKSPACE` 内，且存在、是**文件**；目录当前不支持（ArkTS `openExternal` 只接受 https，见下）；
- `DSH_OHOS_WORKSPACE` 未设置时，路径目标一律 400（不猜 cwd）。

open 路由的 wire 校验顺序与上游一致：`content-type: application/json`（否则 415）→ ≤64 KiB（413）→ `app`/`path` 均 string（400）→ 目录存在（404）。

## config

接受 `{ probeTimeoutMs, iconTimeoutMs, launchWatchMs }`（与上游行同键，值校验 1..600000）。本平台没有 app 探测与图标提取，这三个值只做兼容校验、不驱动行为；`POST` 的桥超时用客户端默认 15 s。

## 现状与限制

- ArkTS 侧 `shell.openExternal` 目前只接受 `https://`（`HostCapabilities.ets:287-305`），文件 URI 会收到 `not-implemented` → 本插件如实回 502 并带上原文。等 ArkTS 接入 Want/`openLink` 文件打开后无需改本包。
- 不做 app 目录探测（上游的 Finder/Terminal/VSCode 等目录在 HarmonyOS 不存在）。
- 图标路由保留只为 wire 兼容：客户端不会拿到图标（404）。
