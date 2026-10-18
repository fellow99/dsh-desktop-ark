# 技术方案：诊断与可观测（107-diagnostics-observability）
> 工程：`dsh-desktop-ark`
> 状态：四通道日志、就绪报告、失败页诊断、自检脚本 **implemented**；本机事实端点、日志轮转、凭据扫描、垫片标记齐备 **planned**
> 对应规格：`specs/107-diagnostics-observability/spec.md`（FR-107-001…025）
> 依据：`docs/000-工程规划.md` §5.3、§6.7、§11.3；`specs/overall-plan.md` §4.2；`specs/overall-data-model.md` §2、§5、§9；`specs/overall-test-cases.md` §9

---
## 1. 技术上下文
| 通道 | 落点 | 产生方 | 状态 |
|---|---|---|---|
| 运行时日志 | `<filesDir>/payload/node.log` | 运行时库接管标准输出/错误（含原生输出） | implemented |
| 业务日志 | `<filesDir>/payload/app.log` | `payload/bootstrap.js` 的 `log()`、`payload/host.js` | implemented |
| 系统日志 | hilog（域 `0xD0033`、标签 `DSH_DESKTOP_ARK`） | ArkTS（`DshRuntime`、`EntryAbility`）+ 能力 `log.hilog` | implemented |
| 崩溃记录 | `<filesDir>/node-bridge/last-crash.json`（库写） | 运行时库；`DshRuntime` 只读 | implemented |
| 就绪报告 | `<filesDir>/payload/ready.json` | `bootstrap.js` / `host.js` | implemented |
| 事实端点 | `GET /_ohos/facts`（同源 Cookie） | 上游行插件 `@dsh-ohos/facts` | **planned** |
| 日志轮转 | 同 `app.log`/`node.log` | 本模块 | **planned** |

上下文要点：运行时崩溃是终态（`node::Start` 每进程一次）；日志尾来自库的内存缓冲，不是文件；构建模式只有 `debug`/`release` 两种，没有 debug-only 代码裁剪事实。

---
## 2. 宪法合规
| 原则 | 结论 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 诊断不修改上游；事实端点按 `105` 的行插入与 seam 实现 |
| C2 平台真相不隐藏 | ⚠️ | 失败一律显式（`payload-missing`/`failed` 带诊断）；但 `runtime.facts` 的 `userDirs.available` 目前是伪事实（`HostCapabilities.ets:171-174` 只判路径非空），必须先修才谈"事实" |
| C3 证据优先 | ⚠️ | 日志与自检已可执行，但 TC-107-001…005 未执行，`logs/<date>-N/` 无证据 |
| C4 单进程/单实例/随机端口 | ✅ | 不自动重启；崩溃记录只读（`DshRuntime.ets:187-194`） |
| C5 谁写谁读 | ✅ | 日志与就绪报告都写在 Node 可写根；ArkTS 只读，不写 Node 读取的树 |
| C6 绝对路径 | ✅ | 所有路径来自 `Constants`（由 `filesDir`/`resourceDir` 派生） |
| C7 垫片可审计 | ⚠️ | 标记存在，但 `fs.link` 只在回退时打印、`node:sqlite` 打印的是 `available=` 而非 `installed`，且前缀不是 `[shim]`；自检只覆盖三条垫片（见 F8/F7） |
| C8 异常兜底 | ✅ | `bootstrap.js:59-66` 安装 `uncaughtException`/`unhandledRejection`，只写日志 |
| C9 鉴权只在 Host | ✅ | `host.js` 只记录 token 长度；`ready.json` 内的 token 属透传字段，不进入日志 |
| C10 权限最小化 | ✅ | 诊断不申请权限；事实端点不需要额外权限 |
| C11 秘密不入库 | ⚠️ | 签名/凭据未入日志（FR-107-008 的人工约束已满足）；但缺少自动化的"诊断串不含凭据"断言 |
| C12 编号即契约 | ⚠️ | `specs/107-*` 目录已建，但事实端点代码不存在；C12 检查在实现前必然失败 |
| C13 可复现 | ✅ | 自检幂等；无二进制产物 |
| C14 状态标注 | ⚠️ | `overall-data-model.md` §9 把"日志单文件轮转"标为 implemented，实际无轮转代码——属"planned 写成已实现"，本模块实现时必须同步更正 |

