# 规格检查清单（SPECS_CHECKLIST.md）

> 工程：`dsh-desktop-ark`
> 需求：`000-scaffold`（工程搭建）
> 更新：2026-10-18
> 状态取值：`✅ Done`（已写且有源码/证据）｜`🟡 Partial`（部分实现/部分章节）｜`⬜ Planned`（仅设计）

---

## 一、根目录文档

| # | 文档 | 路径 | 状态 | 证据 / 说明 |
|---|---|---|---|---|
| P-01 | 文档索引 | [README.md](./README.md) | ✅ Done | 全部文档生成后扫描生成 |
| P-02 | 规格检查清单 | [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) | ✅ Done | 本文件 |
| P-03 | 目录结构 | [STRUCTURE.md](./STRUCTURE.md) | ✅ Done | 按 `find` 实际结果生成 |
| P-04 | 技术选型 | [TECH.md](./TECH.md) | ✅ Done | 版本锁定值来自 `runtime.lock.json` / CLT |
| P-05 | 整体架构 | [ARCHITECTURE.md](./ARCHITECTURE.md) | ✅ Done | 分层与状态机与代码一致 |
| P-06 | 宪法原则 | [constitution.md](./constitution.md) | ✅ Done | C1–C14，均可检查 |
| P-07 | 整体规格 | [overall-spec.md](./overall-spec.md) | ✅ Done | FR-APP/RUN/UI/CAP/DATA/DIAG/REL |
| P-08 | 整体技术方案 | [overall-plan.md](./overall-plan.md) | ✅ Done | 含宪法合规表 |
| P-09 | 数据模型 | [overall-data-model.md](./overall-data-model.md) | ✅ Done | `ReadyInfo` / 能力协议 / 信箱 |
| P-10 | 测试用例索引 | [overall-test-cases.md](./overall-test-cases.md) | ✅ Done | TC-101…108 + 门禁映射 |

> 按需求约定，不生成 `API.md` 与 `overall-api.md`。

---

## 二、模块文档

| # | 模块 | spec.md | plan.md | 状态 | 源码落点 |
|---|---|---|---|---|---|
| M-101 | 运行时启动编排 | [spec](./101-runtime-launch-orchestration/spec.md) | [plan](./101-runtime-launch-orchestration/plan.md) | 🟡 Partial | 代码完成；**L1 未取证**（无 `libnode.so`，真机待验） |
| M-102 | 载荷管线 | [spec](./102-payload-pipeline/spec.md) | [plan](./102-payload-pipeline/plan.md) | 🟡 Partial | 脚本与垫片完成；真实载荷（`dsh.tar.gz`）未生成 |
| M-103 | ArkWeb 外壳 | [spec](./103-arkweb-shell/spec.md) | [plan](./103-arkweb-shell/plan.md) | 🟡 Partial | 围栏/错误页已加；`onWindowNew`、`error.html` 未做 |
| M-104 | 宿主能力桥 | [spec](./104-host-capability-bridge/spec.md) | [plan](./104-host-capability-bridge/plan.md) | 🟡 Partial | `entry/src/main/ets/host/HostCapabilities.ets`（8 项占位） |
| M-105 | 上游适配层 | [spec](./105-upstream-adapter-bundle/spec.md) | [plan](./105-upstream-adapter-bundle/plan.md) | 🟡 Partial | `profiles/ohos/**`、`packages/bundle-ohos/**`；seam 插件未实现 |
| M-106 | 工作区选择 | [spec](./106-workspace-picker/spec.md) | [plan](./106-workspace-picker/plan.md) | ⬜ Planned | 设计见 `docs/000-工程规划.md` §5.2 |
| M-107 | 诊断与可观测 | [spec](./107-diagnostics-observability/spec.md) | [plan](./107-diagnostics-observability/plan.md) | 🟡 Partial | `payload/selfcheck.js`；`/_ohos/facts` 未实现 |
| M-108 | 合规与发布 | [spec](./108-compliance-release/spec.md) | [plan](./108-compliance-release/plan.md) | 🟡 Partial | `module.json5`、`build-profile.json5`、`hvigorfile.ts` |
| M-204 | 插件：GIT 操作（需求 204） | [spec](./204-plugin-git/spec.md) | [plan](./204-plugin-git/plan.md) | 🟡 Partial | `packages/git-ohos/**`（21 工具 + 设置页）、`scripts/assemble-payload.mjs` 的 `collectGitRuntime()`、`bundle-ohos` 一行、`scripts/set-inspect.mjs`；真机证据见 `logs/20261021-1/TEST_REPORT.md`（`/logs` 不入库） |
| M-205 | 插件：品牌位（需求 205） | [spec](./205-plugin-branding/spec.md) | [plan](./205-plugin-branding/plan.md) | ✅ Done | `packages/branding-ohos/**`（host 半边：标题 + `style` 行；browser 半边：三个品牌槽位 + 标题守卫）、`packages/bundle-ohos/cordis.patch.yml`（挂载行 + 首次引导两行配置 + `ui-brand-official` 禁用）、`scripts/verify-upstream.mjs` 的 6/7/8 号门禁；证据：`verify-upstream` / `smoke-payload` 通过、宿主 Node 端到端 14 项断言（zh-CN + en-US）+ 负向对照；真机未验 |

