# 规格文档索引（specs/README.md）

**项目名称：** DSH Desktop（Ark 版） · `dsh-desktop-ark`
**版本：** 0.2.1（`versionCode` 201）
**上游基线：** `deepseek-harness` `dsh-v0.2.1-rc.2` ｜ 运行时 Node **v24.2.0**（`ohos-node-bridge` HAR）
**技术栈：** ArkTS / ArkUI（Stage）· ArkWeb · 进程内 `libnode.so`（`node::Start`）· dsh Host（HTTP + WebSocket）
**文档生成时间：** 2026-10-18 ｜ **最后更新：** 2026-10-18 ｜ **对应需求：** `000-scaffold`

---

## 一、文档总览

| 层级 | 分类 | 文档数量 | 说明 |
|---|---|---|---|
| 整体 | 项目级顶层文档 | 6 | 索引、清单、结构、技术、架构、宪法 |
| 整体 | 整体规格文档 | 4 | `overall-*` 系列 |
| 模块 | 运行时与外壳（101–104、109） | 10 | 每个模块 `spec.md` + `plan.md` + `tasks.md` + `test-cases.md` |
| 模块 | 适配与发布（105–108） | 8 | 每个模块 `spec.md` + `plan.md` |
| 模块 | 插件（204、205） | 6 | `204` 四份（spec/plan/tasks/test-cases）；`205` 两份（spec/plan） |
| 模块 | 市场与 pnpm（012、201） | 8 | 两模块各四份（spec/plan/tasks/test-cases）；实现见 `docs/pnpm+dsh-market.md` |
| **合计** | **10 根文件 / 13 模块目录 / 44 文件** | | |

> 按需求约定，不生成 `API.md` 与 `overall-api.md`。

---

## 二、项目级顶层文档

| 文档 | 路径 | 说明 |
|---|---|---|
| **文档索引** | [README.md](./README.md) | 本文件 |
| **检查清单** | [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) | 文档完成度与本轮验证证据 |
| **项目结构** | [STRUCTURE.md](./STRUCTURE.md) | 目录、模块映射、生成物规则 |
| **技术选型** | [TECH.md](./TECH.md) | 版本锁定值与否决项 |
| **整体架构** | [ARCHITECTURE.md](./ARCHITECTURE.md) | 分层、进程模型、时序、状态机 |
| **宪法原则** | [constitution.md](./constitution.md) | C1–C14，均可检查 |

### 整体规格文档

| 文档 | 路径 | 说明 |
|---|---|---|
| **整体规格** | [overall-spec.md](./overall-spec.md) | `FR-APP/RUN/UI/CAP/DATA/DIAG/REL` |
| **整体方案** | [overall-plan.md](./overall-plan.md) | 模块策略、宪法合规、交付流程 |
| **数据模型** | [overall-data-model.md](./overall-data-model.md) | `ReadyInfo`、能力协议、信箱、载荷版本 |
| **测试用例索引** | [overall-test-cases.md](./overall-test-cases.md) | `TC-101…108` + 门禁 G1–G10 映射 |

---

## 三、运行时与外壳（101–104）

### 101 — 运行时启动编排（Runtime Launch Orchestration）

> 从投递 Node 到 `loadUrl` 的状态机、探活与失败诊断。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [101-runtime-launch-orchestration/spec.md](./101-runtime-launch-orchestration/spec.md) | `FR-101-*` |
| 技术方案 | [101-runtime-launch-orchestration/plan.md](./101-runtime-launch-orchestration/plan.md) | 状态机、重试、失败路径 |

### 102 — 载荷管线（Payload Pipeline）

> `payload/` → resfile → Node 自解包；五条平台垫片与幂等。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [102-payload-pipeline/spec.md](./102-payload-pipeline/spec.md) | `FR-102-*` |
| 技术方案 | [102-payload-pipeline/plan.md](./102-payload-pipeline/plan.md) | ustar、sha 对账、垫片清单 |

### 103 — ArkWeb 外壳（ArkWeb Shell）

> ArkWeb 配置矩阵、导航围栏、加载/错误覆盖层与退出语义。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [103-arkweb-shell/spec.md](./103-arkweb-shell/spec.md) | `FR-103-*` |
| 技术方案 | [103-arkweb-shell/plan.md](./103-arkweb-shell/plan.md) | Web 属性、回调、页面状态 |