---
## 3. 研究结论
- **F1 业务日志格式**：`bootstrap.js:35-44` 的 `log()` 输出 `ISO 时间 + 空格 + 文本 + 换行`，写入失败时降级到标准错误并加 `[app.log unavailable]` 前缀；日志不可写不会拖垮启动（FR-107-003/FR-107-001 的非功能部分）。
- **F2 阶段埋点集合**：`preparing`（`bootstrap.js:155`）、`extracting`（`:129`）、`payload-missing`（`:166`）、`starting`（`host.js` 的 `writeReady`）、`ready`、`failed`（`bootstrap.js:191`、`host.js` 的 catch）；ArkTS 侧另有 10 态启动状态机（`DshRuntime.ets:16-27`）。就绪报告的 phase 集合与 `overall-data-model.md` §2 一致。
- **F3 原子写确认**：`bootstrap.js:46-57` 先写 `ready.json.tmp`（`wx` 标志）再 `rename`；异常只记日志不抛（FR-107-009）。
- **F4 日志尾来源是库缓冲，不是文件**：`DshRuntime.ets:207-214` 调用 `runtime.logs(200)`（上限 `Constants.LOG_TAIL_LINES=200`）。后果：失败页展示的是 `node.log` 缓冲，**不含** `app.log` 里的业务阶段行；排障时两者需分别取证（FR-107-011 的边界必须写清）。
- **F5 崩溃记录字段**：`CrashRecord` 使用 `stage / signal / at / hint`（`DshRuntime.ets:188-194`），与 FR-107-007 对齐；无自动重启路径。
- **F6 hilog 常量**：`Constants.ets:12-13` 的域 `0xD0033`、标签 `DSH_DESKTOP_ARK` 与 `overall-plan.md` §4.2 一致；`DshRuntime` 每次阶段迁移都打一行（`:172-178`）。
- **F7 自检覆盖不足**：`selfcheck.js:24-39` 只探 `fs.link`、`fs.symlink`、`node:sqlite`，未覆盖 `flock` 与 `sharp`；`docs/000` §5.3 要求"每条垫片都有自检断言"，故 FR-107-019 为 planned（缺口明确）。
- **F8 标记行口径不一致**：`payload/shims/fs-link.js:14` 定义 `DSH_OHOS_SHIM fs.link`，但 `install()` 仅在回退时 `log()`（`:44`），成功安装无行；`payload/shims/sqlite.js:39` 打印 `available/fts5`；而 `docs/000` §5.3 要求"每条垫片打印一行 `[shim] <标记> installed`"。TC-102-004/TC-107-001 因此当前无法按原文通过，需统一标记文案与打印时机。
- **F9 轮转缺失**：全仓无轮转/上限实现（仅 `overall-data-model.md` §9 的声明），`selfcheck` 也不检查日志体积；FR-107-024 为 planned。
- **F10 事实端点未实现**：全仓无 `_ohos/facts` 路由注册（仅垫片注释提及）；`packages/bundle-ohos/cordis.patch.yml` 插入的 `facts-ohos` 行 `enabled: false`。实现需先定"debug-only"落地方式：编译期常量（ArkTS/JS 两侧）或构建期写入行长——当前 `build-profile.json5` 只有 `debug`/`release` 两个 buildMode，没有裁剪机制，属未定项（阻塞 FR-107-020）。

