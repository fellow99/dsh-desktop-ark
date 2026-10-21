# @dsh-ohos/market

DSH Desktop（Ark 版）的插件市场运行时：向 `dsh-market` 提供 `desktopProfiles` / `desktopPnpm`
两个服务，让市场的插件安装/卸载在**本进程的 worker 线程**里跑随包物化的纯 JS pnpm，
不 spawn 任何 node/pnpm 子进程（应用域 spawn 会被 SIGSYS 杀死）。

对应规格：[`specs/012-pnpm-integration`](../../specs/012-pnpm-integration/spec.md)、
[`specs/201-dsh-market`](../../specs/201-dsh-market/spec.md)；设计：
[`docs/pnpm+dsh-market.md`](../../docs/pnpm+dsh-market.md)。

## 服务契约

`dsh-market` 用特性检测选择安装通道（`src/index.ts` → `ctx.get('desktopProfiles')`）：

| 服务 | 形状 | 说明 |
|---|---|---|
| `desktopProfiles` | `{ current: { name, dir }, pluginActivation }` | `dir` 只取 `ctx.get('profileContext').dir`（launcher 提供）。取不到 → 不 provide，市场回落到自己的 CLI 分支并显式失败 |
| `pluginActivation.activate()` | 返回 `{ ok: false, error }` | **本宿主不支持在线重放**：先把 `dsh.profile.bundles` 与本 profile 的依赖对账（装载时追加、卸载时移除悬空行），然后如实回答「重启后生效」。市场因此不再自己 hot-mount（真机上那条路会刷新客户端模块图，期间的子资源 404 会被外壳误当成整页失败） |
| `desktopPnpm` | `{ runPlugin(args, invokingDir, signal), probePnpm() }` | `runPlugin` 返回 `{ stdout, stderr, done, cancel }`；`args` 原样透传并追加 `--dir <profile>`；`invokingDir` 被忽略 |

并发：同一时刻只允许一次操作；第二次调用**同步抛错**，消息含
`another desktop pnpm operation is already running`（市场据此判定 `busy`）。

## 运行前提（由 Host 提供）

| 变量 | 来源 | 用途 |
|---|---|---|
| `DSH_PNPM_ENGINE` | `payload/host.js` → `<runDir>/node_modules/dsh-market-pnpm/bin/pnpm.cjs` | 引擎入口（构建期由 `collectMarketPNPM()` 物化） |
| `DSH_OHOS_JITLESS_ENTRY` | `payload/bootstrap.js` → `<assetDir>/jitless/index.js` | worker 是**新 realm**，兼容层要在里面重装 |

## 已知限制

- **安装/卸载后需重启应用生效**（见上面的 `pluginActivation`）：宿主只做持久化，不做在线重放。
- `--jitless` 下 pnpm 的解包是纯 JS，安装耗时按分钟级预算；市场侧超时 15 分钟。
- profile 位于载荷内（按 sha12 分代）⇒ **换包后已安装的插件不保留**（设计 §8 R6）。
- `ignoreScripts: true`：需要构建脚本的插件装不上；市场 UI 的「放行构建脚本并重试」在本宿主无效。
- 设备无 `git` ⇒ `git:` 源插件不可装。
- worker 起不来时**不做同线程降级**（pnpm CLI 是 fire-and-forget，同线程没有可判定的完成条件），直接 127 并记录原因。

## 诊断

- `app.log`：`[dsh-ohos] market: …`（契约是否提供、引擎路径是否可用）。
- `globalThis.__dshOhosMarket`：`{ profile, profileDir, engineEntry, engineOk, worker, workerError, lastRun }`，
  debug 构建可用 `--inspect` 读回。
- 市场自己的日志：`<profile>/.dsh-market/log.ndjson`。
