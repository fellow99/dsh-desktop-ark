# 测试用例索引（overall-test-cases.md）

> 工程：`dsh-desktop-ark`｜版本：v0.2（`000-scaffold` + `109-jitless`）｜更新：2026-10-20
> 本文件是**索引**：只给编号、验证点、执行层、证据形式与**明细位置**；用例正文在模块 `spec.md` §5（或
> `109` 的 `test-cases.md`）。**执行结果**统一记在 §14，不在每条用例里重复。

---

## 1. 用例编号规则

```
TC-<模块号>-<序号>       例：TC-101-003
AC-<模块号>-<序号>       验收场景（spec §5 的标题），与 TC 一对一或多对一
```

- 模块号与 `specs/NNN-*` 目录一致（`101`–`109`）。
- 序号在模块内单调递增，不复用；新增用例 MUST 同步本索引的「模块明细」表。

## 2. 分层与证据

| 层 | 触发 | 执行方式 | 通过判据 |
|---|---|---|---|
| L0 单元/构建 | 每次改动 | `node <pkg>/test/smoke.mjs`、`scripts/*.mjs`、`hvigorw assembleHap` | 退出码 0 + 产物存在 |
| L1 装机 | 每次发版 | `hdc install/aa start` | 进程存活 + `ready.json` |
| L2 功能 | 每次发版 | `uitest` 操作 + 截图 / loopback HTTP | 用例逐条通过 |
| L3 性能 | 里程碑 | 计时 + 基线对比 | 退化 ≤ 20% |
| L4 合规 | 上架前 | 清单核对 | 全绿 |

证据落到 `logs/<YYYYMMDD>-N/`（`/logs` 已 gitignore）。**禁止**作为判据：`uitest dumpLayout`、单条 hilog、
「目录存在」、「看起来生效」。

---

## 3. 模块明细引用（本索引 → 用例正文）

