# pnpm 集成与插件市场（012-pnpm-integration / 201-dsh-market）设计

**工程：** `dsh-desktop-ark` · 版本 0.2.1（versionCode 201）
**上游基线：** `deepseek-harness` `dsh-v0.2.1-rc.2` ｜ 运行时 Node **v24.2.0**（`ohos-node-bridge` HAR，进程内 `libnode.so`）
**市场基线：** `dsh-market`（`../dsh-market`）**1.66.42** ｜ **pnpm 引擎基线：** `pnpm@10.34.6`
**同源实现：** `../dsh-desktop-hos`（Electron 版，已真机验收）
- `../dsh-desktop-hos/docs/012-pnpm+dsh-market.md`（方案与决策过程）
- `../dsh-desktop-hos/docs/pnpm对接问题排查.md`（真机故障矩阵）
- `../dsh-desktop-hos/specs/012-pnpm-integration/`、`../dsh-desktop-hos/specs/201-dsh-market/`

**状态：** 设计 v2（已按设计评审 R1 修订：删除同线程降级、去掉 profile `dependencies.dshmarket`、worker 内装 jitless 兼容层、`autoInstallPeers:false`、`storeDir` 运行期绝对路径、busy 改同步抛错、只认 `profileContext.dir`）

---

## 1. 结论先行

本工程要交付两件互相咬合的能力：

| 需求 | 一句话 | 交付物 |
|---|---|---|
| `012-pnpm-integration` | 让设备上**没有 pnpm 二进制也能装 npm 包** | 随包物化的纯 JS pnpm 引擎 + 进程内（worker 线程）调用器 |
| `201-dsh-market` | 让设置页出现**插件市场**，且「安装 / 卸载」真的生效 | `dshmarket` 物化进载荷 + profile 声明 + 宿主 `desktopProfiles` / `desktopPnpm` 契约 |

一句话架构：**构建期把 pnpm 与 dshmarket 装进载荷；运行期由 `@dsh-ohos/market` 一行插件在同一进程的 worker 线程里跑 pnpm，满足市场已内置的 `desktopProfiles` / `desktopPnpm` 特性检测**。不 spawn 子进程、不建符号链接、不改 `dsh-market` 与 `deepseek-harness` 的源码。

---

## 2. 平台事实与约束