---
## 4. 数据模型
```jsonc
// LogLine（app.log 一行，文本形态）
"2026-10-18T12:00:00.000Z preparing: payload mode=archive sha12=ab12cd34ef56"

// ReadyReport（ready.json，原子写）
{ "schema": 1, "phase": "preparing|extracting|payload-missing|starting|ready|failed",
  "at": 1730000000000, "version": "0.1.0+scaffold",
  "sha12": "ab12cd34ef56",
  "shims": ["DSH_OHOS_SHIM fs.link", "…"],
  "url": "http://127.0.0.1:<port>/?token=…",   // 仅 ready
  "origin": "http://127.0.0.1:0",          // 仅 ready
  "token": "…",                            // 仅 ready，不写日志
  "pid": 1234,
  "roots": { "payload": "…", "dshHome": "…", "workspace": "…", "readonly": "…" }, // 仅 ready
  "diagnostic": "…" }                      // 仅 failed / payload-missing

// CrashRecord（库写、ArkTS 只读）
{ "stage": "running", "signal": "SIGSEGV", "at": 1730000000000, "hint": "…" }

// SelfcheckReport（stdout 单份 JSON）
{ "ok": true, "results": [ { "name": "shim.fs.link", "ok": true, "detail": "DSH_OHOS_SHIM fs.link" } ] }

// FactsDocument（planned，GET /_ohos/facts）
{ "schema": 1, "node": { "version": "v24.2.0", "abi": 137 }, "profile": "ohos",
  "port": 34567, "pluginRows": [ { "id": "workspace-picker", "state": "active" } ],
  "shims": ["DSH_OHOS_SHIM fs.link"], "capabilities": { "notify.show": "not-implemented" } }
```

规则：`ready` 是唯一允许出现 `token` 的阶段；`FactsDocument` 禁含 `token`、`cookie`、目录内容；`schema` 变化必须同步 `overall-data-model.md` 与规格（FR-107-010/023）。

---
## 5. 接口契约
### Provided（本模块对外）
| 契约 | 形态 | 消费者 |
|---|---|---|
| 业务日志行 | 文本行（ISO 时间 + 文本） | 维护者、`selfcheck`、失败页取证 |
| 就绪报告 | JSON（schema 1） | `DshRuntime.readReady`（`101`） |
| 崩溃记录读取视图 | 只读 JSON（库写） | 失败页 |
| 自检报告 | stdout JSON + 退出码（0/1） | L0 门禁、发布检查 |
| 系统日志 | hilog 域 `0xD0033` + 标签 `DSH_DESKTOP_ARK` | 现场排障 |
| 事实端点 | `GET /_ohos/facts`（debug）→ JSON 或 401/404 | 维护者（`curl`） |

### Consumed（本模块依赖）
| 契约 | 来源 | 备注 |
|---|---|---|
| `runtime.logs(n)` / `runtime.lastCrash()` / `onStateChange` | `@fellow99/node-bridge` | 日志尾与崩溃记录的唯一来源 |
| 启动阶段时机 | `payload/bootstrap.js`、`payload/host.js` | 阶段字符串即契约 |
| 环境变量 `NODE_BRIDGE_PAYLOAD_ROOT` / `DSH_OHOS_APP_LOG` | `101` 的启动选项 | 决定日志与就绪报告落点 |
| 能力 `log.hilog` / `runtime.facts` | `104` | 系统日志与事实数据 |
| `facts-ohos` 行 | `105` 的 bundle patch | 端点注册与开关 |
| 构建模式 | `108`（debug/release） | 决定端点是否编译进包 |

---
## 6. 实现策略（含错误处理）
| FR | 落地 | 状态 |
|---|---|---|
| FR-107-001/002 | 四通道分离（`node.log` 由库、`app.log` 自写、hilog、崩溃记录 JSON） | implemented |
| FR-107-003 | 阶段迁移逐条落 `app.log` | implemented |
| FR-107-004 | hilog 域/标签常量唯一 | implemented |
| FR-107-005/019 | 统一 `[shim] <标记> installed` 文案与打印时机；补齐 `flock`/`sharp` 自检 | **planned**（F7/F8） |
| FR-107-006 | `uncaughtException`/`unhandledRejection` 只写日志 | implemented |
| FR-107-007/014 | 崩溃记录只读展示，不重启 | implemented |
| FR-107-008 | 日志不含凭据；补 `selfcheck` 的凭据扫描断言 | 部分（人工约束已满足，断言 planned） |
| FR-107-009/010 | `ready.json` 临时文件 + `rename`；仅 ready 带 token | implemented |
| FR-107-011/012 | 失败页展示阶段 + 原因 + 200 行日志尾；`copyOption` 一键复制 | implemented（日志尾仅 `node.log`，见 F4） |
| FR-107-013 | 就绪报告缺失/损坏 → `FAILED` 并附原因 | implemented（`DshRuntime.ets:127-135`、`readReady` 返回 null） |
| FR-107-015…018 | `selfcheck` stdout JSON + 退出码；缺失就绪报告视为通过 | implemented |
| FR-107-020…023 | `@dsh-ohos/facts` 行 + debug 开关 + 同源 Cookie | **planned**（F10 阻塞：debug-only 方式未定） |
| FR-107-024 | 单文件轮转与上限 | **planned**（F9） |
| FR-107-025 | 仅用户主动复制；无静默上报 | implemented |

