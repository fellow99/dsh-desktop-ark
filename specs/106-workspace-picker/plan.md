# 技术方案：工作区选择（106-workspace-picker）
> 工程：`dsh-desktop-ark`
> 状态：**全模块 planned**——插件包、客户端面、宿主侧根解析与授权门均不存在（本文件是实施依据，不是完成报告）
> 对应规格：`specs/106-workspace-picker/spec.md`（FR-106-001…032）
> 依据：`docs/000-工程规划.md` §5.2（含 `@dsh-ohos/workspace-picker` 专节）、§8.2、§14（D7/D8）；`../dsh-desktop-hos/docs/203-插件-选择工作区目录.md`；`specs/overall-plan.md` §3
> 需求语言遵循 RFC 2119。

---
## 1. 技术上下文
| 项 | 值 |
|---|---|
| 形态 | 单包双面（dual-face）：宿主面（Node）+ 客户端面（浏览器），经 `package.json#dsh.client` 声明 |
| 替换点 | 上游两个工作区目录流插槽（`conversation.hero.workspace.directoryFlow`、`sidebar.workspaces.directoryFlow`），单占位 |
| owner 契约 | open / busy / `onPicked(path)` / `onCancel()` / `onError(message)`（上游 ui-workspace 构造，见 `203` F1） |
| 后端原语 | 上游 browse 后端的列目录 / 建目录（Typert RPC，命名空间 `directoryPicker`） |
| 组合方式 | 禁用上游自动装配行 → 静态挂载 browse 原语行 → 挂本插件行（与 `105` 的 bundle patch 同一事务） |
| 宿主通道 | `@fellow99/node-bridge` 宿主桥能力名（JSON 进出、永不抛）；权限三动作复用 `104` 的 `perm.*` |
| 客户端状态 | 组件局部状态；仅主目录 id 持久化在浏览器本地存储（插件私有命名空间） |
| 宿主环境 | 沙箱工作区由应用文件目录派生；三个用户目录为固定绝对路径，授权是运行期事实 |

---
## 2. 宪法合规
| 原则 | 结论 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 只经插槽与后端原语；不改上游前端、不自实现文件系统（FR-106-030/031） |
| C2 平台真相不隐藏 | ⚠️ | 设计上"不可用即显示不可用、不回退"（FR-106-005）；但 `104` 当前把用户目录可用性判成"路径非空"（`HostCapabilities.ets:171-174`），实现前必须改成真实存在性检查，否则本模块会继承伪事实 |
| C3 证据优先 | ❌（当前） | 无实现、无截图、无 hilog；在实现并取证前，所有验收结论必须留空（FR 全 planned） |
| C4 单进程/单实例/随机端口 | ✅ | 不涉及进程或端口；对话框不触发重启 |
| C5 谁写谁读 | ✅ | 目录创建经后端原语；插件不直接写 Node 将读取的树 |
| C6 绝对路径 | ⚠️ | 所有路径由宿主以绝对路径下发；但用户根当前有三处硬编码（`Constants.ets:33`、`DshRuntime.ets:110`、bundle patch 的 `userRoot`），实现前需收敛为单一来源 |
| C7 垫片可审计 | ✅ | 不新增垫片；不使用链接 |
| C8 异常兜底 | ✅ | 宿主面处理器返回结构化错误，不抛异常（沿用 `104` 纪律） |
| C9 鉴权只在 Host | ✅ | 对话框只走同源 RPC；不接触 token/cookie |
| C10 权限最小化 | ✅ | 授权按打开/切换触发，不冷启批量弹窗（FR-106-024） |
| C11 秘密不入库 | ✅ | 不涉及凭据；日志不打目录内容清单 |
| C12 编号即契约 | ⚠️ | 规范目录已建，但 `packages/workspace-picker-ohos/` 与代码侧入口尚不存在；C12 的"目录 ↔ 实现"检查在实现前必然失败（与 C14 的 planned 标注一致） |
| C13 可复现 | ✅ | 纯 JS/TS 文本包，无二进制；依赖由载荷物化 |
| C14 状态标注 | ✅ | 本模块 spec 与 plan 全篇标 planned，无"已实现"表述 |