### 104 — 宿主能力桥（Host Capability Bridge）

> 14 个冻结能力名、JSON 信封、`not-implemented` 纪律。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [104-host-capability-bridge/spec.md](./104-host-capability-bridge/spec.md) | `FR-104-*` |
| 技术方案 | [104-host-capability-bridge/plan.md](./104-host-capability-bridge/plan.md) | 能力表、错误码、信箱 |

---

## 四、适配与发布（105–108）

### 105 — 上游适配层（Upstream Adapter Bundle）

> `ohos` profile + `@dsh-ohos/bundle` 的 YAML patch 层与 seam 插件规划。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [105-upstream-adapter-bundle/spec.md](./105-upstream-adapter-bundle/spec.md) | `FR-105-*` |
| 技术方案 | [105-upstream-adapter-bundle/plan.md](./105-upstream-adapter-bundle/plan.md) | patch 操作、id 清单、契约门禁 |

### 106 — 工作区选择（Workspace Picker）

> 四主目录（沙箱/桌面/文档/下载）、根围栏、授权门；**当前为 planned**。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [106-workspace-picker/spec.md](./106-workspace-picker/spec.md) | `FR-106-*`（全 planned） |
| 技术方案 | [106-workspace-picker/plan.md](./106-workspace-picker/plan.md) | 与 `203` 文档逐条对应 |

### 107 — 诊断与可观测（Diagnostics & Observability）

> 四通道日志、`selfcheck`、崩溃记录；`/_ohos/facts` 为 planned。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [107-diagnostics-observability/spec.md](./107-diagnostics-observability/spec.md) | `FR-107-*` |
| 技术方案 | [107-diagnostics-observability/plan.md](./107-diagnostics-observability/plan.md) | 通道落点、证据口径 |

### 108 — 合规与发布（Compliance & Release）

> ACL 声明面、签名注入、双发行线、包体预算。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [108-compliance-release/spec.md](./108-compliance-release/spec.md) | `FR-108-*` |
| 技术方案 | [108-compliance-release/plan.md](./108-compliance-release/plan.md) | 权限基线、构建参数 |

### 109 — 无 JIT 模式（JIT-less / compat）

> 编译期形态开关（默认 `compat`）、纯 JS `fetch` 兼容层、零 ACL 声明面。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [109-jitless/spec.md](./109-jitless/spec.md) | `FR-109-*` |
| 技术方案 | [109-jitless/plan.md](./109-jitless/plan.md) | 形态常量、兼容层、切换脚本 |
| 任务分解 | [109-jitless/tasks.md](./109-jitless/tasks.md) | `T-109-*` |
| 测试用例 | [109-jitless/test-cases.md](./109-jitless/test-cases.md) | `TC-109-*` |

### 204 — 插件：GIT 操作（Git Plugin）

> 设备没有 `git` 二进制：把纯 JS 的 isomorphic-git 嵌入宿主进程，交付 21 个 git 工具 + 「Git 凭据」设置页。
> 与 `../dsh-desktop-hos/specs/204-plugin-git/` 同源（行为契约一致，差异只在装配面：包名 / 物化落点 / 挂载行 / 调试通道）。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [204-plugin-git/spec.md](./204-plugin-git/spec.md) | `FR-204-*` / `AC-204-*` |
| 技术方案 | [204-plugin-git/plan.md](./204-plugin-git/plan.md) | 挂载面、依赖物化、围栏、凭据、`--inspect` |
| 任务分解 | [204-plugin-git/tasks.md](./204-plugin-git/tasks.md) | `T-204-*` |
| 测试用例 | [204-plugin-git/test-cases.md](./204-plugin-git/test-cases.md) | `TC-204-*`（含脱敏纪律） |

### 012 — pnpm 集成（PNPM Integration）

> 随包物化纯 JS `pnpm@10.34.6`，在进程内 worker 线程执行；提供市场的 `desktopProfiles` / `desktopPnpm` 契约。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [012-pnpm-integration/spec.md](./012-pnpm-integration/spec.md) | `FR-012-*` |
| 技术方案 | [012-pnpm-integration/plan.md](./012-pnpm-integration/plan.md) | 落点映射、worker 约束 |
| 任务分解 | [012-pnpm-integration/tasks.md](./012-pnpm-integration/tasks.md) | `T-012-*` |
| 测试用例 | [012-pnpm-integration/test-cases.md](./012-pnpm-integration/test-cases.md) | `TC-012-*` |

