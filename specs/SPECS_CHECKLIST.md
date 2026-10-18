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

---

## 三、本轮（000-scaffold）验证证据

| 检查 | 命令 | 结果 | 证据位置 |
|---|---|---|---|
| 上游零补丁 | `node scripts/verify-upstream.mjs` | ✅ 通过（tag / clean / patch ids / profile / bundle） | 构建日志 |
| 载荷同步 | `node scripts/sync-payload.mjs` | ✅ 9 files / 26,074 bytes | `resfile/dsh-payload/dsh.version` |
| Node 侧自检 | `NODE_BRIDGE_PAYLOAD_ROOT=build/selfcheck node payload/selfcheck.js` | ✅ 7/7（S1–S5、目录、ready） | 终端输出 |
| HAP 构建 | `hvigorw assembleHap --mode module -p product=default -p buildMode=debug` | ✅ BUILD SUCCESSFUL | `entry/build/default/outputs/default/entry-default-unsigned.hap`（818 KB） |
| 代码评审 | `requesting-code-review` + `receiving-code-review` | 1 Critical + 7 Important 已修 | `logs/20261018-1/REVIEW_REPORT.md` |
| 未签名构建 | 无 `signing.*.local.json` / 环境变量 | ✅ 产出未签名包（预期） | 构建日志 |

**未验证（需真机 + 运行时二进制）**：G1 loopback、G3 sh 哨兵、G4 JIT ACL、G5 resfile 自解包、G6 pnpm in worker、G7 图像桥、G9 addon、G10 用户目录。

---

## 四、缺口与后续需求

| 缺口 | 归属 | 建议需求编号 |
|---|---|---|
| `libnode.so` 未投放（HAP 不含运行时） | `102` | 在构建机执行 `provision.mjs --download` |
| `@dsh-ohos/*` 8 个 seam 插件未实现 | `105`/`106` | `001-adapters` |
| `/_ohos/facts` 端点 | `107` | `002-diagnostics` |
| 双发行线（standard / jitless） | `108` | `003-release` |
| 真实 dsh 载荷装配（pnpm deploy + 裁剪） | `102` | `004-payload` |
| `ohos-node-runtime` 工程不存在 | 跨工程 | 需用户确认该工程归属 |

---

## 五、维护规则

1. 任何新增/删除模块目录，必须同步更新第二张表与 `STRUCTURE.md`。
2. 每次让状态从 `⬜` → `✅` 时，必须在第三节补一条可复现证据。
3. `planned` 的能力不得在 `overall-test-cases.md` 标为通过。