| # | 事实 | 证据 | 对本设计的影响 |
|---|---|---|---|
| P1 | 应用域 fork 出的 node/pnpm 子进程被 seccomp 以 `SIGSYS` 杀死 | 同源真机矩阵 `pnpm对接问题排查.md` §6 | 安装通道**禁止 spawn**；只能进程内跑 JS |
| P2 | HAP 内没有 `node` 可执行文件；`process.execPath` = `/system/bin/appspawn` | 同源记录；本工程 `payload/bootstrap.js` 亦不依赖 execPath | 不能走「系统 node + pnpm CLI」路线 |
| P3 | 应用沙箱禁止 `symlink` / `hardlink`（EACCES/13900012） | 本工程已有垫片 `payload/shims/fs-symlink.js`、`fs-link.js` | pnpm 必须 `nodeLinker=hoisted` + `packageImportMethod=copy`；`node_modules/.bin` 的 symlink 要就地回退为复制 |
| P4 | 宿主 Node 跑在**进程内 detached 线程**，`node::Start` 每进程一次，不可重启 | `specs/ARCHITECTURE.md` §3 | pnpm 的 `process.exit` 若在主线程调用会**杀掉整个应用** ⇒ 只能在 worker 里跑（§3.4） |
| P5 | `worker_threads` 的 `Worker` 在设备上存在（库探针 `worker_threads=true`） | `../ohos-node-bridge/docs/001-能力矩阵.md` #7 | 主路线可用；启动即探针取证（§3.6） |
| P6 | 设备无 `git` 二进制 | `docs/鸿蒙环境能力清单-0.2.1.md` | 市场里 `git:` 源插件不可安装；须在文档披露 |
| P7 | 载荷按 sha256 前 12 位分代解包：`<filesDir>/payload/<sha12>/dsh` | `payload/bootstrap.js` `resolveRunRoot()` | **profile 在载荷内** ⇒ 装进 profile 的插件属于「本代载荷」，换包即失效（§8 L1） |
| P8 | 本工程 profile 固定 `<runRoot>/profiles/ohos`，bundle 解析第一锚点是 `<runRoot>/node_modules/@deepseek-ai/dsh/package.json` | `profile.ts:714-725`、`payload/host.js` | dshmarket 物化到 `<runRoot>/node_modules/dshmarket` 即可被命中；**不需要**像 hos 那样复制到 `$DSH_HOME`（§4.9） |
| P9 | `node:sqlite` 在本工程可用（含 FTS5） | `payload/shims/sqlite.js`、`specs/109-jitless/spec.md` | pnpm 11 的 store 理论上可用；本期仍沿用同源已验收的 pnpm 10（§4.2） |
| P10 | 运行时形态固定 `compat`（`--jitless`）⇒ `WebAssembly === undefined`，且**每个 realm 各有一份全局** | `payload/jitless/index.js` 头部注释、`docs/109-jitless-方案决策.md` | worker 是**新 realm**，兼容层与垫片必须重装（§3.3）；安装耗时按分钟级预算（R2） |
| P11 | pnpm 10 的网络栈是 `make-fetch-happen` → `minipass-fetch` → `node:http/https`（**待真机取证**：`grep -c "make-fetch-happen" <引擎>/dist/pnpm.cjs`） | 构建机实测 `pnpm/dist/node_modules` 含 `make-fetch-happen`/`minipass-fetch`，无 `undici` | worker 装整层兼容层（封印 `node:http` lazy getter + 纯 JS `fetch`）；pnpm 不用 global fetch，二者不冲突 |
| P12 | `dsh-market` 直接 `import { Agent, EnvHttpProxyAgent, fetch } from 'undici'`（`src/net.ts:33`），undici 的 HTTP 解析器是 WASM 版 llhttp | 本机 `node --jitless` 实测：import undici 后 fetch 抛 `WebAssembly is not defined`；全局 fetch 垫片拦不到模块级 import | 构建期把 `dshmarket/node_modules/undici` 换成纯 JS 替身（`payload/shims/undici`，复用 109 的 `fetch-shim`）；**语义损失**：代理/HTTP2/连接池不支持（R9） |

---

## 3. 方案

### 3.1 构建期物化（两条 collect，落在 `scripts/assemble-payload.mjs`）

**前置**：`../dsh-market` 必须已构建出 `lib/index.js` 与 `client/client.js`（`npm run build`）。缺失时硬失败，并给出下一步命令 `cd ../dsh-market && npm i && npm run build`。

**A. pnpm 引擎 → `<stage>/node_modules/dsh-market-pnpm/`**

- 常量 `PNPM_VERSION = '10.34.6'`（唯一可改点）。
- 在 `build/payload-stage/.work/pnpm-engine` 写最小 `package.json`，执行
  `pnpm add pnpm@10.34.6 --config.node-linker=hoisted --ignore-scripts`。
- 把 `node_modules/pnpm` **整包**复制到 `<stage>/node_modules/dsh-market-pnpm`（独立目录名，避免与将来 `dsh plugin` 路径或载荷顶层同名包耦合）。
- `prunePnpmEngine()`：删 `dist/reflink.{darwin,win32}*`、`dist/node_modules/@reflink/reflink-{darwin,win32}-*`、`dist/vendor/*.exe`、`CHANGELOG.md`。
- `assertPnpmEngineArtifact()`：`package.json.version === PNPM_VERSION`、`bin/pnpm.cjs` 存在且非空。
- 幂等：目标已存在则走断言快路径（不重复下载）。`--fresh`/`--from` 会清 `.work`，此时重下一次（实测约 1.6 s / 21 MiB）。
- 失败一律 `throw`，由调用点转 `fail(1, …)`，保证 staging 被 `finally` 清理。

**B. dshmarket → `<stage>/node_modules/dshmarket/`**

