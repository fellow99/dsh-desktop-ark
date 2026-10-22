# 104 宿主能力桥 —— 技术方案（plan）

> 模块：`104-host-capability-bridge`｜状态：**部分 implemented（6 可用 / 8 not-implemented）**｜最后更新：2026-10-18
> 对应 spec：`specs/104-host-capability-bridge/spec.md`

## 1. 技术上下文

| 项 | 值 |
|---|---|
| 语言 | ArkTS（Stage 模型），处理器为同步函数或 `Promise<string>` |
| 传输 | 库的文件信箱：`startMailbox(dir, 100)`，轮询 100 ms；`.tmp → .req → .wip → .done/.fail` |
| 能力注册 | `HostBridge.register(name, handler)`；同名覆盖；`has/list/unregister` 用于诊断 |
| 分发 | `dispatch`（同步）/`dispatchAsync`（await）；同一套前置校验 |
| 上限 | `capBytes` 8 MiB（UTF-8 字节）；原生槽位通道另有 name 128 B / args 8 KB / result 64 KB |
| 陈旧回收 | 10 分钟；在飞请求豁免；心跳 `heartbeat.log` 超 64 KB 轮转 |
| 平台 API | `abilityAccessCtrl`、`bundleManager`、`Want`、`context.startAbility`/`openLink`、`hilog` |
| 调用方 | 仓库内**无** Node 侧调用点；库自带 Node 客户端未随本仓库载荷分发 |

## 2. 宪法合规检查（C1–C14）

| 原则 | 状态 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 能力实现全在消费方，库只做寄存器与传输；不改上游 |
| C2 平台真相不隐藏 | ❌ | `runtime.facts.userDirs[].available` 恒为 true（未做存在性检查）；`shell.openExternal` 对工作区文件回 `not-implemented` 而非策略拒绝 |
| C3 证据优先 | ⚠️ | 用例判据明确，但无真机调用记录；端到端链路缺 Node 侧调用方，L0 无法取证 |
| C4 单进程/单实例/随机端口 | ✅ | 桥不涉及端口；单实例由模块 103 清单保证 |
| C5 谁写谁读 | ✅ | 只写双方约定的信箱目录（显式共享契约），不碰载荷树 |
| C6 绝对路径 | ✅ | 事实中的路径全部由 `filesDir`/`resourceDir` 派生 |
| C7 垫片可审计 | ⚠️ | 图像/文件锁垫片仍是探针；`image.normalize` 桥目标不存在，S4 无法兑现 |
| C8 异常兜底 | ✅ | 每个处理器 `try/catch`；库 `dispatch/dispatchAsync` 永不抛 |
| C9 鉴权只在 Host | ✅ | 能力面不接收/解析 token，不改变监听地址 |
| C10 权限最小化 | ⚠️ | `perm.request` 只转发调用方给的名字；模块清单声明的 `READ_PASTEBOARD` 等能力尚未实现 |
| C11 秘密不入库/不进日志 | ✅ | `log.hilog` 只写 level+msg；事实与诊断串不含凭据 |
| C12 编号即契约 | ✅ | `104-host-capability-bridge/` 对应 `host/HostCapabilities.ets` |
| C13 可复现 | ✅ | 无二进制、无生成物 |
| C14 文档描述现状 | ❌ | `overall-data-model.md` §4.3 列 14 个「冻结名」，库的 `HostBridge.CAPABILITIES` 只有 8 个；§5 示例含 `capabilities` 字段，代码不产出 |

## 3. 研究结论

