# 012-pnpm-integration 纯 JS pnpm 集成 功能规格

> 模块：`012-pnpm-integration` · 工程 `dsh-desktop-ark` · 版本 0.2.1
> 状态：**implemented**（本迭代）
> 关联文档：
> - [`docs/pnpm+dsh-market.md`](../docs/pnpm+dsh-market.md) —— 本模块的设计与取舍（P1–P11、§3.1–§3.6）
> - [`../dsh-desktop-hos/docs/pnpm对接问题排查.md`](../../dsh-desktop-hos/docs/pnpm对接问题排查.md) —— 同源真机故障矩阵（平台根因）
> - [`201-dsh-market/spec.md`](../201-dsh-market/spec.md) —— 消费本模块的市场集成

---

## 1. 模块概述

### 1.1 目的

让设备上**在没有 pnpm 二进制、也不能 spawn 子进程**的前提下，仍能完成插件的 `add` / `remove`。

`dsh-market` 默认通过子进程调用 `pnpm`；本工程的应用域禁止这条路（`spawn` 出的 node 子进程被 seccomp 以 `SIGSYS` 杀死，见设计 §2 P1）。本模块把 pnpm 的**纯 JS CLI 引擎**随包物化，并在**同一进程的 worker 线程**里跑它，从而绕开子进程限制。

### 1.2 范围

**包含**

- pnpm 引擎的构建期物化（`pnpm@10.34.6` → `<stage>/node_modules/dsh-market-pnpm/`）、版本固定与产物断言。
- 进程内调用器：worker 线程 + 新 realm 的 jitless 兼容层安装 + `symlink→copy` 回退 + 单飞闸门 + 取消。
- 市场契约 `desktopProfiles` / `desktopPnpm` 的宿主实现（`packages/market-ohos`）。
- profile 的 pnpm 配置（运行期生成 `pnpm-workspace.yaml`，绝对 `storeDir`）。
- 运行期 env 接线（`DSH_PNPM_ENGINE`、`DSH_OHOS_JITLESS_ENTRY`）与诊断面。

**不包含**

- 修改 `dsh-market` 或 `deepseek-harness` 源码。
- 系统 pnpm / 随包 ELF / 用户目录可执行文件等路线（设计 §4.1 已否决）。
- 支持 `git:` 源插件与需要 lifecycle 构建脚本的插件（设计 R5）。
- `dshmarket` 自身的物化与 profile 声明（属 `201-dsh-market`）。

---

## 2. 用户故事

- 作为**设备用户**，我在插件市场点「安装」后插件真的出现在 profile 里，而不是转圈或报「不认识 pnpm」。
- 作为**设备用户**，安装过程中应用不崩溃、不闪退；失败时我能在市场 UI 看到可读原因。
- 作为**打包者**，pnpm 引擎随构建自动物化，版本固定并有构建期断言；缺产物时构建直接失败，不产出「能启动但装不了插件」的包。
- 作为**维护者**，我不需要改市场或上游源码就能让安装通道可用，并能从日志/诊断一眼看出「引擎是否就绪、worker 是否可用」。

---

## 3. 功能需求

### 3.1 构建期物化与版本固定

- **FR-012-001**：收集阶段 MUST 把 `pnpm@10.34.6` 整包物化到 `<stage>/node_modules/dsh-market-pnpm/`，入口为 `bin/pnpm.cjs`。
- **FR-012-002**：版本 MUST 由单一常量（`PNPM_VERSION`）固定；构建期 MUST 断言产物 `package.json.version` 与常量一致。
- **FR-012-003**：物化 MUST 幂等（目标已存在则只做断言，不重复下载）；引擎来源不可用时 MUST 硬失败。
- **FR-012-004**：断言 MUST 校验入口文件存在且非空；损坏产物不得被当作就绪。
- **FR-012-005**：物化 MUST 剪除非目标平台产物（`reflink.{darwin,win32}*`、`vendor/*.exe`、`CHANGELOG.md`）。

### 3.2 profile pnpm 配置

