# 101 运行时启动编排 —— 技术方案（plan）

> 模块：`101-runtime-launch-orchestration`｜状态：**implemented + 1 项 planned**｜最后更新：2026-10-18
> 对应 spec：`specs/101-runtime-launch-orchestration/spec.md`

## 1. 技术上下文

| 项 | 值 |
|---|---|
| 语言 / 框架 | ArkTS（Stage 模型）、ArkUI 状态管理（`@State`） |
| SDK | `compatibleSdkVersion 5.0.5(17)`、`targetSdkVersion 6.1.1(24)` |
| 构建 | hvigor 6.1.1.280（CLT），HAR 依赖 `libs/@fellow99/node-bridge.har` |
| 运行时库 | `@fellow99/node-bridge` 0.1.0；Node **v24.2.0**（ABI 137），进程内 `node::Start` |
| 上游 | `deepseek-harness` `dsh-v0.2.1-rc.2`（由模块 102 装配为载荷） |
| 设备形态 | 2in1 / tablet（`module.json5` 已限定） |
| 关键平台 API | `@kit.AbilityKit`、`@kit.CoreFileKit`、`@kit.NetworkKit`、`@kit.PerformanceAnalysisKit` |

## 2. 宪法合规检查（C1–C14）

| 原则 | 状态 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 本模块不引用上游源码、不改前端、不做原生 UI |
| C2 平台真相不隐藏 | ✅ | 失败即 `FAILED`，诊断含失败阶段与原因；无伪成功路径 |
| C3 证据优先 | ⚠️ | 证据形态已定义（公告 + 截图 + hilog），但无真机执行记录（L1–L4 pending） |
| C4 单进程/单实例/随机端口 | ✅ | 不指定端口（由 Node 侧 `--port 0` 申请）；单例由 `launchType` 保证 |
| C5 谁写谁读 | ✅ | 只传归档路径，绝不解包、不写 Node 将读取的树 |
| C6 绝对路径 | ⚠️ | 运行期路径全部由 `filesDir`/`resourceDir` 派生；但宪法给的检查命令会命中 `import './Probe'` 字面量（非运行期路径） |
| C7 垫片可审计 | ✅ | 本模块不安装垫片；信箱传输由库启动并返回状态串 |
| C8 异常兜底 | ⚠️ | 启动流程整体 `try/catch`；Node 侧兜底属模块 102；本模块不处理 Node 崩溃后的进程级异常 |
| C9 鉴权只在 Host | ✅ | 只透传公告中的入口地址，不解析凭据、不改 Host/Origin |
| C10 权限最小化 | ✅ | 本模块不新增权限声明（权限集中在模块 103/108 的清单） |
| C11 秘密不入库/不进日志 | ⚠️ | 入口地址含一次性凭据，仅存内存与 UI；但公告文件本身落盘含 token（写入方为 102），本模块未额外脱敏 |
| C12 编号即契约 | ✅ | `101-runtime-launch-orchestration/` 对应本模块，文档与目录一致 |
| C13 构建可复现 | ✅ | 本模块无二进制、无生成物 |
| C14 文档描述现状 | ⚠️ | as-built 与既有整体文档存在 3 处偏差（见 §3），已在本文件标注 `planned`/`not-implemented` |

## 3. 研究结论