---
## 3. 研究结论
- **F1 插槽与组合确认**：上游 browse 客户端面在 `deepseek-harness/packages/client/ui-directory-picker-browse/src/client/index.ts:86-94` 注入两个 hole，名称与 `203` §2 一致；两个 hole 可被单包同时占用。
- **F2 后端原语确认**：`deepseek-harness/packages/api/workspace-controller/src/directory-picker.ts:87-93` 暴露 `createDirectory`；`packages/host/directory-picker-browse/src/index.ts:202,299` 提供 `list` / `createDirectory` 实现；本模块只需组装，不需新增 FS 代码。
- **F4 宿主能力缺口（阻塞项）**：`entry/src/main/ets/host/HostCapabilities.ets:96-113` 只注册了 `runtime.facts`、`log.hilog`、`perm.*`、`shell.openExternal` 与若干 `not-implemented` 占位；**没有**根解析、列目录、建目录能力。`104` 必须新增（能力名建议 `fs.roots` / `fs.list` / `fs.createDirectory`），并同步 `specs/104-*/spec.md` 的冻结清单与 `overall-data-model.md` §4.3。
- **F5 可用性判定是伪事实**：`HostCapabilities.ets:171-174` 的 `exists()` 仅判 `path.length > 0`；`RuntimeFacts.userDirs[].available` 因此在真机上恒为 true。这与 `overall-data-model.md` §5"只报存在性（stat）"冲突，必须在实现 106 前修正（否则 FR-106-005 无法验收）。
- **F6 主目录集合不一致**：`packages/bundle-ohos/cordis.patch.yml` 的 `workspace-picker.config.roots` 只列 `desktop/documents/download`，沙箱根另由 `sandboxRoot` 传入；插件必须以"sandbox + 三个用户目录"为四元组，且 id 集合固定（FR-106-001/028）。
- **F7 用户根硬编码**：`userRoot: /storage/Users/currentUser` 与 `DSH_OHOS_USER_ROOT`（`DshRuntime.ets:110`）重复；实现时应读环境变量，避免三处同步。
- **F8 沙箱根一致**：`Constants.workspaceRoot()`（`Constants.ets:67-69`）与 `ensureDirs()`（`:81-97`）已创建 `<filesDir>/workspace`，与 `203` FR-2.1 的语义一致；本模块只需在打开对话框时再检查一次。
- **F9 记忆口径**：`203` FR-7.1–7.3 明确"只记忆主目录、不记子路径、非法值回退沙箱"，与 FR-106-026…028 完全对应；上游无对应机制，必须由本插件自持。
- **F10 条目上限**：`203` F3 记录后端默认 1000 条上限、超限只提示不分页；该数字未在本仓库复测，实现时以实测为准，规格只约束"必须提示截断"（FR-106-014）。

### 3.1 与 `203` 文档的对应关系
| 本规格 | `203` 来源 | 备注 |
|---|---|---|
| FR-106-001 / 012 / 028 | FR-1.1 / FR-1.2 / FR-1.3、FR-7.3 | 四标签、切换重置、非法值回退 |
| FR-106-003 / 004 / 005 / 006 | FR-2.1 / FR-2.2 / FR-2.3 | 沙箱 mkdir、固定用户路径、不可用不回退 |
| FR-106-007…014 | FR-3.1…3.5、§8 | Miller 列、只列目录、隐藏项、面包屑截断、无路径输入、截断提示 |
| FR-106-015…017 | FR-4.1…4.3 | 新建文件夹与默认名去重 |
| FR-106-018…020 | FR-5.1…5.3 | 采纳与取消 |
| FR-106-021…025 | FR-6.1…6.3、§10 | 授权门三动作与按需申请 |
| FR-106-026…028 | FR-7.1…7.3 | 记忆 |
| FR-106-029 / 030 / 031 | §8 根围栏、§6 结论 B、§12 | 围栏、复用原语、禁 auto + 独占两洞 |
| FR-106-032 | §11 错误处理 | 浏览失败在对话框内消化 |
| AC-106-01…08 | AC-1…AC-9 | 一一对应（AC-10/AC-11 见 §7） |

---
## 4. 数据模型
```jsonc
// RootDescriptor（四个，id 固定）
{ "id": "sandbox|desktop|documents|download", "label": "沙箱|桌面|文档|下载",
  "path": "/abs/path", "exists": true, "grant": "unknown|granted|denied" }

// DirectoryListing（直接沿用后端返回，不改语义）
{ "path": "/abs", "home": "/abs", "crumbs": ["/abs"], "entries": [{ "name": "sub", "kind": "dir" }], "truncated": false }

// BrowserState（客户端局部状态，不持久化）
{ "rootId": "desktop", "columns": ["/abs", "/abs/sub"], "selection": "/abs/sub/leaf", "busy": false }

// PickerMemory（唯一持久化项）
{ "rootId": "sandbox" }

// PickResult / PickerFailure
{ "ok": true, "result": { "path": "/abs/chosen" } }
{ "ok": false, "error": "root-unavailable|not-authorized|create-exists|create-failed|unreadable|truncated", "hint": "…" }
```

规则：`rootId` 只允许四个固定值；`columns[0]` MUST 等于当前主目录根；`selection` 为空时采纳 `columns[last]`；错误码为封闭集合，新增须同步 spec 与 `104`。

---
## 5. 接口契约
### Provided（本模块对外）
| 契约 | 形态 | 消费者 |
|---|---|---|
| 两个插槽的占位实现 | 实现 owner 契约的组件树 | 上游 ui-workspace（hero 与侧栏两个入口） |
| 选择结果 | `onPicked(绝对路径)` | 上游既有工作区创建链路 |
| 取消 | `onCancel()` | 上游流程收尾 |
| 持久化键 | 插件私有命名空间 + 主目录 id | 自身（下次打开） |
| 宿主能力（新增） | `fs.roots` / `fs.list` / `fs.createDirectory` 的 JSON 信封 | 插件宿主面 |