- **FR-012-006**：运行期 MUST 在 `<profileDir>/pnpm-workspace.yaml` 缺失时写入配置，至少含 `nodeLinker: hoisted`、`packageImportMethod: copy`、`autoInstallPeers: false`、`ignoreScripts: true`、`minimumReleaseAge: 0`、以及**绝对路径** `storeDir`。
- **FR-012-007**：`storeDir` MUST 落在应用可写沙箱内（`<profileDir>/.pnpm-store`），MUST NOT 依赖默认 `~/.pnpm-store`（设备 `cwd` 为 `/`）。
- **FR-012-008**：写入 MUST 幂等，且 MUST NOT 覆盖已存在文件（用户/市场可能已改写）。

### 3.3 进程内调用

- **FR-012-010**：系统 MUST 在**进程内 worker 线程**执行 pnpm，MUST NOT spawn 任何 node/pnpm 子进程。
- **FR-012-011**：worker MUST 在新 realm 内按需安装 jitless 兼容层（`DSH_OHOS_JITLESS_ENTRY`，仅当 `WebAssembly === undefined`），使 `node:http` 的 undici 惰性 getter 被封印。
- **FR-012-012**：worker MUST 合成自己的 `process.argv`（`[execPath, entry, ...args, '--dir', profileDir]`），MUST NOT 改动主线程 argv。
- **FR-012-013**：worker MUST 把 `process.execPath` 换成 no-op setter（pnpm 启动会赋值）。
- **FR-012-014**：worker MUST 把 `fs.symlink` / `fs.symlinkSync` 在 `EACCES/EPERM/ENOSYS/EINVAL` 时回退为复制（`.bin` 落地为真实文件）。
- **FR-012-015**：worker MUST 设置 `CI=true`（pnpm 10 无 TTY 时会停在交互提示）与 `XDG_*` 缓存目录到 `<profileDir>/.pnpm-cache`。
- **FR-012-016**：完成信号 MUST 来自 worker 退出码；MUST NOT 用「`import(entry)` 返回」当完成（pnpm CLI 是 fire-and-forget）。
- **FR-012-017**：worker 无法启动时 MUST 立即以 127 失败并记录原因；MUST NOT 退化为同线程执行（无可判定完成条件）。
- **FR-012-018**：`cancel()` 与 `AbortSignal` MUST 终止 worker，并使 `done` 以非零结束、stderr 说明「已取消」。
- **FR-012-019**：同一时刻只允许一个操作；已有操作在跑时 MUST **同步抛错**，错误消息含 `another desktop pnpm operation is already running`（市场据此判定 busy）。

### 3.4 市场契约对接（desktopProfiles / desktopPnpm）

- **FR-012-020**：系统 MUST 在市场 bundle mount **之前** `ctx.provide('desktopProfiles', { current: { name, dir } })`，`dir` **只**取自 `profileContext.dir`（绝对路径且存在）。
- **FR-012-021**：系统 MUST `ctx.provide('desktopPnpm', { runPlugin })`，`runPlugin(args, invokingDir, signal)` 返回 `{ stdout, stderr, done, cancel }`。
- **FR-012-022**：`dir` 不可用时 MUST NOT provide，并 MUST 打印一行可归因的错误日志（不静默）。
- **FR-012-023**：`args` MUST 原样透传（市场会送 `add -w <target>`、`remove <name>`、`install --no-frozen-lockfile`、`update` 及 `--reporter=ndjson` / `--config.*` / `--force`）；宿主只追加 `--dir <profileDir>`，MUST NOT 采信 `invokingDir`。
- **FR-012-024**：引擎未就绪时 `runPlugin` MUST 返回 127 句柄，stderr 点名 `DSH_PNPM_ENGINE` 期望路径。

### 3.5 失败可见性与诊断

- **FR-012-030**：关键事件与失败 MUST 以 `[dsh-ohos]` 前缀写入 `app.log`，禁止静默降级。
- **FR-012-031**：系统 MUST 在启动时做一次 worker 能力探针（2 s 预算），结果进日志与诊断对象。
- **FR-012-032**：系统 MUST 暴露 `globalThis.__dshOhosMarket = { profile, profileDir, engineEntry, engineOk, worker, workerError, lastRun }` 供 `--inspect` 读回。

### 3.6 幂等与安全