---

## 三、本轮（000-scaffold）验证证据

| 检查 | 命令 | 结果 | 证据位置 |
|---|---|---|---|
| 上游零补丁 | `node scripts/verify-upstream.mjs` | ✅ 通过（tag / clean / patch ids / profile / bundle） | 构建日志 |
| 载荷同步 | `node scripts/sync-payload.mjs` | ✅ 9 files / 26,074 bytes | `resfile/dsh-payload/dsh.version` |
| Node 侧自检 | `NODE_BRIDGE_PAYLOAD_ROOT=<dir> node --expose-internals payload/selfcheck.js` | ✅ 9/9（S1–S6、目录、ready） | 终端输出 |
| HAP 构建 | `hvigorw assembleHap --mode module -p product=default -p buildMode=debug` | ✅ BUILD SUCCESSFUL | `entry-default-unsigned.hap`（**44 MB**，含 libnode.so） |
| 运行时投放 | `provision.mjs --check` / `--out entry/libs/arm64-v8a --sdk <sdk>` | ✅ 七项门禁全过；SHA-256 命中 | `entry/libs/arm64-v8a/{libnode.so,libc++_shared.so}` |
| 代码评审 | `requesting-code-review` + `receiving-code-review` | 1 Critical + 7 Important 已修 | `logs/20261018-1/REVIEW_REPORT.md` |
| 未签名构建 | 无 `signing.*.local.json` / 环境变量 | ✅ 产出未签名包（预期） | 构建日志 |


## 三之二、真机调试证据（2026-10-19，HAD-W32 / API 26）

完整记录见 `docs/010-真机调试记录.md`。要点：

| 检查 | 判据 | 结果 |
|---|---|---|
| 签名装机 | `hdc install -r entry-default-signed.hap` | ✅ 安装成功（DevEco 生成的 debug profile） |
| G1 ArkWeb → loopback | 应用内渲染真实 DSH UI；`hdc fport` 复验 `303 → 200 / 36,988 B` | ✅ |
| G2 `node:sqlite` + FTS5 | 设备 `app.log`：`available=true fts5=true` | ✅ |
| G5 resfile 自解包 + sha | `tar-extract: 15124 files`；二次启动 marker 复用 | ✅ |
| G4 JIT（ACL） | 无 `--jitless` 不 SIGTRAP，服务正常起 | ✅ |
| 垫片 S6（`node-addon-require-builtin`） | `node-addon-require-builtin: installed=true` | ✅（新增） |
| 工作区选择器 + 对话 | RPC 修复后未复验（设备换成 phone 机型，装机被拒） | ⬜ |

**已取证（2026-10-19，真机 HAD-W32）**：G1 loopback、G2 `node:sqlite`+FTS5、G4 JIT ACL、G5 resfile 自解包 —— 见上「三之二」与 `docs/010-真机调试记录.md`。

**仍未验证**：G3 sh 哨兵、G6 pnpm in worker、G7 图像桥、G9 addon、G10 用户目录，以及工作区选择器与对话的端到端（设备侧未复验）。