| 模块 | 用例正文（明细） | 验收场景 | 用例数 | 实现状态 |
|---|---|---|---|---|
| 101 运行时启动编排 | [spec.md §5](./101-runtime-launch-orchestration/spec.md#5-验收场景) | AC-101-* | 7 | implemented |
| 102 载荷管线 | [spec.md §5](./102-payload-pipeline/spec.md#5-验收场景) | AC-102-* | 7 | implemented |
| 103 ArkWeb 外壳 | [spec.md §5](./103-arkweb-shell/spec.md#5-验收场景) | AC-103-* | 7 | implemented |
| 104 宿主能力桥 | [spec.md §5](./104-host-capability-bridge/spec.md#5-验收场景) | AC-104-* | 8 | partial（6 能力可用，8 项 not-implemented） |
| 105 上游适配层 | [spec.md §5](./105-upstream-adapter-bundle/spec.md#5-验收场景) | AC-105-01…06 | 7 | implemented |
| 106 工作区选择 | [spec.md §5](./106-workspace-picker/spec.md#5-验收场景) | AC-106-01…08 | 8 | implemented（**三根**：桌面已移除） |
| 107 诊断与可观测 | [spec.md §5](./107-diagnostics-observability/spec.md#5-验收场景) | AC-107-01…06 | 5 | partial（`/_ohos/facts` 未做） |
| 108 合规与发布 | [spec.md §5](./108-compliance-release/spec.md#5-验收场景) | AC-108-01…07 | 7 | partial（双线由 109 提供） |
| 109 无 JIT 模式 | [test-cases.md](./109-jitless/test-cases.md) | FR-109-* | 12 | implemented（本机 + 真机双形态） |

> 引用约定：表格里的用例编号与 `spec.md` §5 的 `### TC-…` 标题**逐字一致**；`109` 的正文在独立
> `test-cases.md`（含步骤与期望），`spec.md` §6 只保留索引摘要。

---

## 4. 模块 101：运行时启动编排

> 明细：[spec.md §5](./101-runtime-launch-orchestration/spec.md#5-验收场景)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-101-001 | 冷启动后 60 s 内进入 `READY`（载荷存在时） | L1/L2 | `ready.json` + 截图 |
| TC-101-002 | 载荷缺失时进入 `payload-missing`，错误页可复制诊断 | L2 | 截图 + `app.log` |
| TC-101-003 | `ready.json` 原子写、字段合法（`url`/`token` 只在 ready） | L0/L2 | `ready.json` 样本 |
| TC-101-004 | 探活失败（端口不可达）时进入 `FAILED` 且带 HTTP 结果 | L2 | 截图 + 日志 |
| TC-101-005 | 启动超时（60 s）后不挂起，进入 `FAILED` | L2 | 日志时间戳 |
| TC-101-006 | 「重启应用」按钮可回到可重试状态 | L2 | 截图序列 |
| TC-101-007 | Node 崩溃后不再自动重启，展示崩溃记录 | L2 | `last-crash.json` |

## 5. 模块 102：载荷管线

> 明细：[spec.md §5](./102-payload-pipeline/spec.md#5-验收场景)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-102-001 | `dsh.version` 首行 sha256 → marker `.ready-<sha12>` | L0 | marker 路径 |
| TC-102-002 | 重复启动跳过解包（幂等） | L0/L2 | 两次启动耗时对比 |
| TC-102-003 | 归档损坏时失败并保留旧版本指针 | L0 | 脚本退出码 |
| TC-102-004 | 垫片全部安装且日志各有一行标记（S1–S6） | L0/L2 | `app.log` grep |
| TC-102-005 | `fs.link` 在 EACCES 下回退 `rename` | L0 | `selfcheck` 输出 |
| TC-102-006 | `uncaughtException` 不导致进程退出 | L2 | 注入异常后应用仍在 |
| TC-102-007 | 归档内路径穿越（`../`）被拒绝 | L0 | 解包脚本报错 |

## 6. 模块 103：ArkWeb 外壳

> 明细：[spec.md §5](./103-arkweb-shell/spec.md#5-验收场景)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-103-001 | 首屏加载 `boot.html`，就绪后 `loadUrl` 成功 | L2 | 截图 |
| TC-103-002 | `domStorageAccess` 开启（`localStorage` 非 null） | L2 | 页面 JS 断言 |
| TC-103-003 | 加载结束清理历史，返回键不卡在启动页 | L2 | 操作序列截图 |
| TC-103-004 | 导航到非 loopback 地址被拦截 | L2 | 拦截回调日志 |
| TC-103-005 | 外部 https 链接交给系统浏览器 | L2 | 系统浏览器截图 |
| TC-103-006 | 页面加载失败显示错误覆盖层而非白屏 | L2 | 截图 |
| TC-103-007 | 页面权限清单与实现一致 | L0 | `module.json5` + 代码 grep |

## 7. 模块 104：宿主能力桥

> 明细：[spec.md §5](./104-host-capability-bridge/spec.md#5-验收场景)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-104-001 | `runtime.facts` 返回合法 JSON 且路径全为绝对路径 | L0/L2 | JSON 样本 |
| TC-104-002 | 未注册能力返回 `unregistered` | L0 | 调用输出 |
| TC-104-003 | 已注册未实现能力返回 `not-implemented` + `hint` | L0 | 调用输出 |
| TC-104-004 | `perm.check` 对已声明/未声明权限分别返回布尔 | L2 | JSON |
| TC-104-005 | `log.hilog` 可在 hilog 中检索到 | L2 | hilog 片段 |
| TC-104-006 | 处理器内部异常映射为 `internal`，不抛出 | L0 | 注入异常用例 |
| TC-104-007 | 超过 8 MiB 的载荷被拒绝 | L0 | 调用输出 |
| TC-104-008 | 请求串行分发、陈旧请求被回收 | L0 | 信箱目录 + 时间戳 |

## 8. 模块 105：上游适配层

> 明细：[spec.md §5](./105-upstream-adapter-bundle/spec.md#5-验收场景)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-105-001 | `profiles/ohos/package.json` 可被上游 `loadProfileDirectory` 解析 | L0 | 脚本输出 |
| TC-105-002 | bundle patch 覆盖的每个 id 在上游 patch 中存在 | L0 | `verify-upstream.mjs` |
| TC-105-003 | `hmr` 被禁用；`subprocess`/`sandbox` 指向 `@dsh-ohos/*` | L0 | 解析后的配置树 |
| TC-105-004 | `sandbox-policy.workspaceRoot` 不再等于 `/` | L0 | 配置树断言 |
| TC-105-005 | 上游 `git status` 为空（零补丁） | L0 | `git status --porcelain` |
| TC-105-006 | 用户 patch（`$DSH_HOME/user-patch.yml`）升级后保留 | L2 | 重启后文件内容 |
| TC-105-007 | 依赖安装不产生符号链接/硬链接（OHOS 拒绝） | L0 | 安装日志 |

## 9. 模块 106：工作区选择

> 明细：[spec.md §5](./106-workspace-picker/spec.md#5-验收场景)
> **口径更正**：桌面根已移除（需 ACL 的 `READ_WRITE_DESKTOP_DIRECTORY`），现为**三根**
> （sandbox / documents / download）。**2026-10-20 R2** 曾把 `READ_WRITE_{DOCUMENTS,DOWNLOAD}_DIRECTORY`
> 从声明面移除；**2026-10-21 R4 已回滚**（重新声明，并补齐 `CUSTOM_SCREEN_CAPTURE` 等），
> ⇒ 文档/下载两根**恢复可授权**：点「请求权限」弹系统授权框，授予后自动列目录。

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-106-001 | 三个主目录 Tab 全部渲染（沙箱/文档/下载） | L2 | 截图 |
| TC-106-002 | 沙箱根不存在时自动创建并可浏览 | L2 | 截图 + 目录 |
| TC-106-003 | 用户目录缺失时显示不可用与重试，不回退 | L2 | 截图 |
| TC-106-004 | 面包屑最高到主目录根，无法上溯 | L2 | 操作序列 |
| TC-106-005 | 无手动路径输入入口 | L2 | 截图 |
| TC-106-006 | 未授权时对话框内可申请，成功后自动重试。**R4 复验通过**：系统授权框真实弹出（含 `$string:documents_dir` 文案），点「允许」后自动列目录（用户手动复验 2026-10-21；`atm dump` → `grantStatus=0`） | L2 | 截图 + `atm dump` |
| TC-106-007 | 只记忆主目录 id，不记忆子路径 | L2 | 重开截图 |
| TC-106-008 | 选中的路径可被 `createWorkspace` 采纳 | L2 | 会话创建成功 |

## 10. 模块 107：诊断与可观测

> 明细：[spec.md §5](./107-diagnostics-observability/spec.md#5-验收场景)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-107-001 | `app.log` 含阶段、垫片、错误三类记录 | L0/L2 | 日志片段 |
| TC-107-002 | 四通道日志均存在且互不覆盖 | L2 | 四份样本 |
| TC-107-003 | `/_ohos/facts` 仅调试构建可用 | L0/L2 | curl 结果 |
| TC-107-004 | 诊断串不含 token/凭据 | L0 | grep 为空 |
| TC-107-005 | `selfcheck` 断言全部通过 | L0 | 退出码 0 |

## 11. 模块 108：合规与发布

> 明细：[spec.md §5](./108-compliance-release/spec.md#5-验收场景)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-108-001 | `module.json5` 权限清单与规格一致 | L0 | 清单比对 |
| TC-108-002 | 未签名构建可产出（无密钥环境） | L0 | 构建日志 |
| TC-108-003 | 双发行线产物可区分且 `versionCode` 递增 | L0/L4 | 产物清单 |
| TC-108-004 | 包体 ≤ 200 MB | L3 | `ls -l` |
| TC-108-005 | 仓库无签名材料/密钥 | L4 | `git ls-files` |
| TC-108-006 | 声明了受限权限但 Profile 缺 ACL 时装机失败可见 | L1 | `hdc install` 错误码 |
| TC-108-007 | `versionCode` 单调递增 | L0/L4 | `AppScope/app.json5` |

## 12. 模块 109：无 JIT 模式

> 明细：[test-cases.md](./109-jitless/test-cases.md)（含步骤/期望/证据口径）｜规格：[spec.md](./109-jitless/spec.md)

| 用例 | 验证 | 层 | 证据 |
|---|---|---|---|
| TC-109-001 | jit 对照臂：兼容层零动作 | L0 | `payload/jitless/selftest.mjs` |
| TC-109-002 | compat 目标臂：fetch 全能力（全局 + `shimFetch` 双跑） | L0 | `node --jitless …selftest.mjs` |
| TC-109-003 | 惰性 getter 封印正确（`maxHeaderSize`/`https.globalAgent`） | L0/L2 | `http-lazy-sealed` |
| TC-109-004 | 切换脚本幂等 + 原子（失败零写入） | L0 | `scripts/selftest-set-node-mode.mjs` |
| TC-109-005 | HAP 声明面：compat 无 JIT / jit 两处 | L0 | `unzip -p … module.json` |
| TC-109-006 | compat HAP 安装 + 启动，argv 含 `--jitless` | L1 | `node.log` argv |
| TC-109-007 | compat 兼容层事实（`ready.json#compat`） | L1 | `ready.json` |
| TC-109-008 | compat UI 可用（页面渲染、可交互） | L2 | 截图 + `app.log` |
| TC-109-009 | jit HAP 回归（无 `--jitless`、`active=false`） | L1 | `ready.json` |
| TC-109-010 | 权限面复核：compat 声明面 20 项、`ALLOW_WRITABLE_CODE_MEMORY` 0 处；`atm dump` 三项 `user_grant` 在册未授予 | L1 | HAP `module.json` + dump |
| TC-109-011 | 现有能力回归（sqlite/FTS5、垫片、选择器沙箱根） | L2 | `ready.json` + 截图 |
| TC-109-012 | 未覆盖的 WASM 能力如实失败（未挂载，登记） | L2 | 日志 |

---

## 13. 门禁（G1–G10）对应用例

| 门禁 | 内容 | 覆盖用例 | 状态 |
|---|---|---|---|
| G1 | ArkWeb → `127.0.0.1` | TC-101-001、TC-103-001、TC-109-006 | 已通过（真机） |
| G2 | `node:sqlite` + FTS5 | TC-109-011、TC-102-004 | 已通过（本机 + 真机） |
| G3 | `sh` 哨兵（命令执行） | TC-104-005 + `packages/shell-ohos/test/smoke.mjs` | 单元通过；**真机 `/system/bin/sh` 不可用**（能力缺口，模型如实报告） |
| G4 | JIT ACL / 无 ACL | TC-108-001/006、TC-109-005/006/009/010 | 已通过（双形态真机） |
| G5 | resfile 自解包 | TC-102-001/002 | 已通过（真机） |
| G6 | pnpm in worker | — | 不适用（本工程无此需求） |
| G7 | 图像桥 | TC-104-001 + `packages/attachment-image-ohos/test/smoke.mjs` + 图片对话 | **已通过**（真机图片对话 4 s，S4→宿主 `image.normalize`） |
| G8 | 包体预算 | TC-108-004 | 已通过（86 MB） |
| G9 | addon 加载（S6） | TC-102-004、TC-107-005 | 已通过 |
| G10 | 用户目录可读写 | TC-106-003/006 | **已通过（R4，2026-10-21 用户手动复验）**：授权框可弹出，点「允许」后文档/下载目录正常列出，`atm dump` 两项 `grantStatus=0` |

---

## 14. 执行记录

| 日期 | 轮次 | 范围 | 结果 | 证据 |
|---|---|---|---|---|
| 2026-10-20 | R1 | 109-jitless 双形态（本机 + 真机） | 11/12 通过，1 项未挂载 | `logs/20261020-2/TEST_REPORT.md` |
| 2026-10-20 | R2 | 全量单元测试（17 套）+ 真机基本功能（API Key/工作区/文本对话/图片对话）+ GIT 仓库可达性 | **单元 17/17 通过；文本与图片对话均通过**；修复 6 个真机阻断缺陷（S3/S4/S5、桥信封、raw()、归档 mtime）；应用内 git 不可用（能力缺口） | `logs/20261020-3/{TEST_REPORT.md,UNIT_TESTS.txt}` |
| 2026-10-20 | R3 | 声明面收敛：移除 `READ_WRITE_{DOCUMENTS,DOWNLOAD}_DIRECTORY` | 声明面 6 项（5 自有 + HAR）；`atm dump` 无三项；选择器两根如实报未授权，`请求权限` → `authResult=2` | `logs/20261020-3/TEST_REPORT.md` §8 |
| 2026-10-21 | R4 | 声明面全量对齐参考工程 `pi-desktop-ark`（20 项：补 `READ_WRITE_{DOCUMENTS,DOWNLOAD}_DIRECTORY`、`CUSTOM_SCREEN_CAPTURE`、`GYROSCOPE`、`ACCELEROMETER` 等；JIT ACL 仍仅 jit 变体） | 零 ACL Profile 装机成功；`phase=ready`；自检 7/7；HAP `module.json` 20 项无重复；`atm dump` 20 项在册、`ALLOW_WRITABLE_CODE_MEMORY` 不存在；选择器「文档」系统授权框真实弹出，**授权后目录正常列出（用户手动复验通过）**，`atm dump` → 两项 `grantStatus=0` | `logs/20261020-3/TEST_REPORT.md` §10 |
| 2026-10-21 | R5 | 全量回归（L0 17 套 + L1 装机/形态 + L2 功能）：工作区、文本对话、看图对话、Git 双仓库（公开 + 带账号内网）、设置页、选择器 | **33 项通过 / 0 失败**。L0 17/17（需先清主机代理、`selfcheck` 标志须置于脚本之前）；compat 自检 7/7、`argv` 含 `--jitless`、`sqlite+FTS5`、垫片 5 枚；看图对话 4 s；内网仓库克隆 10 s；公开仓库**浅克隆** 10 s（全量克隆超工具 60 s 预算）。5 项非阻断发现（代理变量、selfcheck 调用写法、git 工具超时、`sh`/`rg` 缺失、`inputText` 不支持空格） | `logs/20261021-2/{TEST_REPORT.md,UNIT_TESTS.txt}` |

> 敏感信息（API Key、带账号仓库的用户名/口令、内网地址）**不写入**本文件与任何提交物；设备侧运行期
> 配置属一次性测试数据，不入库。

---

## 15. 延期与未覆盖

| # | 项 | 原因 | 计划 |
|---|---|---|---|
| 1 | 文档 / 下载目录运行期授权（TC-106-006、G10） | 用户指定下一轮手动测试 | 下一轮 |
| 2 | `/_ohos/facts`（TC-107-003） | 功能未实现 | 后续模块 |
| 3 | 未挂载的 WASM 能力（TC-109-012） | 无触发入口 | 功能挂载时补 |
| 4 | L3 性能基线（TC-108-004 之外） | 无基线 | 里程碑 |
