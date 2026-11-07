# AGENTS.md — dsh-desktop-ark（HarmonyOS Edition）AI Agent 工作规范

> 本文件定义了本项目（`dsh-desktop-ark`，DSH Desktop HarmonyOS Edition）中 AI Agent 必须遵守的规范和工作流程。
> 所有规范均基于本机实际已安装的技能（skills）编写，不含虚构内容。
> 总则见 `~/.agents/AGENTS.md`；工作区总纲见上级 `../AGENTS.md`；本文件为项目级规范，冲突时以本文件为准。

---

## 一、项目背景（必读）

**DSH Desktop · HarmonyOS Edition** — 在鸿蒙 2in1 / 平板（API 24）上用**系统 ArkWeb** 渲染官方未改动的 dsh Web UI，dsh Host 跑在**进程内真实 Node.js 运行时**（libnode v26.13.0）。**无 Electron、无捆绑 Chromium、无 ArkUI 重写。**

- **版本**：0.2.2（`versionCode` 202）｜ 上游基线 `dsh-v0.2.2-rc.1` ｜ Node **v26.13.0** ｜ 无 JIT（`compat` 默认，侧载无需受限权限）
- **运行时来源**：ohpm 中央仓 `@fellow99/node-bridge`（ArkTS 组件库，NAPI bootstrap + dlopen + node::Start）+ `@fellow99/node-runtime@26.13.0`（`libnode.so`，SHA-256 锁定 by `runtime.lock.json`）
- **适配原则**：上游**零补丁** —— `ohos` profile + 一个 bundle 层 + seam 插件 + 六个经审计垫片

### 与其他 Edition 的关系
| | 本工程（HarmonyOS Edition） | `../dsh-desktop-hos`（Electron on HarmonyOS Edition） |
|---|---|---|
| 渲染 | 系统 ArkWeb（无捆绑） | Electron 37 内置 Chromium |
| Node | 进程内 `libnode.so` v26.13.0 | Electron 运行时内（Node 22.17） |
| 运行时插件 | `@fellow99/node-bridge` + `@fellow99/node-runtime`（ohpm） | `../harmonypc-electron` |
| 上游补丁 | **0** | 13 处源码补丁 |
| 安装要求 | 无（默认 JIT-free） | JIT 受限权限（ACL） |

### 仓库结构
| 路径 | 内容 |
|---|---|
| `AppScope/` | 应用级配置（图标/名称/签名） |
| `entry/` | Entry 模块（ArkTS 外壳 + ArkWeb） |
| `libs/`、`oh_modules/` | Node 运行时与 ohpm 依赖 |
| `scripts/` | `assemble-payload.mjs`、`build-hap.sh`、`verify-upstream.mjs` |
| `profiles/desktop/` | 自定义 desktop profile |
| `packages/`、`payload/` | seam 插件与载荷装配 |
| `specs/` | as-built 规格（013、101–108、110、119、201、204、205） |
| `docs/` | 能力清单、工程规划、真机调试记录、ACL/JITless 决策 |

### 关键文档
- `docs/鸿蒙环境能力清单-0.2.1.md`（能力矩阵，三路同表）
- `docs/000-工程规划.md`（架构取舍、垫片白名单）
- `docs/ACL配置.md` · `docs/119-jitless-方案决策.md`（两种运行时形态）
- `specs/README.md`（规格索引）

---

## 二、代码地图（CodeGraph）规范 ——【核心】

### 2.1 已建索引
本项目已初始化 `.codegraph/` 代码地图（~118 文件 / ~1,631 节点）。**探索代码必须优先使用 `codegraph-cli`**。

### 2.2 索引自动更新（post-commit 钩子）——【强制】
- 本工程 git **`post-commit` 钩子**已安装：每次 commit 后自动 `codegraph sync` 增量更新 `.codegraph/`。
- 钩子非阻塞、失败只写日志（`logs/codegraph-sync.log`）。Agent 也应在大规模变更后手动 `codegraph sync`。

### 2.3 命令速查
| 场景 | 命令 |
|---|---|
| 探索功能区域 | `codegraph context "<任务描述>"` |
| 查找符号定义 | `codegraph query <符号名>` |
| 变更影响范围 | `codegraph impact <符号名>` |
| 索引状态 / 增量更新 | `codegraph status` / `codegraph sync` |

---

## 三、鸿蒙开发规范（强制使用鸿蒙技能）

- **鸿蒙应用开发**（ArkTS / ArkUI / Stage 模型 / 代码审查 / 安全审计）→ 只用 **`harmonyos-app-dev`**。
- **鸿蒙设备/模拟器操作与测试**（`hdc`、`uitest`、`hilog`、安装 `.hap`、启动、截图）→ 只用 **`harmonyos-app-testing`**。
- 两者互斥，不得混用。

---

## 四、通用规范

### 4.1 语言
- 与用户交互、编写文档、提交注释使用**中文**；代码、变量、技术术语使用**英文**。

### 4.2 安全
- **严禁**提交签名凭据、密钥、Token、口令哈希等敏感信息（签名本地文件须 gitignore）。
- 严禁用 `as any` / `@ts-ignore` / `@ts-expect-error` 压制类型错误；严禁空 `catch(e) {}`。

### 4.3 代码质量
- 编辑后运行 `lsp_diagnostics` 检查无新增错误；修复 Bug 只做最小改动；禁止凭空猜测未读取代码行为。

---

## 五、Git 提交规范（强制使用 `git-commit` 技能）

- 提交前先加载 **`git-commit`** 技能；提交注释**必须**用 [Conventional Commits](https://www.conventionalcommits.org/) 格式 `<type>[optional scope]: <description>`。
- 仅允许 type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore` / `revert`。
- 本工程是**子模块**：本工程内提交后，须回到**父工程**提交新的子模块指针。
- **严禁** `--no-verify` 跳过 Git Hooks（除非用户明确要求）。

---

## 六、开发与质量流程规范

- 遵循工作区 `specs-based-devflow` 完整生命周期；规格化走 speckit 技能链；调试用 `systematic-debugging`；审查用 `requesting-code-review` / `receiving-code-review`。
- **构建**：`node scripts/assemble-payload.mjs --deploy --apply` → `bash scripts/build-hap.sh` → `hdc app install -r entry/build/default/outputs/default/entry-default-signed.hap`。
- 每项能力须对照 `docs/鸿蒙环境能力清单-0.2.1.md` 诚实标注状态（✅ / ⚠️ / ❌），**不伪造能力**。

---

## 七、技能自检与快速索引

| 任务类型 | 必备技能 |
|---|---|
| Git 提交 | `git-commit` |
| 代码库探索 / 代码地图 | `codegraph-cli` |
| 鸿蒙应用开发 | `harmonyos-app-dev` |
| 鸿蒙应用测试/自动化 | `harmonyos-app-testing` |
| 开发任务（全流程） | `specs-based-devflow` |
| 代码审查 | `requesting-code-review` / `receiving-code-review` |
| 调试 | `systematic-debugging` |
| 产品/需求规划 | `brainstorming` |

---

## 八、违规处理

违反以上任何规范，Agent 必须立即停止、向用户报告、等待指示后再继续。

---

> **最后更新**：2026-11-02
> **维护者**：fellow99