1. **注册早于投递**：模块 101 在 `PREPARING` 阶段先 `HostCapabilities.install(runtime.host, context)` 再 `startMailbox`，最后才 `NodeRuntime.start()`；启动期调用不会丢（FR-104-001/010 的落地顺序）。
2. **14 个名字，6 个有实现**：`runtime.facts`、`log.hilog`、`perm.check`、`perm.request`、`perm.openAppInfo`、`shell.openExternal` 有处理器；其余 8 个由 `notImplemented()` 注册，统一返回 `{ok:false,error:'not-implemented',hint}`（FR-104-007）。
3. **错误码有两个层次**：消费方产出 `not-implemented`/`bad-args`/`internal`；库前置校验产出 `bad-args`/`unregistered`/`payload-too-large`，处理器抛错产出 `handler-threw`，同步通道遇 Promise 产出 `async-handler-on-sync-path`。`internal` **不是**库的错误码。
4. **结果被二次包装**：信箱 `.done` 内容为 `{ok:true,result:"<转义后的处理器返回串>"}`，`.fail` 为 `{ok:false,error,detail,dispatch}`；Node 侧 `invoke()` 解析 `result` 后按内层 `ok` 决定 resolve/reject。
5. **`userDirs[].available` 是伪造事实**：`HostCapabilities.exists()` 只判断 `path.length > 0`，注释也承认「真实存在性由 Pickers 暴露」；与 FR-104-017 直接冲突（C2）。
6. **`runtime.facts` 缺字段**：实际只有 `schema/app/node/paths/userDirs/jitless`，没有整体文档示例中的 `capabilities` 映射；`paths` 反而多出 `assetRoot`/`mailbox`（向前兼容可接受）。
7. **`shell.openExternal` 语义偏差**：只接受 `https://` 前缀；其它（含工作区文件）返回 `not-implemented`。FR-104-019 要求的「工作区内文件」未实现，错误码也不该用 `not-implemented`（应为策略拒绝）。
8. **无处理器超时**：信封没有超时字段；库的 Node 客户端默认 15 秒，ArkTS 侧没有 10 秒预算（规划 §6.4 的「超时 10 s」未落地）。
9. **能力面端到端未闭环**：本仓库 `payload/host.js` 不含信箱客户端，也从不调用能力；`DSH_OHOS_MAILBOX` 只在模块 101 注入，载荷未读取。真正的调用方应是 105/106 的 seam 插件（planned）。
10. **库的能力清单与消费方不一致**：`HostBridge.CAPABILITIES` 只有 8 个 v1 名字（不含 `perm.request`、`fs.saveFile`、`clipboard.*`、`image.normalize`、`power.keepAwake`），消费方注册 14 个；该常量仅用于日志/自检，但会造成「文档说 14、库说 8」的观测混乱。
11. **串行是硬保证**：`mailboxInflight` 非空即早退；异步处理器跨 tick 期间不会再取件（FR-104-010）。`mailboxTick` 从不 `await`，因此异步结果只能经 `dispatchAsync().then` 回填。
12. **参数校验顺序**：`bad-args`（空名/非字符串）→ `unregistered` → `payload-too-large`；UTF-8 长度测量失败也回 `bad-args`，不猜值（FR-104-008、FR-104-009）。

## 4. 数据模型（真实字段）

| 实体 | 字段 |
|---|---|
| 请求文件 `<id>.req` | `{name:string, args:string, pid:number, ts:number}`；`id` 在文件名：`req-<13 位时间戳>-<4 位序号>` |
| 成功结果 `<id>.done` | `{ok:true, result:"<处理器返回串的 JSON 转义>"}` |
| 失败结果 `<id>.fail` | `{ok:false, error:<码>, detail:<文本>, dispatch:<原始串>}` |
| 处理器成功体（消费方） | `{ok:true, ...}`；如 `perm.check` → `{ok:true,granted:boolean}` |
| 处理器失败体（消费方） | `{ok:false, error, hint}` |
| `RuntimeFacts` | `schema:1`、`app{bundleName,versionName,versionCode}`、`node{expected:'v24.2.0',abi:137}`、`paths{filesDir,resourceDir,payloadRoot,assetRoot,dshHome,workspace,mailbox}`、`userDirs[{id,path,available}]`、`jitless:false` |
| `UserDirFact` | `id`（小写目录名）、`path`（固定 `/storage/Users/currentUser/<Name>`）、`available`（当前恒 true） |
| 心跳 | `<mailbox>/heartbeat.log`：`ISO 时间 + 事件`；超 64 KB 截断重写 |

**状态机（单个请求）**：`.tmp` → `.req`（发布）→ `.wip`（取走）→ `.done`/`.fail`（回填）→ 五件套清理；超时/崩溃残留由回收器在 10 分钟后删除（`.wip` 在飞时豁免）（FR-104-011、FR-104-012、FR-104-013、FR-104-014）。

## 5. 接口契约

### 5.1 Provided（能力面）

| 能力 | 入参 | 出参 | 状态 |
|---|---|---|---|
| `runtime.facts` | `{}` | `RuntimeFacts` | implemented |
| `log.hilog` | `{level?:'error'\|'warn'\|'info', msg?:string}` | `{ok:true}` | implemented |
| `perm.check` | `{name:string}` | `{ok:true,granted:boolean}` | implemented |
| `perm.request` | `{names:string[]}` | `{ok:true,authResults:number[],permissions:string[]}` | implemented（async） |
| `perm.openAppInfo` | `{}` | `{ok:true}` | implemented（async） |
| `shell.openExternal` | `{uri:string}` | `{ok:true}` | implemented（仅 https；async） |
| `fs.pickFolder` / `fs.pickFiles` / `fs.saveFile` | — | `not-implemented` | 占位 |
| `notify.show` / `clipboard.readImage` / `clipboard.writeText` / `image.normalize` / `power.keepAwake` | — | `not-implemented` | 占位 |

### 5.2 Consumed

| 来源 | 契约 |
|---|---|
| 库 `HostBridge` | `register(name, handler)`、`startMailbox(dir, 100)`、`dispatch`/`dispatchAsync` 的前置校验与错误信封 |
| `common.UIAbilityContext` | `filesDir`、`resourceDir`、`startAbility(want)`、`openLink(uri)` |
| `abilityAccessCtrl` | `createAtManager()`、`checkAccessTokenSync(tokenId,name)`、`requestPermissionsFromUser(context,names)` |
| `bundleManager` | `getBundleInfoForSelfSync(GET_BUNDLE_INFO_DEFAULT / WITH_APPLICATION)`：`name`、`versionName`、`versionCode`、`appInfo.accessTokenId` |
| 模块 101 | 启动时 `install(host, context)` 与 `startMailbox` |