---

## 四、缺口与后续需求

| 缺口 | 归属 | 建议需求编号 |
|---|---|---|
| `@dsh-ohos/*` seam 插件已落地 10 个包（本轮补 S6 与 picker 自实现），真机端到端仍待复验 | `104`/`106` | `001-adapters`（复验） |
| `/_ohos/facts` 端点 | `107` | `002-diagnostics` |
| 双发行线（standard / jitless） | `108` | `003-release` |
| 真实 dsh 载荷装配（pnpm deploy + 裁剪） | `102` | `004-payload` |

**已闭合（2026-10-18）**

- 运行时投放：`libnode.so`（126,809,264 B）+ `libc++_shared.so` 已投放至 `entry/libs/arm64-v8a/`，七项 ELF 门禁全过；HAP 由 818 KB 变为 44 MB（含运行时）。
- `ohos-node-runtime` 归属：已迁入 `ohos-node-bridge/runtime/`（本地缓存 + `SHA256SUMS` + 各版本 `PROVENANCE.md`；唯一事实源是 `runtime.lock.json`，2026-10-22 起随 `@fellow99/node-bridge` 包内 rawfile 分发）。

**已闭合（2026-10-22，依赖来源切换：旁路 submodule → ohpm 中心仓）**

- 上游库 `ohos-node-bridge` 已以双包发布到 OpenHarmony 三方库中心仓：`@fellow99/node-bridge@0.1.0`（API + NAPI 引导件）与 `@fellow99/node-runtime@24.2.0`（`libnode.so`，版本号 = Node 版本）。本工程改为常规 ohpm 依赖（`oh-package.json5`），删除 `scripts/build-bridge-har.sh`、`scripts/provision-runtime.sh` 与本地投放路径 `entry/libs/`、`libs/`。
- 构建证据：`bash scripts/build-hap.sh --debug` → `BUILD SUCCESSFUL`（30.5 s）；HAP ≈ 91.8 MB，含 `libs/arm64-v8a/{libnode.so,libnode_bridge.so,libnode_host_client.so,libc++_shared.so}`（`libc++_shared.so` 按路径去重仅一份）。
- 供应链证据：`ohpm install` 拉取的 `libnode.so` SHA-256 = `3019bf5f9a279d98a87606fc13c53b0e797b6a50cf174f8a1243d880c71151a1`，与随包 `runtime.lock.json` 锁值逐字一致。
- 真机证据（3QC0226526001227，HarmonyOS 6.1.x / 2in1）：全新安装启动后 `ready.json` `phase=ready`（0.2.1），5 个垫片安装、`node:sqlite`+FTS5 可用、jitless 自检 7/7、git 插件 21 工具注册、ArkWeb 渲染完整 dsh Web UI（新建会话/工作区/插件等，`uitest dumpLayout` + 截图取证）。


---

## 五、维护规则

1. 任何新增/删除模块目录，必须同步更新第二张表与 `STRUCTURE.md`。
2. 每次让状态从 `⬜` → `✅` 时，必须在第三节补一条可复现证据。
3. `planned` 的能力不得在 `overall-test-cases.md` 标为通过。

---

## 新增模块（本轮：012 / 201）

| # | 模块 | 文档 | 状态 | 证据 |
|---|---|---|---|---|
| M-012 | pnpm 集成 | `012-pnpm-integration/{spec,plan,tasks,test-cases}.md` | ✅ Done | `packages/market-ohos` + `scripts/assemble-payload.mjs`；单测 9/9；本机 `--jitless` 与真机安装/卸载闭环 |
| M-201 | 插件市场 | `201-dsh-market/{spec,plan,tasks,test-cases}.md` | ✅ Done（UI 点击部分待补） | `dshmarket@1.66.42` 随包；`/dsh-market/installed` 返回 `profile=ohos`；`/dsh-market/install|uninstall` 真机 200 |
| D-01 | 设计 | `../docs/pnpm+dsh-market.md` | ✅ Done | 设计评审 v2 放行（含 P12 undici 替身、R9 代理语义损失） |