1. **投递 ≠ 就绪**：`NodeRuntime.start()` 返回 `ok=true` 只代表原生线程已创建（`code=0`）；`code>0` 是 `pthread_create` 错误码，`code<0` 是 ArkTS 校验失败（`-1` 状态非 idle、`-2` 缺入口）。
2. **等待判据是线程存活，不是 HTTP 就绪**：`waitUntilRunning()` 轮询的是原生 `isRunning()`（`g_node_running`），而原生在调用 `node::Start` **之前**就把它置 1。因此 60 秒等待几乎立即返回，HTTP 服务此时可能尚未监听。
3. **`ready.json` 只读一次是缺陷**：`DshRuntime` 在等待返回后立即 `readReady()`，读不到即 `FAILED`；首次启动几乎必然命中。第二次启动可能读到**上一次运行残留**的公告（旧端口、旧 token），探活失败后同样 `FAILED`。→ FR-101-007 标 **planned**。
4. **公告无新鲜度校验**：未比对 `pid`/`at`，陈旧公告无法与本轮运行区分；代码也未在启动前删除公告。
5. **探活语义**：HEAD 请求回调 `err == null` 即视为可达（4xx/5xx 也算），与「监听存在」的判断一致；每次新建并销毁 `HttpRequest`，超时各 2 秒。
6. **状态机有 2 处未落地**：`LaunchPhase.READY` 从未赋值（直接 `RUNNING`）；`shutdown()` 只把内部状态改为 `STOPPED`，不再广播快照，`shutdown` 返回的 Promise 也未 `await`。
7. **目录创建吞异常**：`ensureDirs` 对每个目录 `mkdirSync` 后丢弃所有异常（含权限/磁盘满），问题被推迟到首次真实读写。
8. **生命周期覆盖最小**：`EntryAbility` 只实现 `onCreate`/`onWindowStageCreate`/`onPrepareToTerminate`/`onDestroy`；无 `onWindowStageDestroy`、前台/后台切换与返回键处理。
9. **未实现的整体文档声明**：`ARCHITECTURE.md` §6 把 `READY` 画成独立阶段、`overall-data-model.md` §3 称 `READY→RUNNING` 由首个页面加载驱动——两者在 as-built 中均不成立。

## 4. 数据模型（真实字段）

`LaunchPhase`（字符串枚举）：`IDLE`、`PREPARING`、`STARTING`、`WAITING`、`PROBING`、`READY`、`RUNNING`、`FAILED`、`STOPPING`、`STOPPED`。

| 类型 | 字段 | 类型 | 备注 |
|---|---|---|---|
| `LaunchSnapshot` | `phase` / `message` / `detail` / `url` | `string` ×4 | `url` 仅 `RUNNING` 非空 |
| `ReadyInfo`（读取视图） | `schema?` / `phase?` / `url?` / `origin?` / `token?` / `pid?` / `version?` / `diagnostic?` | 可选 | 未知字段被忽略 |
| `CrashRecord` | `at` / `stage` / `signal?` / `hint?` / `logTail` | `number`/`string`/`string[]` | 来自库 |
| `NodeStartResult` | `ok` / `code` / `state` / `message` | `boolean`/`number`/`NodeState`/`string` | `state` 成功即 `starting` |

**迁移表**：`IDLE → PREPARING → STARTING → WAITING → PROBING → RUNNING`；任一阶段 → `FAILED`（终态）；`RUNNING → STOPPING → STOPPED`。`READY` 无入边（未使用）。

## 5. 接口契约

### 5.1 Provided（本模块对外）

| 成员 | 签名要点 | 语义 |
|---|---|---|
| `DshRuntime.get()` | `(): DshRuntime` | 进程内单例 |
| `launch(context, listener)` | `Promise<void>` | 幂等；重复调用只 `emit()` 最近快照 |
| `snapshot()` | `: LaunchSnapshot` | 同步读当前帧 |
| `shutdown(reason)` | `: void` | 置 `STOPPING`→`STOPPED`，通知库，不等待 |

### 5.2 Consumed（依赖）

| 来源 | 契约 |
|---|---|
| `NodeRuntime` | `start(context, options): NodeStartResult`、`waitUntilRunning(ms): Promise<void>`（失败 reject，message 含 stage/lastError/logPath）、`markRunning()`、`markFailed(reason)`、`logs(count)`、`lastCrash()`、`shutdown(reason)` |
| `NodeRuntime.host` | `startMailbox(dir, 100): string` |
| `NodeRuntimeOptions` | `scriptPath`、`payloadRoot`、`readonlyRoot`、`archive`、`cwd`、`homeDir`、`logPath`、`jitless`、`env`、`onStateChange` |
| 平台 | `context.filesDir/resourceDir`、`fs.accessSync/readTextSync`、`http.createHttp()`、`hilog` |

### 5.3 事件协议