### 5.3 事件协议

- **请求/响应**：只有这一种方向（Node → ArkTS）；**没有**反向推送、没有事件订阅（库的 `onLog` 明确不实现）（FR-104-015、FR-104-021）。
- **文件事件**：每次状态变化都是一个可 `cat` 的文件；`heartbeat.log` 每 50 轮（约 5 秒）刷一次存活行。
- **诊断事件**：`mailboxStats()`/`transportStats()` 返回人读统计串；hilog 记录启动/停止/坏请求。
- **错误传播**：处理器返回 `{ok:false,...}` → `.fail`；未捕获异常 → `.fail` + `handler-threw`；无响应 → 调用方按自己的超时失败。

## 6. 实现策略

**架构模式**：注册表 + 前置校验 + 串行信箱泵；能力实现是纯函数（上下文由闭包捕获）。

**注册算法**：先注册 6 个真实处理器，再对 8 个占位名逐个 `register(name, () => JSON.stringify({ok:false,error:'not-implemented',hint}))`；同名覆盖语义意味着后注册生效（FR-104-001、FR-104-002、FR-104-003）。

**处理器模板**：`try { parse(args) → validate → 调平台 API → JSON.stringify(成功体) } catch (e) { internal(name, e) }`；`internal` 只保留 `message` 摘要，不输出堆栈中的路径（当前实现会带 message）（FR-104-004、FR-104-005、FR-104-006）。

**能力实现要点**：`facts` 读包信息 + 常量路径 + 用户目录三元组；`perm.check` 用 `accessTokenId` 同步查；`perm.request` 直接 await 系统弹窗（天然异步，必须走信箱）；`openAppInfo` 用 `Want{action:'ohos.settings.application.details', parameters:{bundleName}}`；`openExternal` 用 `context.openLink`。

**错误处理**：参数缺失 → `bad-args`；未知名字由库前置校验拦成 `unregistered`；平台异常 → `internal` + `hint='<能力名>: <message>'`；占位能力永不进入平台调用（FR-104-007）。

**性能**：轮询 10 Hz；单次往返 ≤ 100 ms（真机约 2 ms）；串行 + 单在飞；无额外线程。

## 7. 测试考虑

| 用例 | 覆盖 FR | 层 | 现状 |
|---|---|---|---|
| TC-104-001 | FR-104-016/017 | L0/L2 | pending；`userDirs.available` 恒真会判失败 |
| TC-104-002 | FR-104-007 | L0 | pending（需 Node 侧调用方或库自检） |
| TC-104-003 | FR-104-007 | L0 | pending（同上） |
| TC-104-004 | FR-104-018 | L2 | pending（需设备授权态） |
| TC-104-005 | FR-104-020 | L2 | pending（需 hilog） |
| TC-104-006 | FR-104-006 | L0 | pending（需注入抛错处理器；仓库无测试工程） |
| TC-104-007 | FR-104-008/009 | L0 | 可由库前置校验覆盖；无脚本 |
| TC-104-008 | FR-104-010/013/014 | L0/L2 | pending（需目录快照） |

- 仓库内没有 `entry/src/ohosTest`、没有 Node 侧能力调用脚本；`payload/selfcheck.js` 也**不**检查能力面。
- 由于载荷不含信箱客户端（§3.9），L0 无法真正发起一次能力调用；在 105/106 插件落地前，本模块只能做静态审查与库侧单测（库不在本仓库）。
- 建议的离线验证：直接调用 `host.dispatchAsync('runtime.facts','{}')`（ArkTS 侧自检入口）并断言 JSON；当前未提供该入口。

## 8. 文件清单

| 路径 | 行数 | 职责 |
|---|---|---|
| `entry/src/main/ets/host/HostCapabilities.ets` | 287 | 14 个能力注册、事实/权限/外开/日志实现、错误信封 |
| `payload/shims/sharp.js` | 30 | S4 替身探针；`image.normalize` 能力的桥接目标（planned） |
| `payload/shims/sqlite.js` | 43 | S5 探测；与 `runtime.facts` 的 `sqlite` 字段同源 |
| `payload/shims/flock.js` | 36 | S3 替身探针（无宿主能力依赖） |
| `payload/shims/fs-link.js` | 64 | S1 文件系统垫片（无宿主能力依赖） |
| `payload/shims/fs-symlink.js` | 60 | S2 文件系统垫片（无宿主能力依赖） |

> 说明：信箱实现**不在** `payload/shims/`——ArkTS 侧在 `@fellow99/node-bridge` 包的 `HostBridge`，Node 侧在本仓库 `payload/host.js`（源自上游库参考实现）。本仓库 `payload/shims/` 只有与能力面间接相关的探针。

