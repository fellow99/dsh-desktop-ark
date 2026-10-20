# 规格：插件·GIT 操作（204-plugin-git）

> 工程：`dsh-desktop-ark`（ArkWeb + 进程内 `libnode.so`）
> 需求编号：`204-plugin-git`　需求名称：插件：GIT 操作
> 状态：**implemented**（源码与装配已落地；真机证据见 `logs/20261021-1/TEST_REPORT.md`，`/logs` 已被 `.gitignore` 忽略，仅本地留存）
> 来源：
> - 需求原文（需求方提供）：鸿蒙环境无 `git`，需嵌入纯 JS git 并以插件形式提供 git 操作
> - `../dsh-desktop-hos/docs/204-插件-GIT.md`（同需求的 Electron 版设计与真机验收记录，**本规格的同源依据**）
> - `../dsh-desktop-hos/docs/鸿蒙环境能力清单-v0.1.5.md`（设备能力现状；本工程另见 `../dsh-desktop-ark/docs/010-真机调试记录.md`）
> - `../dsh-desktop-hos/specs/204-plugin-git/`（同源 spec/plan/tasks/test-cases）
> - 本工程：`specs/105-upstream-adapter-bundle/`（seam 插件与 bundle 覆盖层范式）、`specs/106-workspace-picker/`（dual-face 插件范式）、`specs/109-jitless/`（`--jitless` 形态）、`specs/constitution.md`（C1–C14）
> 需求语言遵循 RFC 2119（MUST / SHOULD / MAY）。**本文件只写 WHAT（可验证的行为），实现细节在 `plan.md`。**

---

## 1. 模块概述

**目的**：把纯 JS 的 git 实现（isomorphic-git）嵌入本应用的宿主进程，向模型提供一组 git 工具、向用户提供「Git 凭据」设置页，使设备在**没有 `git` 二进制**的前提下仍能完成版本控制；所有操作发生在设备侧、进程内，不依赖任何外部二进制、不需要二进制证书。

**问题**：
- 鸿蒙环境不提供 `git`（toybox 无该命令），设备上无法执行任何 git 命令；工作区里即使有仓库也用不了。
- 上游 `ctx.fs` 接缝**没有** `mkdir`/`rmdir`/`unlink`/`rename`/`symlink` 原语，承载不了 git 的文件语义（见 `overall-spec.md` §3.4 的能力边界与 `../dsh-desktop-hos/docs/204-插件-GIT.md` §2 #4）。
- 带账号仓库需要凭据，但模型可见的工具参数里**不允许**出现口令（会随对话入库）。
- 工作区之外写文件必须仍然受围栏约束，且审批链路要 fail-closed。

**范围**：
- 范围内：21 个 git 工具；仓库根围栏与一次性提权；按主机解析的 HTTP(S) 凭据与 git 原生凭据文件；「Git 凭据」设置页；依赖物化（构建期）；宿主工具注册面；真机 `--inspect` 调试通道。
- 范围外：`rebase`（isomorphic-git 无原语，明确不交付）、`blame`、`grep`（上游 `grep` 工具已覆盖）、SSH 传输（isomorphic-git 无 SSH 客户端）、上游任何源码改动、父工程任何改动。

**与 `dsh-desktop-hos` 同源的关系**：本模块是该需求的 **Ark 版移植**，行为契约（工具名/参数/文案/围栏语义/凭据规则/三个自建能力）与 Electron 版一致；**差异只允许出现在「装配面」**（包名、依赖物化落点、profile 行、调试通道），见 §7。

---

## 2. 用户故事

- 作为用户，我希望在对话里直接让模型 clone 一个公开仓库并读懂它，不必先想办法在设备上装 git。
- 作为用户，我希望在设置里填一次带账号仓库的用户名/密码，之后模型执行 pull/push 不必知道密码。
- 作为用户，我希望模型**只在授权范围内**改动文件系统：工作区内自由操作，工作区外必须先经我审批。
- 作为用户，我希望任何失败都**如实说明原因**（缺凭据 / 认证失败 / 冲突 / 越界 / 不是仓库），不假装成功、不静默重试。
- 作为用户，我希望知道哪些 git 操作**本平台做不到**（`rebase`），而不是让它悄悄用别的方式代替。
- 作为维护者，我希望 git 依赖的落点与版本是**一个常量 + 一处断言**，升级时只改一处。

---

## 3. 功能需求

### 3.1 装配（Packaging & Mounting）

