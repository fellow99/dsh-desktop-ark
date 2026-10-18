# `@dsh-ohos/notify`

系统通知插件（新增，不是替换）：监听 `agent/status` 与 `approval/request`，经宿主桥 `notify.show` 通知用户。

## 为什么是事件监听

上游**没有通知服务**（无 `ctx.notify` / `ctx.notifications`；唯一的 OS `Notification` 在 Electron 外壳里，插件层不可复用——报告 B.6:378-409）。因此本插件直接挂事件：

| 事件 | 形态 | 本插件行为 |
|---|---|---|
| `agent/status` | emit | 记录每个会话的 `running → idle` 跳变（“回合完成”），触发一次通知 |
| `approval/request` | **waterfall** | 发通知后 **必定 `return next()`**：绝不替用户作答，否则等于静默批准 |

## 桥与失败策略

`invoke('notify.show', { title, body, sessionId, kind }, { timeoutMs: 5000 })`

通知不是关键路径：桥不可用、`not-implemented`、超时都只写日志（`ctx.logger('notify-ohos').warn`，退化到 `console.error`），**不抛给 turn**。

## 节流 / 去重 / 前台

- `throttleMs`（默认 30 s）：同一会话任意两次通知的最小间隔；
- `dedupeMs`（默认 120 s）：同一 `(kind, session)` 的去重窗口；
- 前台不打扰：`process.env.DSH_OHOS_FOREGROUND === '1'` 时整体跳过（ArkTS 壳在页面可见时导出该变量）；
- 正文只含会话 id 前 8 位与工具名，不含消息内容（避免锁屏泄露）。

## 配置（可选）

| 键 | 默认 |
|---|---|
| `throttleMs` | `30000` |
| `dedupeMs` | `120000` |

bundle 行 `notify-ohos` 不带 config，使用默认值。

## 现状与限制

- `notify.show` 在 ArkTS 侧仍是占位（`HostCapabilities.ets:115` 返回 `not-implemented`）⇒ 当前**不会真的弹通知**，只会在日志里留下失败原因。接入 `@kit.NotificationKit` 后无需改本包。
- “点击通知回前台”需要 ArkTS 侧 WantAgent 配置，不在本包范围。
- 不监听 `agent/error` / `agent/turn-stopping`：只在“完成”和“等待授权”两个用户可行动点打扰。