**错误处理**

- `app.log` 不可写：降级 `process.stderr`，不抛（`bootstrap.js:40-43`）→ 由 `node.log` 兜底。
- 就绪报告写入失败：记一行日志后继续（`bootstrap.js:54-56`）→ ArkTS 侧最终归因为"未读到就绪报告"。
- 就绪报告半截/JSON 损坏：`readReady` 捕获异常返回 null → `FAILED` + 明确原因，不重试猜测。
- 事实端点：未授权 401、未知路径 404、release 构建不存在该路由；任何分支 MUST NOT 返回伪成功（C2）。
- 自检内部异常：记为该断言失败而非整体崩溃；仍输出 JSON 后退出非零。

---
## 7. 测试考虑
| 用例 | 覆盖 FR | 层 | 判据 |
|---|---|---|---|
| TC-107-001 业务日志含阶段/垫片/错误 | FR-107-003/005/006 | L0/L2 | `app.log` 片段 |
| TC-107-002 四通道互不覆盖 | FR-107-001/002 | L2 | 四份样本 |
| TC-107-003 事实端点仅调试可用 | FR-107-020/021 | L0/L2 | `curl` 结果（release 为 404/无路由） |
| TC-107-004 诊断不含凭据 | FR-107-008 | L0 | `grep -E "token|cookie"` 为空 |
| TC-107-005 自检全通过 | FR-107-015/016 | L0 | 退出码 0 + JSON |

**补充用例**：失败页日志尾必须包含 `app.log` 的业务阶段行（对应 F4 缺口）；垫片标记行与文档口径逐字一致（F8）；日志轮转后当前阶段不丢（FR-107-024）；事实端点返回体不含 `token`；`selfcheck` 在 `flock`/`sharp` 未物化时的结论必须是"显式失败 + 提示"而不是静默通过。

---
## 8. 文件清单
| 路径 | 状态 | 说明 |
|---|---|---|
| `payload/bootstrap.js` | implemented | `log()`、原子写就绪报告、异常兜底 |
| `payload/host.js` | implemented | `starting/ready/failed` 阶段与诊断 |
| `payload/selfcheck.js` | implemented（覆盖不足） | 3 条垫片探针 + 目录 + 就绪报告结构 |
| `payload/shims/fs-link.js` / `fs-symlink.js` / `sqlite.js` | implemented | 标记与探针来源（F8 待统一） |
| `payload/shims/flock.js` / `sharp.js` | implemented | 缺自检断言（FR-107-019 planned） |
| `entry/src/main/ets/app/DshRuntime.ets` | implemented | 阶段埋点、日志尾、崩溃记录、失败详情 |
| `entry/src/main/ets/common/Constants.ets` | implemented | hilog 常量、日志尾行数、路径派生 |
| `entry/src/main/ets/pages/Index.ets` | implemented | 失败页展示与一键复制 |
| `entry/src/main/ets/host/HostCapabilities.ets` | 需修改（planned） | `log.hilog` 已实现；`userDirs.available` 需改真实存在性 |
| `packages/facts-ohos/` | planned | `@dsh-ohos/facts`：`GET /_ohos/facts` 与 debug 开关 |
| `scripts/verify-logs.mjs` | planned | 日志标记/凭据/轮转的 L0 断言 |