- **FR-204-001**：本模块 MUST 以本工程既有的 seam 插件形态交付（`packages/<name>-ohos/` → 载荷内 `node_modules/@dsh-ohos/<name>/`），MUST NOT 改动上游任何源码、MUST NOT 增加上游补丁。
- **FR-204-002**：插件 MUST 通过 `packages/bundle-ohos/cordis.patch.yml` 的 `- insert:` 行挂载；挂载后宿主进程 SHOULD 只出现**一份**该插件实例（MUST NOT 出现重复注册 / 重复工具名）。
- **FR-204-003**：21 个工具 MUST 在**宿主平面**注册且对 agent 可见；同一工具名 MUST NOT 注册两次。
- **FR-204-004**：插件 MUST 在启动期自报一行可检索的可见性日志（工具条数），使「行是否真的激活」在日志里可判定。
- **FR-204-005**：客户端面（设置页）MUST 随同一插件包交付（`dsh.client` 声明 + `exports["./client"]`），MUST NOT 要求用户另行安装。
- **FR-204-006**：插件依赖的上游服务 MUST 通过注入/查询两选一获得；**缺失服务 MUST NOT 让整棵插件树挂起**（宿主平面某行 pending 会拖垮其余行）。
- **FR-204-007**：依赖物化 MUST 在构建期完成（`scripts/assemble-payload.mjs`），MUST NOT 依赖设备侧联网安装。
- **FR-204-008**：物化 MUST 有产物断言（入口存在、版本等于 pin、闭包完整），断言失败 MUST 中止装配并给出下一步命令。

### 3.2 工具面（21 个）

- **FR-204-010**：工具面 MUST 恰好是下面 21 个，名称与职责一一对应：`git_init`、`git_clone`、`git_status`、`git_diff`、`git_log`、`git_show`、`git_add`、`git_commit`、`git_branch`、`git_checkout`、`git_reset`、`git_merge`、`git_cherry_pick`、`git_revert`、`git_stash`、`git_tag`、`git_remote`、`git_fetch`、`git_pull`、`git_push`、`git_config`。
- **FR-204-011**：每个工具的参数 MUST 用 `defineTool` 产出（上游 `ctx.tools.register()` 会拒绝 `required: true` 的行内简写）。
- **FR-204-012**：仓库相关工具 MUST 接受 `dir`（仓库根）并对同一会话工作区解析；`dir` 省略时 MUST 报错而不是猜。
- **FR-204-013**：`git_diff` MUST 支持四种模式（`workdir` / `staged` / `head` / `refs`）、pathspec 过滤与 `stat` 汇总；二进制（含 NUL 字节）MUST 只报 `Binary files … differ`，MUST NOT 输出内容级差异。
- **FR-204-014**：`git_diff` 在 `mode` 不是 `refs` 时收到 `ref`/`ref2` MUST 明确报错（说明该模式比较的是哪两侧，并指向 `mode:"refs"`），MUST NOT 静默忽略。
- **FR-204-015**：`git_status` MUST 按 staged / modified / deleted / untracked / conflicted 分组；冲突判定 MUST 依据工作区文件里的完整冲突标记组（上游无未合并索引 API）。
- **FR-204-016**：`git_revert` MUST 自建实现（上游无 `reversal`），且 MUST fail-closed：目标提交不是恰好 1 个父提交、或工作区该路径已分叉时 MUST 拒绝并列出冲突路径，MUST NOT 静默覆盖用户改动。
- **FR-204-017**：`git_remote` MUST 提供只读的服务端 refs 探测（不落地），用于连通性与认证验证。
- **FR-204-018**：网络类工具（clone/fetch/pull/push）MUST 透传取消信号，并有墙钟预算（配置项）；超时 MUST 如实报告已用时与建议（`depth`/`singleBranch`）。
- **FR-204-019**：任何工具 MUST NOT 在工具参数或返回值里携带凭据明文；远端地址进入输出前 MUST 抹掉 userinfo。

### 3.3 围栏与审批（Fence）

- **FR-204-020**：每次工具调用 MUST 先经 `ctx.fs` 把 `dir` 解析成进程可见的绝对仓库根，该根是后续全部 I/O 的唯一来源。
- **FR-204-021**：仓库根落在会话工作区之外且策略不是 `danger-full-access` 时，MUST 以 `FS_SANDBOX_DENIED` 拒绝，并按共享 marker 给出同轮提权提示。
- **FR-204-022**：写类工具 MUST 暴露 `sandbox_permissions` + `justification` 两个提权参数；审批 MUST 经既有 approval 服务、一次性、fail-closed；用户拒绝 MUST 如实上报。
- **FR-204-023**：文件适配层 MUST 对**每一个**路径做仓库根包含校验（词法 + realpath 双检），`..` 逃逸、绝对路径、软链指向根外 MUST 拒绝且不落到 `node:fs`。
- **FR-204-024**：适配层每个 promises 方法 MUST 是 `async` 函数（同步抛错会被 isomorphic-git 判成 callback 方言，导致所有 git 调用永久挂起）。