- **FR-012-040**：运行期接线 MUST 幂等；除构建期断言外，运行期失败 MUST NOT 阻塞 Host 启动。
- **FR-012-041**：本模块 MUST NOT 扩大权限面（零新增受限权限 / ACL）。
- **FR-012-042**：安装 MUST 关闭 lifecycle 脚本（`ignoreScripts`），MUST NOT 执行插件作者代码。
- **FR-012-043**：构建期 MUST 把 `dshmarket/node_modules/undici` 替换为纯 JS 替身（`payload/shims/undici`，复用 109 的 `fetch-shim`）：市场直接 `import { fetch } from 'undici'`，`--jitless` 下原包每次请求都抛 `WebAssembly is not defined`。断言 MUST 校验替身标记（`dshOhosShim: pure-js-undici`）。

---

## 4. 关键实体

| 实体 | 描述 | 关键属性 |
|---|---|---|
| pnpm 引擎产物 | 随包物化的纯 JS pnpm CLI | `<runRoot>/node_modules/dsh-market-pnpm/bin/pnpm.cjs`；版本 `10.34.6` |
| `desktopProfiles` 服务 | 市场特性检测的入口 | `current.name = 'ohos'`、`current.dir = <runRoot>/profiles/ohos` |
| `desktopPnpm` 服务 | 进程内包管理器 | `runPlugin(args, invokingDir, signal)` → `{stdout, stderr, done, cancel}` |
| 操作句柄 | 一次 pnpm 操作 | `done` 解析 `{ exitCode, signal }`；`cancel()` |
| 诊断对象 | `--inspect` 可读 | `__dshOhosMarket` |

---

## 5. 验收场景

- **引擎随包就位**：Given `../dsh-market` 可用；When 执行 `assemble-payload.mjs --apply`；Then `<stage>/node_modules/dsh-market-pnpm/bin/pnpm.cjs` 存在且非空，版本为 `10.34.6`。
- **引擎缺失硬失败**：Given 引擎无法获取；When 装配到物化步骤；Then 明确报错并退出码 1，不产出残缺 stage。
- **配置就位**：Given Host 启动；When 检查 `<profileDir>/pnpm-workspace.yaml`；Then 含 `nodeLinker: hoisted`、`autoInstallPeers: false`、`packageImportMethod: copy`、`ignoreScripts: true`、绝对 `storeDir`。
- **进程内安装**：Given 应用运行、市场打开；When 安装一个纯 npm 插件；Then profile 的 `node_modules/<pkg>/package.json` 出现，无 node/pnpm 子进程。
- **worker 不可用如实失败**：Given worker 无法启动；When 触发安装；Then 立即 127 + 可读 stderr，主进程不崩、不做同线程执行。
- **取消**：Given 安装进行中；When 市场取消；Then worker 被终止，`done` 非零且 stderr 说明已取消。
- **并发**：Given 一次安装进行中；When 再发起一次；Then 同步抛错（market 判定 busy），不发生两次并发写。
- **契约缺失**：Given `profileContext` 不可用；When 插件 apply；Then 不 provide 服务并打印错误日志（设置页市场入口存在但安装会显式失败）。

---

## 6. 非功能需求

- **幂等**：物化、配置写入、`apply()` 均可重复执行。
- **健壮性**：构建期缺产物硬失败；运行期失败不阻塞启动；安装失败不破坏 profile 的可启动性。
- **性能**：引擎惰性使用（worker 只在首次安装时启动）；启动探针 ≤ 2 s。
- **安全**：零新增权限；`ignoreScripts`；安装目录固定为 profile。
- **体积**：引擎 ≈ 21 MiB（剪枝后）。

---

## 7. 假设与约束

- 设备 `worker_threads.Worker` 可用（`../ohos-node-bridge/docs/001-能力矩阵.md` #7 探针 `worker_threads=true`）；真实安装路径仍以真机结果为准（设计 R2）。
- pnpm 10 的网络栈走 `make-fetch-happen → minipass-fetch → node:http`（设计 P11），因此 worker 只需封印 `node:http` 的 lazy undici getter。
- 设备无 `git`、无编译器 ⇒ `git:` 源与需构建脚本的插件不可装。
- `profileContext.dir` 由 `profileBoot.runProfile({ profile: 'ohos' })` 提供，指向 `<runRoot>/profiles/ohos`。

---

## 8. 依赖

**上游**：`pnpm@10.34.6`（纯 JS CLI）；`deepseek-harness` 的 `profileContext` 服务与 profile 解析契约（只读，不改）。

**工程内**：`102-payload-pipeline`（物化落点）、`109-jitless`（兼容层入口）、`201-dsh-market`（消费方）。