- 常量 `DSH_MARKET_VERSION = '1.66.42'`。
- 源：`../dsh-market`。缺 `package.json` / `lib/index.js` / `client/client.js` ⇒ 硬失败（退出码 1）。
- 复制白名单：`package.json`、`cordis.patch.yml`、`lib/`、`client/`（排除 `src/`、`tests/`、`scripts/`、`site/`、`locale/`、`assets/`、`tsconfig*`、`node_modules/`）。
- 运行时依赖闭包：从 `dsh-market/node_modules` 递归复制 `dependencies` 与传递依赖到 `dshmarket/node_modules`；**`@deepseek-ai/*` 不复制**（从载荷宿主闭包解析）。
- `assertDshMarketArtifact()`：
  1. 版本 === `DSH_MARKET_VERSION`；
  2. `lib/index.js`、`client/client.js`、`cordis.patch.yml` 存在且非空；
  3. **闭包级断言**：从 `dependencies` 起逐层解析每个名字到 `dshmarket/node_modules/<name>/package.json`（`@deepseek-ai/*` 除外），缺一个即失败；**加载冒烟**（`import('<stage>/node_modules/dshmarket/lib/index.js')`）延后到 §8 的 Host 冒烟里做，不在构建脚本内跑（避免把上游 ESM/hook 依赖带进装配阶段）；
  4. 目录内不出现 `@deepseek-ai`。
- 顺序：`collectOhosPackages()` 之后、`assertStage()` 之前（与 `collectGitRuntime()` 同段）；两者不参与上游剪裁规则。

**体积预算**：pnpm 引擎 ≈ 21 MiB、dshmarket + 依赖 ≈ 2 MiB。HAP 增量按 §8 R3 记录实测值。

### 3.2 profile 声明与 pnpm 配置

`profiles/ohos/package.json`：**只加 bundle，不加 `dependencies`**。

```json
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@dsh-ohos/bundle",
    "dshmarket"
  ] } }
}
```

- `dshmarket` 排在 `@dsh-ohos/bundle` **之后**：`desktopProfiles` / `desktopPnpm` 由 `@dsh-ohos/market` 行在更早的层提供，市场 mount 时 `ctx.get()` 能命中。
- **不写 `dependencies.dshmarket`**：pnpm 在任意 `add` 前会重解析 importer 的全部直接依赖（`dsh-market/src/pnpm-compat.ts:549-554` 记的就是这个坑），声明一个不在 profile 内的包会让「装第一个插件」同时去 registry 拉一份市场，registry 不可达时首个插件必然失败，且装成后 profile 出现第二份市场、`installedProfilePackageNames` 的解析优先级也随之改变。bundle 解析走第一锚点，不依赖该字段。
- 市场行**不注入 config**：`desktopProfiles` 分支里 profile 名取自 `current.name`、`allowRestart` 硬编码 `false`（`dsh-market/src/index.ts:335-357`）；注入 `profile:` 会把它推进官方 Electron 分支（`index.ts:247-258`）→ `pluginManager` → spawn，正是要绕开的坑。

**`pnpm-workspace.yaml`（运行期生成，不随包）**