### 3.4 凭据（Credentials）

- **FR-204-030**：凭据 MUST 以 `credentialRef = GIT_CREDENTIAL_<HOST>` 存放，`<HOST>` = `host[:port]` 大写化、非字母数字 → `_`；值格式 `username:password`，按**第一个** `:` 切分。
- **FR-204-031**：凭据来源 MUST 有两处且优先级固定：设置页保存过的主机以 dsh 凭据库为准，其余以 `<dsh 配置目录>/.git-credentials` 为准。
- **FR-204-032**：`<dsh 配置目录>/.git-credentials` MUST 是 git 原生格式（一行一条带 userinfo 的 URL），MUST 为 `0600`，MUST 可手工编辑；写入 MUST 保留其它行与注释；删除只删匹配行，删空即删文件。
- **FR-204-033**：工具实际用到的凭据 SHOULD 镜像回该文件（尽力而为：配置目录只读/写满 MUST NOT 让已有凭据的操作失败）。
- **FR-204-034**：缺凭据时 MUST 报出 key 名、设置入口、`.git-credentials` 路径与可直接照抄的占位行，MUST NOT 把裸 401 抛给模型。
- **FR-204-035**：凭据被拒时 MUST 点名 key 名与该文件路径，最多重试 1 次，MUST NOT 无限重试。
- **FR-204-036**：无账号（公开）仓库 MUST NOT 触发认证回调，零凭据可完成 clone/fetch/pull 与全部本地操作。
- **FR-204-037**：提交身份（`user.name`/`user.email`）MUST NOT 进凭据库；默认值 MUST 是明显的占位值，MUST NOT 含任何真实个人信息。

### 3.5 设置页（Client face）

- **FR-204-040**：设置页 MUST 提供「Git 凭据」区，可保存 / 查看状态 / 删除，并就地展示 ref 命名规则。
- **FR-204-041**：设置页 MUST NOT 回显任何口令明文（输入框 `type=password`，行内只显示主机名与 ref 名）。
- **FR-204-042**：状态读取失败 MUST 显示失败原因与返回形态诊断，MUST NOT 把「读不到」显示成「状态未知」而不给线索。
- **FR-204-043**：只有状态读取成功时才允许显示「已保存」。
- **FR-204-044**：设置页 MUST NOT 成为绕过围栏的路径：它只写凭据库，不写仓库、不执行 git。

### 3.6 调试通道

- **FR-204-050**：debug 构建 MUST 能通过 `--inspect` 挂上宿主 Node 的 inspector（**仅回环地址**），供真机取证；release 构建 MUST NOT 开启。
- **FR-204-051**：调试通道 MUST NOT 改变业务行为（不新增设置项、不改变网关与围栏语义）。

---

## 4. 非功能需求

- **NFR-204-001（零上游改动）**：`deepseek-harness` 工作树零改动、零新补丁（对齐 C-O1）。
- **NFR-204-002（体量）**：载荷增量 SHOULD 控制在 10 MiB 量级（isomorphic-git 闭包；jsdiff 复用宿主闭包，零增量）。
- **NFR-204-003（密钥卫生）**：凭据明文 MUST NOT 出现在对话、`app.log`、`node.log`、`cordis.patch.yml`、规格文档与测试报告；文档与报告只允许出现 key 名与占位符。
- **NFR-204-004（性能如实）**：纯 JS git + `--jitless` 的解释执行开销 MUST 在文档中如实登记，不做「与原生 git 同速」的暗示。
- **NFR-204-005（可诊断）**：启动期一行可见性日志；失败路径 MUST 有可归因文本（不吞异常）。

---

## 5. 验收标准