- **状态事件**：`launch(context, listener)` 的 listener 在同一 ArkTS 线程**同步**回调；每次迁移一帧；无事件总线、无持久化。
- **跨进程事件**：唯一信号是 `<filesDir>/payload/ready.json`（生产者模块 102）；本模块按文件读取，不订阅变更。
- **日志事件**：hilog `DOMAIN 0xD0033` / `TAG DSH_DESKTOP_ARK`，`%{public}s`；不含入口地址与凭据。

## 6. 实现策略

**架构模式**：单例编排器 + 显式状态机 + 同步观察者。UI 不参与判定，只渲染快照。

**关键算法（`launch`）**

1. 保存 listener；若 `launched` 已置位 → `emit()` 后返回（FR-101-001）。
2. `ensureDirs` → 注册宿主能力 → `host.startMailbox(mailboxDir, 100)`（FR-101-002、FR-101-017）。
3. 组装 `NodeRuntimeOptions`（`scriptPath` 指向 resfile 载荷入口、`archive` 指向归档、`cwd` 指向沙箱工作区、`env` 注入 `DSH_HOME`/`DSH_OHOS_*`）并投递（FR-101-014）。
4. `ok=false` → `fail(code, message)`（FR-101-012）。
5. `await waitUntilRunning(60000)`；reject 由外层 `catch` 统一转 `fail`（FR-101-004）。
6. 读公告 → 校验 `phase==='ready'` 且 `url` 非空 → `Probe.waitFor(origin ?? url, 20, 500)`（FR-101-005/006/008；重试读取为 planned）。
7. `markRunning()` → 置 `RUNNING` + `url` → `emit()`（FR-101-009）。

**错误处理**：`fail()` 组装「原因 + `logs(200)` 尾 + `lastCrash()`」，写入 `detail`；随后 `markFailed` 包在 `try/catch` 中，标记失败只记日志（FR-101-010、FR-101-011、FR-101-013）。`readReady` 的 `access`/`read`/`parse` 全部吞异常返回 `null`。

**性能**：目录创建 6 次同步 `mkdir`；探活最坏 20 × (2 s + 500 ms) ≈ 50 s，叠加等待预算后可能超过 60 s 总预算——实际受 `START_TIMEOUT_MS` 约束的只有等待段，探活段**独立计时**（已知预算不一致，未修正）。

**UI 交接**：页面在快照 `url` 非空时解除覆盖层并调用 `loadUrl`；`FAILED` 时显示详情与退出入口；退出只置状态并放行终止（FR-101-015、FR-101-016）。

## 7. 测试考虑

| 用例 | 覆盖 FR | 层 | 现状 |
|---|---|---|---|
| TC-101-001 | FR-101-003/005/008/009 | L1/L2 | pending（需真机 + 已投放运行时 + 载荷） |
| TC-101-002 | FR-101-006/010 | L2 | pending |
| TC-101-003 | FR-101-006/011 | L0/L2 | pending（公告样本可离线构造，但无测试目录） |
| TC-101-004 | FR-101-008/010 | L2 | pending |
| TC-101-005 | FR-101-004/012 | L2 | pending |
| TC-101-006 | FR-101-001/012/015 | L2 | pending |
| TC-101-007 | FR-101-010/013 | L2 | pending |

- 仓库内**没有** `entry/src/ohosTest` 或单测目录；本模块无可自动执行的测试，L0 仅由 `hvigorw assembleHap` 覆盖编译。
- 就绪公告无重试（FR-101-007 planned）意味着 TC-101-001 在真机上预期失败；修复前应在用例表标 `blocked`，不得标通过。
- 建议的离线验证：以固定公告 + 本地 HTTP 服务模拟 `phase=ready`，验证读取/校验/探活分支；当前未落地。

## 8. 文件清单

| 路径 | 行数 | 职责 |
|---|---|---|
| `entry/src/main/ets/app/DshRuntime.ets` | 237 | 状态机、投递、等待、公告回读、探活、失败诊断 |
| `entry/src/main/ets/app/Probe.ets` | 55 | HEAD 探活 + 有界重试 |
| `entry/src/main/ets/common/Constants.ets` | 98 | 路径派生、超时/重试常量、目录创建 |
| `entry/src/main/ets/entryability/EntryAbility.ets` | 39 | UIAbility 生命周期、加载 `pages/Index`、退出放行 |