### Consumed（本模块依赖）
| 契约 | 来源 | 备注 |
|---|---|---|
| `directoryPicker.list` / `createDirectory` | 上游 browse 后端（`api/workspace-controller`） | 唯一文件系统访问通道 |
| `uiWorkspace` 采纳链路 | 上游 ui-workspace | 不改采纳语义 |
| `perm.check` / `perm.request` / `perm.openAppInfo` | `104` 已 implemented | 授权门三动作 |
| 沙箱根与用户目录根 | `101`（`Constants` + 启动环境变量） | 需收敛为单一来源（F7） |
| 浏览器本地存储 | ArkWeb | 仅存主目录 id |
| 文案命名空间 | 上游 locale | 插件私有 key |

---
## 6. 实现策略（含错误处理）
| 阶段 | 内容 | 覆盖 FR | 状态 |
|---|---|---|---|
| P1 | `104` 增补根解析 / 列目录 / 建目录能力，并修 `exists()` 为真实 stat | FR-106-003/005/030 | planned |
| P2 | 宿主面：四根解析（沙箱 ensure）、转发后端原语、错误码归一 | FR-106-001/004/006/013/014 | planned |
| P3 | 客户端面：RootTabs → MillerBrowser → NewFolderModal → PermissionGate → Flow | FR-106-007…020 | planned |
| P4 | 插槽注册事务（两洞一次注册）、记忆、围栏断言 | FR-106-026…031 | planned |
| P5 | 与 `105` 的 bundle patch 同事务启用：禁 auto 行、插原语行与本插件行 | FR-106-031 | planned |

**错误处理**

| 场景 | 表现 | 约束 |
|---|---|---|
| 主目录不可读（非授权） | 内容区就地提示 + 重试，不关闭对话框 | 不驱动 owner 的 `onError`（FR-106-032） |
| 未授权 | 预检 → 申请 → 成功自动重试 | 忙碌态禁止并发操作（FR-106-022） |
| 拒绝授权 | 原因 + "打开应用信息" + 手动重试 | 不静默（FR-106-023） |
| 新建同名 | 输入态提示冲突，可改名 | 不覆盖既有目录（FR-106-016） |
| 根解析失败 | 该标签显示不可用，不回退 | FR-106-005 |
| 条目超限 | 截断提示 | FR-106-014 |
| 桥不可用 | 明确归因 + 重试 | 不假装成功（C2） |

---
## 7. 测试考虑
| 用例 | 覆盖 FR | 层 | 判据 |
|---|---|---|---|
| TC-106-001 四 Tab 渲染 | FR-106-001/002 | L2 | 截图 |
| TC-106-002 沙箱根重建 | FR-106-003 | L2 | 截图 + 目录存在 |
| TC-106-003 用户目录缺失不回退 | FR-106-005 | L2 | 截图（显示不可用） |
| TC-106-004 面包屑不可上溯 | FR-106-010/029 | L2 | 操作序列 |
| TC-106-005 无路径输入 | FR-106-011 | L2 | 截图 |
| TC-106-006 未授权就地授权 | FR-106-021…025 | L2 | 截图 + hilog |
| TC-106-007 只记忆主目录 | FR-106-026…028 | L2 | 重开截图 |
| TC-106-008 选中被采纳 | FR-106-018/019 | L2 | 会话创建成功 |

**补充（对齐 `203`）**：AC-10（启动后无重复插槽/服务报错）、AC-11（物化断言通过，不改收集脚本）、根围栏负例（构造外部路径必须被拒）、记忆非法值回退、`truncated` 提示。全部依赖真机与已完成实现，当前均为 pending；`203` §17 的分层（构建期 / `--inspect` / 真机交互 / 回归）可直接沿用。

---
## 8. 文件清单
| 路径 | 状态 | 说明 |
|---|---|---|
| `packages/workspace-picker-ohos/package.json` | planned | 包名 `@dsh-ohos/workspace-picker`，声明 `dsh.client` |
| `packages/workspace-picker-ohos/lib/index.js` | planned | 宿主面：根解析、原语转发、错误归一 |
| `packages/workspace-picker-ohos/lib/client.js` | planned | 客户端面：五组件 + 两洞注册事务 + 记忆 |
| `packages/workspace-picker-ohos/README.md` | planned | 根围栏语义与已知限制 |
| `entry/src/main/ets/host/HostCapabilities.ets` | 需扩展（planned） | 新增 `fs.roots` / `fs.list` / `fs.createDirectory`；修 `exists()` |
| `entry/src/main/ets/common/Constants.ets` | implemented（可复用） | `USER_ROOT` / `USER_DIRS` / `workspaceRoot()` 已存在 |
| `entry/src/main/ets/app/DshRuntime.ets` | implemented（可复用） | 已注入 `DSH_OHOS_USER_ROOT`（`:110`） |
| `packages/bundle-ohos/cordis.patch.yml` | 需修改（planned） | 修 `userRoot` 取环境变量、明确四根 id 集合 |
| `specs/overall-data-model.md` | 需更新（planned） | §4.3 能力清单与 §5 `userDirs` 语义 |
