# 技术选型（TECH.md）

> 工程：`dsh-desktop-ark`
> 版本：v0.1（`000-scaffold`）
> 来源：`docs/000-工程规划.md` §2、§3、§7；本文件只记录**已确定**的选型与其理由。

---

## 1. 运行时与技术栈

| 类别 | 技术 | 版本（锁定值） | 用途 | 理由 / 约束 |
|---|---|---|---|---|
| 宿主语言（UI 层） | ArkTS / ArkUI（Stage 模型） | 随 SDK | 窗口、Web 容器、系统能力 | 鸿蒙唯一一等公民 UI 栈 |
| 渲染容器 | ArkWeb（系统 Chromium） | 随系统 | 加载 dsh Web 前端 | 100% 复用上游 UI；不打包 Chromium |
| Node 运行时 | `@fellow99/node-runtime`（ohpm）内嵌 `libnode.so` | Node **v24.2.0**（`NODE_MODULE_VERSION 137`） | 跑 dsh Host | 满足 dsh `engines.node ^22.19.0 \|\| >=24.0.0`；含 `node:zlib` zstd |

| NAPI 引导件 | `libnode_bridge.so`（随 `@fellow99/node-bridge` 包） | 0.1.0（ohpm） | `dlopen` + `node::Start` | 七项 ELF 门禁在上游发布流水线执行，SHA-256 锁定 |

| 上游产品 | `deepseek-harness` | tag **`dsh-v0.2.1-rc.2`**（`@deepseek-ai/dsh` 0.2.1-rc.2） | Host、Web 前端、profile/bundle 机制 | 唯一上游；零源码补丁为目标 |
| 构建系统 | hvigor（CLT） | 6.1.1.280 | HAP 构建 | 与 DevEco 同一套 |
| SDK | HarmonyOS SDK | API **24**（6.1.1.125） | 编译/打包 | `compatibleSdkVersion 5.0.5(17)`、`targetSdkVersion 6.1.1(24)` |
| 包管理（HarmonyOS） | ohpm | 随 CLT | 中心仓依赖 | 消费 `@fellow99/node-bridge` + `@fellow99/node-runtime`（OpenHarmony 三方库中心仓） |

| 包管理（Node 侧） | pnpm（纯 JS，随载荷） | 10.34.6 | 运行时插件安装 | `node-linker=hoisted` + `package-import-method=copy`（无 symlink/hardlink） |
| 构建脚本 | Node ESM（`.mjs`） | 系统 Node ≥ 18 | 载荷装配/裁剪/打包 | 不引入构建期 npm 依赖 |
| 存储 | dsh `storage-json` + 会话 JSONL/zstd | 上游 | 会话与 KV | 默认后端，无原生依赖 |
| 全文搜索 | `node:sqlite`（首选） / better-sqlite3（兜底） | 内置 / ABI 137 自建 | `session-query-sqlite` | 取决于门禁 G2/G9 |
| 图像处理 | 纯 JS 头解析 + ArkTS `@kit.ImageKit` 桥 | — | 附件规范化/缩略图 | 无 libvips；`sharp` 由替身包顶替 |
| 工具体系 | dsh seam 插件（`@dsh-ohos/*`） | — | shell/subprocess/sandbox/picker 等 | 上游官方扩展点 |

---

## 2. 关键平台 API

| API / Kit | 用途 | 使用位置 |
|---|---|---|
| `@kit.AbilityKit`（`UIAbility`、`Want`、`abilityAccessCtrl`） | 应用生命周期、权限、拉起系统能力 | `EntryAbility`、`HostCapabilities` |
| `@kit.ArkWeb`（`Web`、`WebviewController`） | 渲染 dsh Web UI | `pages/Index.ets` |
| `@kit.ArkUI`（`window`） | 窗口与沉浸式 | `EntryAbility`、`Index` |
| `@kit.CoreFileKit`（`fileIo`、`picker`） | 读写 `ready.json`/日志、目录选择 | `DshRuntime`、`HostCapabilities` |
| `@kit.NetworkKit`（`http`） | 就绪探活 | `app/Probe.ets` |
| `@kit.NotificationKit` | 通知 | 规划：`101`/`104` |
| `@kit.PerformanceAnalysisKit`（`hilog`） | 现场日志 | 全局 |
| `@kit.BasicServicesKit`（`BusinessError`、`pasteboard`） | 错误类型、剪贴板 | 全局 / 规划 |
| `@kit.ImageKit` | 图像解码/缩放/编码 | 规划：`104`/图像桥 |

---

## 3. 依赖与来源（不可入库的二进制）

| 产物 | 来源 | 获取方式 | 校验 |
|---|---|---|---|
| `libnode.so`（126,809,264 B） | ohpm 包 `@fellow99/node-runtime@24.2.0`（构建源 `electerm/ohos-node-shared` v24.2.0） | `ohpm install`；`assembleHap` 时由 HAR 合入 HAP | SHA-256 对账 `runtime.lock.json`（随 `@fellow99/node-bridge` rawfile 分发；七项 ELF 门禁在上游发布流水线执行） |
| `libc++_shared.so` | OHOS SDK 产物，随两包分发 | `ohpm install` | HAP 内按路径去重，仅保留一份 |
| `@fellow99/node-bridge`（API + NAPI 引导件） | ohpm 中心仓 `0.1.0` | `ohpm install` | 版本锁定在 `oh-package.json5` / `oh-package-lock.json5` |

| `dsh.tar.gz`（载荷） | 本仓库装配 | `scripts/assemble-payload.mjs` | `dsh.version` 首行 sha256 |
| `better_sqlite3.node` | 本仓库交叉编译（仅 G2 未过） | `scripts/build-better-sqlite3.sh` | ELF/ABI 门禁 + `process.dlopen` 冒烟 |

---

## 4. 明确否决的选型

| 选项 | 否决理由 |
|---|---|
| Electron / `harmonypc-electron` | 需要 `ALLOW_WRITABLE_CODE_MEMORY` 之外的 172 MB Chromium；HAP 体积与合规成本高；已有 `dsh-desktop-hos` 覆盖该路线 |
| ArkUI 原生聊天界面 | 必须跟随上游前端演进，重写等于永久分叉 |
| fork `deepseek-harness` | 上游 rc 迭代快，fork 等于放弃升级 |
| 随包 Node / pnpm / Python 二进制并在应用域 `spawn` | 应用域 `execve` 对随包 ELF 全 EACCES（无二进制证书）；且子进程 JIT 被 seccomp 拒绝 |
| `node-pty` / landlock / `sharp` 原生 | 无 aarch64-ohos 产物；PTY 被 SELinux 拒绝 |
| 自建 Node 交叉编译链 | 成本高；`ohos-node-shared` 产物已通过真机验证 |

---

## 5. 版本策略

- 上游 tag 与运行时版本**成对锁定**：`dsh-v0.2.1-rc.2` + `Node v24.2.0`。
- 升级 = 改两处版本号 + 重跑产物管线 + 全量回归（`scripts/verify-upstream.mjs` 做契约断言）。
- 应用版本：`versionCode = major*10000 + minor*100 + patch`；两条发行线（`standard` / `jitless`）各自单调递增。
- 模块 `oh-package.json5` 的 `version` 固定 `1.0.0`（SemVer 校验要求 ≥1.0.0，与应用对外版本无关）。