| 编号 | 验收标准 | 验证方式 |
|---|---|---|
| AC-204-1 | 应用正常启动，无未激活行 / 无重复工具报错；日志含插件自报的 21 条工具 | 真机 + `app.log` / `node.log` |
| AC-204-2 | 21 个 git 工具在会话内可用（工具表按名可见、可调用） | `--inspect` 读工具表 + 对话调用 |
| AC-204-3 | 设置页出现「Git 凭据」区，可保存 / 查看状态 / 删除；保存后 `${DSH_HOME}/.credentials.yaml` 出现对应 key | 真机 UI + 进程内读取 |
| AC-204-4 | 无账号仓库：探测 / clone / status / log / diff / show / add / commit / branch / checkout / fetch / pull / merge / stash / tag / reset / cherry-pick / revert / config / push(预期失败) 全链 | 对话逐项执行 |
| AC-204-5 | 带账号仓库：探测 / clone / fetch / pull / status / log + 测试分支上的 commit / push / tag | 对话逐项执行 |
| AC-204-6 | 工作区外仓库被拒 → 提权参数重试 → 审批 → 放行（或用户拒绝时如实上报） | 真机操作 |
| AC-204-7 | 未配置凭据访问带账号仓库时，报错指明 key 名、设置入口、`.git-credentials` 路径与占位行 | 对话验证 |
| AC-204-8 | 凭据明文不出现在对话记录、`node.log` / `app.log`、`cordis.patch.yml` | 检索四处 |
| AC-204-9 | `rebase` 无工具入口，且模型被明确告知本平台不交付 | 工具表 + 对话验证 |
| AC-204-10 | `git_revert` 在工作区分叉时 fail-closed 并列出冲突路径 | 构造分叉 |
| AC-204-11 | 构建期物化成功：`<stage>/node_modules/@dsh-ohos/git/node_modules/isomorphic-git` 在位且版本等于 pin | 构建日志 + 产物核对 |
| AC-204-12 | 嵌套成立：插件带自己的 `isomorphic-git` 闭包，且**不发** `diff`；载荷顶层 `diff` 仍是宿主版本 | 产物核对 |
| AC-204-13 | `.git-credentials`：设置页保存过的主机以凭据库为准、其余以文件为准；用到的凭据被镜像回该文件；`0600`、可手工编辑、写入保留其它行、删空即删文件 | 单元测试 + 进程内取证 |
| AC-204-14 | `--inspect` 仅回环可用，且只在 debug 构建开启 | 真机 `hdc fport` + release 构建核对 |
| AC-204-15 | 基础功能回归：设置 API Key、创建工作区、一次对话均正常 | 真机 UI |

---

## 6. 已知限制（照实声明）

| # | 限制 | 依据 |
|---|---|---|
| L1 | `rebase` 不交付：isomorphic-git 无该原语，自研等于重写提交重放引擎 | 上游 API 面零命中 |
| L2 | SSH 不可用：只能 HTTPS 用户名/密码；`git@host:path` 与 `ssh://` 被库改写为 https（丢弃用户名） | 库无 SSH 客户端 |
| L3 | 载荷增量约 8.5 MiB（isomorphic-git 闭包 55 包）；jsdiff 复用宿主闭包 | 物化实测 |
| L4 | 纯 JS 性能：clone 大仓库明显慢于原生 git；`--jitless` 下解释执行更慢 | 形态约束（109-jitless） |
| L5 | 围栏粒度是**仓库根**：仓内部写入不逐次经 `fs-sandbox.checkedTarget`（比 exec 无围栏更严） | 安全取舍 |
| L6 | 凭据页无法枚举 ref（凭据 API 无枚举面），页面用 `localStorage` 记住「用户录入过的主机」；页面 origin 每次启动变化 ⇒ 重启后该列表为空（凭据本身不受影响） | 上游 API 面 |
| L7 | 不交付「运行时弹窗索要凭据」的交互：缺凭据只给指引 | 客户端无 authorization 流程面 |
| L8 | 仅 SHA-1 仓库；SHA-256 仓库不在范围 | 库现状 |
| L9 | 二进制只报 differ，不出内容级 diff | 设计取舍 |
| L10 | 明文 `http://` 远端会把 Basic 凭据以 base64 过网（内网仓库由需求方提供，生产应改 HTTPS） | 如实登记 |

---

## 7. 与 `dsh-desktop-hos` 的差异（只允许装配面）

| 项 | `dsh-desktop-hos`（Electron） | 本工程（Ark） | 理由 |
|---|---|---|---|
| 插件包名 | `harmony-plugin-git`（`plugins/`） | `@dsh-ohos/git`（`packages/git-ohos/`） | 本工程 seam 插件命名与物化约定 |
| 挂载行 | `profiles/desktop/cordis.patch.yml` | `packages/bundle-ohos/cordis.patch.yml` | 本工程唯一的覆盖层入口 |
| 依赖物化 | `scripts/collect-dsh.mjs` 的 `collectGitRuntime()` | `scripts/assemble-payload.mjs` 的 `collectGitRuntime()` | 本工程的装配脚本 |
| 载荷布局 | `dsh-dist/node_modules/harmony-plugin-git/node_modules/` | `<stage>/node_modules/@dsh-ohos/git/node_modules/` | 同上；嵌套理由一致（避免覆盖顶层 `pako` 等） |
| 调试通道 | Electron `--inspect` 主进程 | `BuildConfig.INSPECT_PORT` → 进程内 Node `--inspect` | 本工程无 Electron 主进程 |
| 工具/凭据/围栏/文案 | —— | **逐字一致** | 同源契约 |