### 201 — 插件市场（dsh-market）

> 内置 `dshmarket@1.66.42`（+ 纯 JS undici 替身），profile 追加 bundle 行；安装/卸载走 012 的进程内通道。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [201-dsh-market/spec.md](./201-dsh-market/spec.md) | `FR-201-*` |
| 技术方案 | [201-dsh-market/plan.md](./201-dsh-market/plan.md) | 物化顺序、加载链路 |
| 任务分解 | [201-dsh-market/tasks.md](./201-dsh-market/tasks.md) | `T-201-*` |
| 测试用例 | [201-dsh-market/test-cases.md](./201-dsh-market/test-cases.md) | `TC-201-*` |

### 205 — 插件：品牌位（Branding Plugin）

> 把 dsh Web UI 的产品身份换成本产品（侧栏 logo/名称、会话空态 hero 品牌位、页面/窗口标题），并关闭上游的预览提示与 DeepSeek 首次配置**自动**弹窗。
> **上游零补丁**：只用槽位、自有 locale 命名空间、`webServer.tapIndex`、`webserver/index-inject` 的 `style` 行与上游两条配置项；Electron 版的 `dsh-rebrand` / `dsh-disable-welcome-notice` 补丁**不复用**。

| 文档 | 链接 | 说明 |
|---|---|---|
| 功能规格 | [205-plugin-branding/spec.md](./205-plugin-branding/spec.md) | `FR-205-*` / `AC-205-*` / `NFR-205-*` |
| 技术方案 | [205-plugin-branding/plan.md](./205-plugin-branding/plan.md) | 上游口子、隐藏规则锚点、标题守卫、门禁与降级 |

---

## 五、模块编号一览

| 编号 | 模块名 | 英文名 | 分类 |
|---|---|---|---|
| 101 | 运行时启动编排 | Runtime Launch Orchestration | 运行时 |
| 102 | 载荷管线 | Payload Pipeline | 运行时 |
| 103 | ArkWeb 外壳 | ArkWeb Shell | 界面 |
| 104 | 宿主能力桥 | Host Capability Bridge | 能力 |
| 105 | 上游适配层 | Upstream Adapter Bundle | 适配 |
| 106 | 工作区选择 | Workspace Picker | 适配 |
| 107 | 诊断与可观测 | Diagnostics & Observability | 工程 |
| 108 | 合规与发布 | Compliance & Release | 发布 |
| 109 | 无 JIT 模式 | JIT-less (compat) | 运行时 |
| 204 | 插件：GIT 操作 | Git Plugin | 插件（需求 204，规格在本工程而非父工程） |
| 205 | 插件：品牌位 | Branding Plugin | 插件（需求 205，logo / 标题替换 + 首次引导自动弹窗关闭） |
| 012 | pnpm 集成 | PNPM Integration | 运行时（随包纯 JS pnpm + 进程内调用） |
| 201 | 插件市场 | dsh-market | 插件（需求 201，市场安装/卸载走 012） |

---

## 六、模块文档结构规范

每个模块目录 `NNN-<module>-<submodule>/` 至少包含：

| 文件 | 说明 |
|---|---|
| `spec.md` | 功能规格：用户故事、`FR-*`、验收场景、NFR、依赖（不含实现细节） |
| `plan.md` | 技术方案：技术上下文、宪法合规、数据模型、接口契约、实现策略、文件清单 |

> 约定：`plan.md` 必须交叉引用 `spec.md` 的 `FR-*`；未实现的能力标 `planned` / `not-implemented`（C14）。

---

## 七、快速导航

| 目标读者 | 推荐阅读顺序 |
|---|---|
| 新加入开发者 | `constitution.md` → `STRUCTURE.md` → `overall-spec.md` → 模块 `spec.md` |
| 架构师 | `ARCHITECTURE.md` → `TECH.md` → `overall-plan.md` → `docs/000-工程规划.md` |
| 宿主/外壳开发 | `101` → `103` → `104` |
| 载荷/构建开发 | `102` → `105` → `108` |
| 测试 / QA | `overall-test-cases.md` → `SPECS_CHECKLIST.md` → 各模块 `plan.md` §测试考虑 |
| 产品经理 | `overall-spec.md` → 各模块 `spec.md` |

---

**文档维护者：** `dsh-desktop-ark` 开发团队