`payload/host.js` 在 `runProfile()` 之前写 `<profileDir>/pnpm-workspace.yaml`（**仅当缺失**）：

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
packageImportMethod: copy
ignoreScripts: true
minimumReleaseAge: 0
storeDir: <profileDir>/.pnpm-store   # 绝对路径，运行期拼
```

- `autoInstallPeers: false`：上游 `initProfile` 的模板同样这么写（`profile.ts:247-253`），语义是「缺 peer 时走 dsh 的运行时解析，所有插件共用安装里那一份 cordis」。缺了它 pnpm 10 默认 `auto-install-peers=true`，装插件时会去 registry 拉 `@deepseek-ai/*` 宿主 peer。
- `storeDir` **必须是绝对路径**：设备上 `process.cwd()` 是 `/`，相对路径会解析到沙箱外（同源排查文档 §11 已记）。因此该文件不能构建期写死，只能运行期生成。
- `ignoreScripts: true`：平台无编译器且不允许 spawn；同时是安全属性（不执行插件作者代码）。副作用见 R5。
- 保留既有 `profiles/ohos/.npmrc`（npm 语义兜底）；pnpm ≥10 只从它读 auth/registry，其余设置以 `pnpm-workspace.yaml` 为准。

### 3.3 契约实现：`@dsh-ohos/market`（新包 `packages/market-ohos`）

**宿主面（`lib/index.js`，命名导出 `name` / `apply`）**：

1. **只认** `ctx.get('profileContext')` 的 `name` / `dir`（`ProfileContext` 定义见 `packages/boot/app-boot/src/profile-context.ts`）。`dir` 不是绝对路径、或不存在 ⇒ 打一行错误日志并**不 provide**（市场随即走普通 CLI 分支并显式失败，不静默）。
   *不做 `DSH_HOME` 回落*：本工程没有 `DSH_PROFILE_NAME`，回落只会拼出一个不存在的目录，让 pnpm 在空目录里「装成功」。
2. `ctx.provide('desktopProfiles', { current: { name, dir } })`。
3. `ctx.provide('desktopPnpm', { runPlugin, probePnpm })`。

**`runPlugin(args, invokingDir, signal)` 的实际契约**（本宿主只被市场通过 `createDesktopPluginRuntime` 使用，`dsh-market/src/dsh-cli.ts:1341-1510`）：

| 项 | 要求 |
|---|---|
| 返回 | `{ stdout, stderr, done, cancel }`：`stdout`/`stderr` 是可读流，`done` 解析 `{ exitCode, signal }`，`cancel()` 终止本次操作 |
| `args` | 原样透传后追加 `--dir <profileDir>`。实际会出现的形态：`['add','-w',target]`、`['remove',name]`、`['install','--no-frozen-lockfile']`、`['update',…]`，以及装饰参数 `--reporter=ndjson`、`--config.minimum-release-age=0`、`--config.auto-install-peers=false`、`--config.fetchTimeout=600000`、`--force`。**不做白名单过滤**（市场已用 `TARGET_RE` 校验过目标） |
| `invokingDir` | 忽略；profile 目录是唯一权威（市场传入的 `--dir` 不被采信，见 R7） |
| 并发 | **同步抛错**，消息含 `another desktop pnpm operation is already running`（市场用正则判定 `busy`，`dsh-cli.ts:1395-1405`；返回 handle 只会变成普通失败 502）。纵深防御：市场自身已有 mutation 锁 |
| 引擎未就绪 | 返回句柄，`done` 解析为 127 且 stderr 点名期望路径（`DSH_PNPM_ENGINE` 与实际值） |
| 其余契约成员 | `probePnpm` / `provisionPnpm` / `acceptsMarketPnpmFlags` 在 `desktopProfiles` 分支**不会被读**（`createDesktopPluginRuntime` 自带 `probePnpm: () => true`）。本实现只额外提供 `probePnpm`（引擎是否就绪）供诊断，其余不实现 |

**进程内调用器（`lib/pnpm-inprocess.js` + `lib/pnpm-worker.mjs`）**：

```
runPlugin(args)
  ├ 单飞闸门：已有操作在跑 → throw new Error('another desktop pnpm operation is already running')
  ├ 引擎不可用 → 127 handle（stderr 点名 DSH_PNPM_ENGINE）
  └ new Worker(pnpm-worker.mjs, { workerData: { entry, args: [...args, '--dir', dir] } })
        ├ new realm！先按需安装 jitless 兼容层（DSH_OHOS_JITLESS_ENTRY，见下）
        ├ process.execPath 换成 no-op setter（pnpm 启动会赋值；只读会抛）
        ├ process.argv = [execPath, entry, ...args]
        ├ env: CI=true（pnpm 10 在无 TTY 时会停在交互提示，市场 spawn 分支同样设它）
        ├ env: XDG_CACHE_HOME / XDG_DATA_HOME / XDG_STATE_HOME = <profile>/.pnpm-cache
        ├ fs.symlink* 在 EACCES/EPERM/ENOSYS/EINVAL 时回退为 copy（P3）
        ├ stdout/stderr tee → postMessage；父侧写 PassThrough
        └ await import(entry) → 掉出末尾，等 pnpm 自身 pending 任务排空后 worker 以 pnpm 退出码结束
```

- **新 realm 的兼容层**：worker 用 `createRequire` 载入 `process.env.DSH_OHOS_JITLESS_ENTRY`（由 `payload/bootstrap.js` 在装完主线程兼容层后设置为 `<assetDir>/jitless/index.js`）并调用 `installIfNeeded()`。理由：`--jitless` 是进程级 V8 开关，worker 里同样 `WebAssembly === undefined`，而 `node:http` 的 lazy undici getter 每个 realm 各一份（P10/P11）。WASM 可用时 `installIfNeeded()` 一个动作都不做（jit 形态零改动）。
- **完成信号** = worker `exit` 码。**没有同线程降级**：`new Worker` 抛错即 127（原因见 §4.4）。
- `cancel()` / `signal` abort ⇒ `worker.terminate()`；父侧据此把 `done` 收敛为非零退出码，并在 stderr 补一行「已取消」（worker 被 terminate 后已无机会写）。
- 超时不在本层：市场侧 15 分钟到点 abort + `handle.cancel()`。
- `done` 结束后释放单飞闸门、写 `lastRun` 诊断。

### 3.4 worker 不可用时如实失败（不做同线程降级）

pnpm 的 CLI 是 fire-and-forget：`import(entry)` 在安装真正完成前早就 resolve，成功路径根本不调 `process.exit`（同源 worker 头注释即为此）。同线程执行没有可判定的完成条件，只会有两种坏结局：把半个安装报成成功（市场立刻 hot mount）、或永远挂住。因此：

- `new Worker(...)` 抛错 ⇒ `done` 立刻 127 + 明确文案，`globalThis.__dshOhosMarket.workerError` 记录原因。
- 启动时做一次 worker 能力探针（`new Worker('postMessage(1)', { eval: true })`，2 s 预算；`eval: true` 时首参是**脚本源码**，不能传 data URL），结果写进日志与诊断对象。探针失败不影响启动，只让失败**可归因**。

### 3.5 运行期接线（`payload/bootstrap.js` / `payload/host.js`）

`runProfile()` **之前**按序执行（幂等；除 §3.1 的构建期断言外，运行期失败只记日志不阻塞启动）：

1. `process.env.DSH_OHOS_JITLESS_ENTRY = <assetDir>/jitless/index.js`（`bootstrap.js` 已有 `ASSET_DIR`）。
2. `process.env.DSH_PNPM_ENGINE = <runRoot>/node_modules/dsh-market-pnpm/bin/pnpm.cjs`（`host.js`）。
3. `ensureProfilePnpmConfig(profileDir)`：缺 `pnpm-workspace.yaml` 才写（§3.2 内容，`storeDir` 绝对路径）；并 `mkdir` `<profileDir>/.pnpm-store`、`<profileDir>/.pnpm-cache`。
4. `profileContext` 由 `profileBoot.runProfile({ profile: 'ohos' })` 提供，本层不注入。

**与 hos 的差异（P8）**：本工程**不需要**把 `dshmarket` 复制到 `$DSH_HOME/profiles/node_modules`。bundle 解析第一锚点是 `installAnchor`；client 模块扫描按「row 的模块位置」定位 `package.json`（`packages/client/modules/src/index.ts` `resolveMeta`/`locatePkgJson`），都以载荷为锚点。

### 3.6 诊断面

- 启动日志（`app.log`，前缀 `[dsh-ohos]`）：
  `market: desktopProfiles/desktopPnpm provided (profile=ohos dir=… engine=… engineOk=true worker=ok)`。
- `globalThis.__dshOhosMarket = { profile, profileDir, engineEntry, engineOk, worker, workerError, lastRun: { args, exitCode, at } }`，供 `--inspect`（CDP `Runtime.evaluate`）读回；debug 构建 `INSPECT_PORT=19229`（`BuildConfig.ets`）。
- 市场自己的日志：`<profileDir>/.dsh-market/log.ndjson`（`event:install` / `hot-mount`）。

---

## 4. 关键取舍（含否决项）

| # | 议题 | 采用 | 否决与理由 |
|---|---|---|---|
| 4.1 | 执行形态 | **进程内 worker 线程** | spawn 系统 node/pnpm（P1 SIGSYS）否；打包 ELF（需 AGC 二进制证书）否 |
| 4.2 | pnpm 版本 | **10.34.6**（同源已验收） | pnpm 11：store 依赖 `node:sqlite`，本工程虽可用但未经安装路径实测；跨工程一致优先 |
| 4.3 | 引擎落地目录 | **`node_modules/dsh-market-pnpm`（独立目录）** | 与顶层同名包解耦，避免将来 `dsh plugin` 把 `node_modules/pnpm` 当作自己的工具链 |
| 4.4 | worker 不可用时 | **同线程执行（沿用原设计）已否决** | 无可判定完成条件（§3.4）；失败闭环比假成功安全 |
| 4.5 | 契约对接 | **市场内置 `desktopProfiles` / `desktopPnpm`（Route 1）** | 改市场源码（Route 2）否；改上游 dsh 否；`profileContext.packageManager` 走 CLI spawn 否（P1） |
| 4.6 | profile 位置 | **留在载荷 `<runRoot>/profiles/ohos`** | 迁到 `$DSH_HOME/profiles/ohos` 会改动 loader 解析锚点与 dsh 的 profile 契约，收益（跨代持久化）不抵本期风险；登记 L1 |
| 4.7 | 布局与导入法 | **hoisted + copy** | `isolated`（pnpm 默认）建 symlink/hardlink，平台禁止（P3） |
| 4.8 | lifecycle 脚本 | **`ignoreScripts: true`** | 平台无编译器/无法 spawn；同时是安全属性。代价：市场 UI 的「放行构建脚本并重试」（写 `allowBuilds:`）在本宿主**必然无效**，须在文档披露（R5） |
| 4.9 | dshmarket 第二份拷贝 | **不需要** | bundle 与 client 扫描都以载荷为锚点（§3.5）；复制只会造两份漂移 |
| 4.10 | profile `dependencies.dshmarket` | **不写** | pnpm 每次 `add` 重解析全部直接依赖（§3.2） |

---

## 5. 数据流与时序

**构建期**

```
assemble-payload.mjs --deploy --apply
  ├ pnpm deploy（上游树）→ prunePayload
  ├ overlay()
  │   ├ profiles/ohos → <stage>/profiles/ohos
  │   ├ collectOhosPackages() → <stage>/node_modules/@dsh-ohos/*（含 market）
  │   ├ collectMarketPNPM()   → <stage>/node_modules/dsh-market-pnpm/（pnpm 10.34.6）
  │   └ collectDshMarket()    → <stage>/node_modules/dshmarket/（+ 运行时依赖闭包）
  └ assertStage()：插入行可解析 / 无 symlink / 无 unlink
package-payload.mjs → dsh.tar.gz → resfile → HAP
```

**启动期**

```
bootstrap.js（主线程：异常兜底 → jitless 兼容层 → 垫片 → 解包）
  → host.js
     ├ DSH_PNPM_ENGINE = <runRoot>/node_modules/dsh-market-pnpm/bin/pnpm.cjs
     ├ ensureProfilePnpmConfig(<runRoot>/profiles/ohos)（缺失才写，storeDir 绝对）
     ├ loadProfileDirectory('dsh', <runRoot>/profiles/ohos, dshManifest)
     │    bundles: dsh-base → dsh-web-app → @dsh-ohos/bundle → dshmarket
     ├ 行 market = @dsh-ohos/market：provide desktopProfiles / desktopPnpm（+ worker 探针）
     └ 行 dsh-market = dshmarket：ctx.get('desktopProfiles') 命中 ⇒ 进程内通道
```

**安装 / 卸载期**

```
市场 UI → POST /dsh-market/install | /uninstall
  → createDesktopPluginRuntime(service, current.dir).runPlugin(['add','-w',target,--reporter=ndjson])
  → @dsh-ohos/market runPlugin
      ├ 单飞闸门 → worker（新 realm：兼容层 → execPath → argv → CI → symlink 回退）
      ├ pnpm add --dir <profile>（hoisted/copy/ignore-scripts/绝对 store）
      ├ stdout(ndjson) → 市场进度；stderr → 失败分类
      └ worker exit 码 → { ok, hot }：市场等 8 s 后自行 hot mount，失败则提示重启应用
```

---

## 6. 失败模式

| 场景 | 表现 | 是否阻塞启动 |
|---|---|---|
| 引擎未物化 / `DSH_PNPM_ENGINE` 未设 | `runPlugin` 句柄 `done`=127，stderr 点名期望路径 | 否 |
| worker 起不来 | `done`=127 + `workerError` 记录；启动探针如实上报 `worker=failed` | 否 |
| `dshmarket` 物化缺失 | `reportSkippedBundles` 记一行，设置页无市场入口 | 否（构建期已硬失败） |
| 引擎/市场版本漂移 | 构建期断言失败，`fail(1)` 不出包 | — |
| `profileContext.dir` 缺失 | 不 provide 服务；市场走普通 CLI 分支并显式失败 | 否 |
| pnpm 网络失败 / registry 不可达 | 原样 stderr + 非零退出码，市场 UI 分类展示 | 否 |
| `node:http` 在 worker 里缺兼容层 | 兼容层安装失败会在 stderr 明确报出（不静默） | 否 |
| symlink 被拒（`.bin`） | worker 就地回退 copy，安装继续 | 否 |
| 并发安装 | 同步抛错，市场判定 `busy`（409 语义） | 否 |
| 重复 install / remove | pnpm 幂等；`dsh.profile.bundles` 由市场 reconcile | 否 |
| 用户取消 / 超时 | `worker.terminate()`；`done` 非零 + 父侧补「已取消」 | 否 |
| 装完不生效 | 市场等 8 s 后自行 hot mount；仍失败则提示重启应用（整应用重启，R8） | 否 |

---

## 7. 实现落点

| # | 落点 | 文件 | 要点 |
|---|---|---|---|
| 1 | 引擎物化 | `scripts/assemble-payload.mjs` | `collectMarketPNPM()` + `prunePnpmEngine()` + `assertPnpmEngineArtifact()` |
| 2 | 市场物化 | 同上 | `collectDshMarket()` + `copyMarketRuntimeDeps()` + `assertDshMarketArtifact()`（闭包级） |
| 3 | 契约插件 | `packages/market-ohos/{package.json,lib/index.js}` + `packages/bundle-ohos/cordis.patch.yml` 的 insert 行 | `@dsh-ohos/market`；命名导出；`peerDependencies: @deepseek-ai/cordis`；行由 bundle 覆盖层插入 |
| 4 | 进程内 pnpm | `packages/market-ohos/lib/pnpm-inprocess.js`、`lib/pnpm-worker.mjs` | worker + 兼容层 + symlink 回退 + 单飞 |
| 5 | 挂载 | `packages/bundle-ohos/cordis.patch.yml` | `insert` 一行 `market` |
| 6 | profile 声明 | `profiles/ohos/package.json` | bundles 追加 `dshmarket`（**不加 dependencies**） |
| 7 | pnpm 配置 | `payload/host.js` `ensureProfilePnpmConfig()` | 运行期生成，绝对 `storeDir` |
| 8 | 运行期 env | `payload/bootstrap.js`、`payload/host.js` | `DSH_OHOS_JITLESS_ENTRY`、`DSH_PNPM_ENGINE` |
| 9 | 单测 | `packages/market-ohos/test/*.test.mjs` | 引擎断言、argv/`--dir` 合成、单飞抛错、symlink 回退 |
| 10 | 包文档 | `packages/market-ohos/README.md`、`README_zh.md` | 契约、配置、限制 |
| 11 | 工程文档 | `README.md`、`README_zh.md`、`docs/鸿蒙环境能力清单-0.2.1.md`、`specs/README.md`、`specs/SPECS_CHECKLIST.md` | 能力清单 #33 / D.2 状态更新 |
| 12 | 规格 | `specs/012-pnpm-integration/`、`specs/201-dsh-market/` | spec / plan / tasks / test-cases |

---

## 8. 验证策略与风险

**分层证据**

| 层 | 手段 | 覆盖 |
|---|---|---|
| 构建期 | `assemble-payload.mjs` 断言（版本 / 入口 / 闭包 / 无链接）+ 产物核对 | 引擎与市场物化正确性 |
| 单元 | `node --test packages/market-ohos/test/*.test.mjs` | argv 合成、引擎断言、单飞抛错、symlink 回退 |
| 本机冒烟（Windows） | `node payload/bootstrap.js` + 本机 pnpm 装一个测试包；**不带 `--jitless`**，只覆盖契约与落盘，覆盖不到 P10 的 worker realm 问题 | 契约链路、worker、安装落盘 |
| 真机基础 | 设置 DeepSeek API Key（`sk-dc5d…`）→ 选 `deepseek-flash` → 建工作区 → 对话 | 市场以外的回归 |
| 真机市场 | 设置 → 插件市场 → 安装第一个插件 → 使用 → 卸载 | 全链路 |
| 取证 | `hilog`、`app.log`、`<profile>/.dsh-market/log.ndjson`、`--inspect` 探针、`hdc shell ls` | 失败可归因 |

**真机市场验收判据**（缺一不算通过）

1. 设置页出现「插件市场」入口，目录能拉取（或如实记录网络不可达）。
2. 点第一个插件的「安装」后：`<profile>/node_modules/<pkg>/package.json` 存在；`.dsh-market/log.ndjson` 有 `event:install` 且 `detail` 含 `exit=0`；UI 显示已安装。
3. 「使用」：该插件的客户端面或工具在刷新/hot mount 后真的可用（按插件类型取证据：设置页出现其配置卡、或对话里调用其工具成功）。
4. 「卸载」后：`<profile>/node_modules/<pkg>` 消失；profile `package.json` 的 `dependencies` 对应行移除、`dsh.profile.bundles` 未被多余写入；重启应用后不复活。
5. 全程 `hdc shell ps -ef | grep -c pnpm` 不因安装增加（无子进程），日志无 `WebAssembly is not defined`。

**风险与遗留**

| # | 风险 / 遗留 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 设备到 `registry.npmjs.org` / `awesome-dsh-plugin.com` 的可达性 | 目录或安装失败 | 先探测；不可达则如实记录并改用可达镜像验证安装通道 |
| R2 | `--jitless` 下 pnpm 解包是纯 JS，安装可能分钟级 | 超时 / 体验 | 市场 15 min 预算；用例给足时间并记录耗时 |
| R3 | pnpm 引擎 ≈ 21 MiB + 市场 ≈ 2 MiB | HAP 体积 | 构建期打印增量；prune 非目标平台二进制 |
| R4 | 市场版本浮动（当前 1.66.42；hos 记 1.66.21 / 1.66.7） | 契约漂移 | 集中常量 + 构建期断言；升级即红 |
| R5 | `ignoreScripts: true` 使市场的「放行构建脚本并重试」无效 | 用户被引导到死路 | 文档与 UI 文案披露；`git:` 源同样不可装 |
| R6 | 载荷分代 ⇒ 换包后已装插件消失（L1） | 升级体验 | 登记为已知限制；后续任务：profile 迁 `$DSH_HOME` 或代际接续 |
| R7 | 安装通道绕过 `fs-sandbox`：pnpm 直接写 profile 目录 | 安全面扩大 | 安装目录由宿主固定为 profile，**不采信**市场传入的 `invokingDir`；`ignoreScripts` 关闭脚本执行 |
| R8 | 无 `pluginActivation` 时市场固定等 8 s 再 hot mount，失败提示「重启应用」= 整应用重启 | 体验 / 验收口径 | 验收以「重启后仍可用」为退路；后续实现 `pluginActivation` 可去掉等待 |
| R9 | 市场的网络层换成纯 JS undici 替身后，`HTTP(S)_PROXY` 不再生效（`EnvHttpProxyAgent` 是空实现） | 需要代理的环境里市场请求直连并失败 | 设备侧不出网代理；如实登记于 `packages/market-ohos/README*.md`；若将来需要代理，在替身里补 CONNECT 隧道 |
