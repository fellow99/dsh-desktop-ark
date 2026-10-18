[English](./README.md) | 中文

# DSH Desktop · HarmonyOS Edition

> **官方 DeepSeek Harness（DSH）Web UI，零改动**，跑在鸿蒙 2in1 / 平板的系统 **ArkWeb** 里 —— 而 dsh Host 运行在**同一进程内嵌的真实 Node.js 运行时**上。不含 Electron、不打包 Chromium、不用 ArkUI 重写界面。

<p align="center">
  <img src="https://img.shields.io/badge/release-0.1.0%20scaffold-4D6BFE" alt="版本">
  <img src="https://img.shields.io/badge/dsh-dsh--v0.2.1--rc.2-7C5CFF" alt="dsh 版本">
  <img src="https://img.shields.io/badge/HarmonyOS-API%2024-0A59F7" alt="HarmonyOS API 24">
  <img src="https://img.shields.io/badge/Node-v24.2.0-5FA04E" alt="Node 24.2.0">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F" alt="MIT">
</p>

**状态** `0.1.0` —— **scaffold**（`versionCode` 100）。现在不仅能编译打包，还能**真正启动一份载荷**：`assemble-payload.mjs --deploy` 物化上游 dsh 运行树（628.6 MiB → 151 MiB，打成 **40.4 MB** 的 `dsh.tar.gz`），产出 **86 MB** 未签名 HAP，内含 Node 运行时与载荷。在宿主 Node 上，同一棵树解包约 13 s、物化 profile、启动 Host，并在 token URL 上返回零改动 dsh Web UI（**HTTP 200**），未激活的 profile 行 **0 条**。**尚未做任何鸿蒙真机验证** —— 哪些已验证、哪些没有，请逐条看[状态](#状态)。

## 两个 HarmonyOS edition

鸿蒙端有**两个独立的 DSH Desktop edition**：它们共用同一套外壳架构、同一份零改动 Web UI 与同一条数据面，差别在**由哪个运行时提供 Node**：

| | **Electron on HarmonyOS Edition**（[`dsh-desktop-hos`](../dsh-desktop-hos)） | **HarmonyOS Edition**（本仓库） |
|---|---|---|
| 渲染器 | Chromium，随 Electron 37 打包 | 系统 **ArkWeb** —— 不打包任何浏览器内核 |
| Node.js | 由 Electron 运行时提供（Node 22.17） | 应用自身进程内 `node::Start` 启动 `libnode.so`（**v24.2.0**） |
| 运行时构件 | [`harmonypc-electron`](../harmonypc-electron) | [`ohos-node-bridge`](../ohos-node-bridge) HAR |
| 上游 dsh 补丁 | 13 条（flock 与硬链接回退、`ctx.fs` remove / writeBytes / chmod、追加可写根、附件 fsync、品牌改写） | **0 条** —— `ohos` profile + `@dsh-ohos/bundle` 层 + 受审计垫片 |
| Web 服务器绑定 | `0.0.0.0:<端口>` + 局域网 IP，改写 `Host`/`Origin` | `127.0.0.1:<端口>`，同源回环 |
| 成熟度 | v0.2.1，已在 HarmonyOS 6.1.0.135（API 24）真机验证 | v0.1.0 scaffold，编译打包通过 |

两者不是替代关系：Electron edition 用「打包 Chromium + 需要 JIT」换来最大的桌面一致性；本 edition 用「小得多的载荷 + 无 JIT 运行时」换来在垫片层承担平台差异。

## 工作原理 —— 单进程、单源

```
EntryAbility (ArkTS)
  └─ libnode.so  node::Start(bootstrap.js)      ← 进程内 Node v24.2.0
       └─ 解包 resfile/dsh-payload → filesDir/payload   （标记 .ready-<sha12>）
       └─ host.js：dsh Host（webserver + apiProxy + connection）绑定 127.0.0.1:<随机端口>
       └─ ready.json { schema, at, phase, port, token }
  └─ ArkWeb: loadUrl(ctx.connection.authenticatedUrl())
       └─ 标准、零改动的 dsh Web UI（同源 HTTP + WebSocket）
```

- **载荷放在 `resfile`** —— 那是 Node 可直读的真实磁盘目录 —— 内存一个确定性 `dsh.tar.gz`。**Node 是唯一的解包者**，靠 `.ready-<sha12>` 标记做到幂等。
- **就绪 = 业务就绪。** `waitUntilRunning()` 只证明运行时线程活着，因此外壳轮询 `ready.json`（20 × 500 ms），四项同时满足才加载页面：`schema === 1`、`at` 不早于本次启动时刻、`phase` 处于终态、`token` 非空。
- **鉴权归 Host。** 页面加载 `authenticatedUrl()`（`http://127.0.0.1:<端口>/?token=…`），由 Host 自己回 `303` 并下发签名 cookie。外壳不参与鉴权、不改写 `Host` 头、不绑 `0.0.0.0`。
- **上游零改动**：平台差异只落在 `ohos` profile、`@dsh-ohos/bundle` YAML 层，以及**五条带标记的垫片**（`DSH_OHOS_SHIM fs.link | fs.symlink | flock | sharp | node:sqlite`）。上游每个工作树始终保持干净。

## 暴露给 dsh 的能力

| 能力 | 状态 |
|---|---|
| `runtime.facts`、`log.hilog`、`perm.check`、`perm.request`、`perm.openAppInfo`、`shell.openExternal` | ✅ 已实现 |
| `fs.pickFolder`、`fs.pickFiles`、`fs.saveFile`、`notify.show`、`clipboard.readImage`、`clipboard.writeText`、`image.normalize`、`power.keepAwake` | ⚠️ 占位 —— 返回 `{"ok":false,"error":"not-implemented","hint":…}` |

## 状态

| 方面 | 状态 |
|---|---|
| ArkTS 外壳、ArkWeb 宿主页、启动编排、就绪门禁、诊断 | ✅ 已实现 |
| 消费 `ohos-node-bridge` HAR、运行时投放（7 项 ELF 门禁 + SHA-256）、44 MB HAP | ✅ 已由构建验证 |
| 载荷管线（`resfile` → 自解包）、5 条垫片、自检 7/7、上游锁定校验 | ✅ 已在宿主工具链上验证；profile 改从 `<runRoot>/profiles/ohos` 载入（移出 `$DSH_HOME` 才能解析 `@dsh-ohos/*`） |
| 8 个 `@dsh-ohos/*` seam 插件 + 共享宿主桥（`packages/*-ohos/` 下 10 个包） | ✅ 已实现（**partial**：无 PTY；`notify.show` / `image.normalize` 仍为 ArkTS 占位；无可隔离执行器 ⇒ 审批预设禁用） |
| 真实 dsh 载荷装配与打包 | ✅ `--deploy`（pnpm deploy → 链接物化 → 补全 `@deepseek-ai` → 摊平非 hoisted → 剪裁 → 覆盖层 → 断言）；41 331 文件 / 628.6 MiB → **15 192 文件 / 151 MiB** → `dsh.tar.gz` **40.4 MB**（`sha12 db181e3b4364`）；HAP **86 MB** |
| 真机验证（L1–L4、ArkWeb → `127.0.0.1`、`sh` 哨兵、JIT ACL） | ⛔ 未做 —— 无设备（宿主 Node 上的端到端已通过：解包 → profile → `runProfile` → token URL `200`） |

## 仓库结构

```
dsh-desktop-ark/
├── AppScope/                  # bundle 级配置（bundleName org.fellow99.dsh.DshDesktopArk）
├── entry/
│   ├── src/main/ets/
│   │   ├── app/               # DshRuntime（启动编排）· Probe（探活）
│   │   ├── common/            # Constants —— 路径与预算的单一事实源
│   │   ├── host/              # HostCapabilities（14 项能力面）
│   │   ├── entryability/      # EntryAbility
│   │   └── pages/             # Index（ArkWeb 壳）
│   ├── src/main/resources/    # resfile/dsh-payload（构建产物，gitignored）
│   └── libs/arm64-v8a/        # 投放的 .so（二进制不入库）
├── payload/                   # bootstrap.js · host.js · lib/tar-extract.js · shims/ · selfcheck.js
├── profiles/ohos/             # dsh profile + bundle 层 + .npmrc
├── packages/bundle-ohos/      # @dsh-ohos/bundle（cordis.patch.yml）
├── scripts/                   # 7 个脚本：HAR / 运行时 / 载荷 / 构建 / 上游校验
├── specs/                     # 26 份规格文档（10 根 + 101–108 各 spec/plan）
└── docs/                      # 工程规划与排障记录
```

## 构建

前置：DevEco **Command Line Tools**（SDK API 24）、兄弟 submodule `../ohos-node-bridge` 与 `../deepseek-harness`、已就位的 Node 运行时。

```bash
# 1) bridge HAR → libs/@fellow99/node-bridge.har
bash scripts/build-bridge-har.sh

# 2) Node 运行时 → entry/libs/arm64-v8a（7 项 ELF 门禁 + SHA-256）
bash scripts/provision-runtime.sh          # 加 ALLOW_MISSING=1 可在缺运行时的情况下构建

# 3) 载荷 → entry/src/main/resources/resfile/dsh-payload
node scripts/sync-payload.mjs
node scripts/package-payload.mjs
# node scripts/assemble-payload.mjs --from <已构建的 dsh 树> --apply   # 真实载荷；默认仍为 dry-run

# 4) HAP
bash scripts/build-hap.sh                  # 加 --release 为 release 模式；产物在 entry/build/default/outputs/default/

# 可选：校验上游锁定未被破坏（tag + 8 个 patch id + 工作树干净）
node scripts/verify-upstream.mjs
```

`OHOS_CLT` 可覆盖 Command Line Tools 根目录（默认 `D:/oh-workspace/command-line-tools-6`）；`DEVECO_SDK_HOME` 可覆盖 SDK。

## 规格文档

本仓库按规格驱动：**[`specs/`](./specs/) 下共 26 份文档** —— 索引、检查清单、结构、技术选型、架构、宪法（C1–C14）、`overall-*`（规格 / 方案 / 数据模型 / 测试用例），以及每个模块一份 `spec.md` + `plan.md`（101 运行时启动编排、102 载荷管线、103 Web 宿主、104 宿主能力、105 垫片、106 profile/bundle、107 打包签名、108 诊断）。入口见 [`specs/README.md`](./specs/README.md)。

## 相关工程

- [`dsh-desktop`](../dsh-desktop) —— Windows / Linux / macOS 的 Electron 桌面壳
- [`dsh-desktop-hos`](../dsh-desktop-hos) —— **Electron on HarmonyOS Edition**（同 workspace，走 Electron 运行时）
- [`ohos-node-bridge`](../ohos-node-bridge) —— 把 Node（`node::Start`）嵌进应用的 ArkTS 库 + `runtime/` 发行缓存
- [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（同级目录 `../deepseek-harness`）—— 被封装的宿主
- [`dsh-market`](https://github.com/dsh-market/dsh-market)（同级目录 `../dsh-market`）—— 内置可视化插件市场

## 许可证

[MIT](./LICENSE)
