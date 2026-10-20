# 测试用例：插件·GIT 操作（204-plugin-git）

> 工程：`dsh-desktop-ark`　需求：`204-plugin-git`
> 依据：`spec.md` §3/§5、`plan.md` §13
> 执行环境：真机 **HAD-W32**（HarmonyOS / API 26 / arm64-v8a），debug 构建，`hdc` 已连线
> 记录位置：`logs/<YYYYMMDD>-N/TEST_REPORT.md`（`/logs` 已被 `.gitignore` 忽略，仅本地留存）

## 0. 脱敏纪律（**先读这一节**）

1. 本文件**只保留操作类型与预期**。仓库地址、账号、口令、API Key 一律不写：需要时由需求方**线下**提供，执行时以环境变量或临时输入方式使用。
2. 报告里的占位符固定为：`<公开仓库 URL>`、`<内网主机>:<端口>`、`<内网仓库>.git`、`GIT_CREDENTIAL_<内网主机规整名>`、`<测试账号>`、`<测试口令>`、`<API Key>`。
3. 证据只记**结论与关键词**（如 `refs=N 条服务端分支`、`Created commit <短 oid>`），不记凭据字符、不记 `.git-credentials` 内容。
4. 临时脚本、探针、日志碎片放会话 scratch，**不入库**。

---

## 1. 构建与单元（构建机）

| 编号 | 用例 | 步骤 | 预期 |
|---|---|---|---|
| TC-204-B1 | fs 适配器方言契约 | `node --test packages/git-ohos/test/fs-adapter.contract.test.mjs` | 每个 promises 方法 `constructor.name === 'AsyncFunction'`；空参探测返回 promise（复刻 `isPromiseFs`）；`..` 逃逸 / 绝对路径 / 软链逃逸被拒 |
| TC-204-B2 | 凭据文件（9 例） | `node --test packages/git-ohos/test/git-credentials.test.mjs` | 路径解析（`DSH_HOME` / `~/.dsh`）、注释坏行跳过、百分号编码往返、协议+host+路径优先级与「后者覆盖」、写入保留其它行、同 host 同用户替换 / 异用户新增、`0600`、删除与删空即删文件、缺失读作「无凭据」 |
| TC-204-B3 | 物化产物断言 | `node scripts/assemble-payload.mjs --deploy --apply` | 退出码 0；日志含 `collectGitRuntime` 的 55 包统计；`<stage>/node_modules/@dsh-ohos/git/node_modules/isomorphic-git` 在位且版本 `1.44.2` |
| TC-204-B4 | 不覆盖宿主依赖（AC-204-12） | 装配后核对 | 插件 `node_modules/` 内**无** `diff`；`<stage>/node_modules/diff/package.json` 仍为 `9.x`；`<stage>/node_modules/pako` 仍为 `0.2.9` |
| TC-204-B5 | 载荷体积 | `du -sh <stage>` 前后对比 | 增量 ≈ 8.5 MiB（不因 diff 增加第二份） |

## 2. 真机：部署与基础功能

| 编号 | 用例 | 步骤 | 预期 |
|---|---|---|---|
| TC-204-D0 | 部署与就绪 | `bash scripts/build-hap.sh --debug` → `hdc install -r <hap> -t <目标>` → **清设备 `payload` 解压 marker** → `aa start` → 读 `ready.json` | `BUILD SUCCESSFUL`；安装 Success；`phase=ready`、非空 `token`；`sha12` 与本次归档一致 |
| TC-204-D1 | 启动自报（AC-204-1） | 读 `app.log` / `node.log` | 含 `[dsh-ohos] @dsh-ohos/git: registered 21 tools`；无 `did not activate`、无 `duplicate tool` |
| TC-204-D2 | inspector 可达（AC-204-14） | `hdc fport tcp:19229 tcp:19229` → `curl http://127.0.0.1:19229/json/list` → CDP `Runtime.evaluate` 读 `process.pid` / `process.version` | 列表含一个 node target；`process.version` 为运行时版本；`--inspect` 只绑 `127.0.0.1`（`netstat` 复核） |
| TC-204-D3 | 工具表可见（AC-204-2） | inspector 读工具表（或对话让模型列 `git_*` 工具） | 恰好 21 个 `git_*`，名称与 `spec.md` FR-204-010 一致；无 `git_rebase` |
| TC-204-D4 | 设置 API Key | 设置 → 模型 → 填入 `<API Key>` → 保存 | 页面提示已保存；`${DSH_HOME}/.credentials.yaml` 出现对应 ref（**只核 key 名**） |
| TC-204-D5 | 创建工作区 | 「选择工作区」→ 沙箱 Tab → 新建/选中目录 → 确认 | 工作区被登记；会话可创建 |
| TC-204-D6 | 一次对话 | 新会话发一条消息（如「用一句话介绍你自己」） | 模型正常回答；无报错、无连接中断 |

## 3. 真机：无账号（公开）仓库 —— 对应 AC-204-4

> 目标仓库 `<公开仓库 URL>` 由需求方线下给出。**先做连通性探测**（TC-204-A1），不可达则如实记录并按 `plan.md` R1 的处理继续（不伪造结果）。

| 编号 | 用例 | 操作 | 预期 |
|---|---|---|---|
| TC-204-A1 | 服务端 refs 探测 | `git_remote`（`listServerRefs`） | 返回分支/标签条数；不落地任何文件 |
| TC-204-A2 | clone | `git_clone`（`dir` = 工作区内子目录，`depth` 视体积） | 成功；工作区出现仓库目录；报告含默认分支与 HEAD 短 oid |
| TC-204-A3 | status / log / show | `git_status`、`git_log`（`depth` 5）、`git_show`（HEAD） | 状态干净或如实列出；历史含作者/时间/标题；单提交含元信息 + 变更清单 |
| TC-204-A4 | 制造改动 → diff | 用 `write`/`edit` 工具改一个文本文件 → `git_diff`（默认 `head`） | 产出 `---`/`+++`/`@@` 的标准 unified diff；`stat` 模式给出新增/删除行数 |
| TC-204-A5 | diff 参数纪律（AC-204-14 补充） | `git_diff` 只给 `dir` + `ref:"HEAD~1"` | **明确报错**：`ref` 只能在 `mode:"refs"` 用；不静默回「无变更」 |
| TC-204-A6 | add / commit / branch / checkout | `git_add` → `git_commit` → `git_branch`（新建）→ `git_checkout` | 暂存清单正确；生成提交（短 oid）；分支列表 +1；切换后报告 `On branch …` |
| TC-204-A7 | fetch / pull / merge / stash / tag / reset | `git_fetch` → `git_pull` → `git_merge`（本地分支）→ `git_stash push/list/pop` → `git_tag`（建/列/删）→ `git_reset`（soft/mixed/hard） | 无新内容时如实报「无变化」；合并产生提交或如实报冲突；stash 可收起并恢复；标签三动作成功；三种 reset 行为正确 |
| TC-204-A8 | cherry-pick / revert / init / remote / config / push(预期失败) | 逐项执行；`git_push` 不配凭据；另建空目录 `git_init` 后 `git_config` 设身份并首次提交 | cherry-pick 与 revert 成功（如可达）；`git_init` 生成 `.git`；`git_remote` 增删正确；`git_config` 回读一致；`git_push` **预期失败**且报「未配置凭据」+ key 名（AC-204-7） |

## 4. 真机：带账号（内网）仓库 —— 对应 AC-204-5

> 主机 `<内网主机>:<端口>`、仓库 `<内网仓库>.git`、账号 `<测试账号>` / 口令 `<测试口令>` 由需求方线下提供。
> **只对测试分支写入**；默认分支写入需单独裁决（`spec.md` L10 / `plan.md` R7）。

| 编号 | 用例 | 操作 | 预期 |
|---|---|---|---|
| TC-204-C1 | 未配置凭据时的报错（AC-204-7） | 在**清空**该主机凭据的前提下 `git_remote`（`listServerRefs`） | 报错点名 `GIT_CREDENTIAL_<内网主机规整名>`、设置入口、`${DSH_HOME}/.git-credentials` 路径与可照抄占位行；**非裸 401** |
| TC-204-C2 | 保存凭据（设置页） | 设置 → 「Git 凭据」→ 填主机/账号/口令 → 保存 | 页面显示「已保存。」+ 行内「已配置」；`${DSH_HOME}/.credentials.yaml` 出现该 ref；页面不回显口令（AC-204-3 / FR-204-041） |
| TC-204-C3 | 认证探测 + clone | `git_remote`（`listServerRefs`）→ `git_clone` | 认证通过（返回 refs 条数）；clone 成功、提交数与远端一致 |
| TC-204-C4 | 只读链 | `git_status` / `git_log` / `git_diff` / `git_show` / `git_fetch` / `git_pull` / `git_branch` | 全部成功；`pull` 已是「最新」时如实说明；分支列表含本地与远端跟踪 |
| TC-204-C5 | 测试分支写入链 | `git_checkout -b <测试分支>` → 新增说明文件 → `git_add` → `git_commit` → `git_push`（`ref`/`remoteRef` = 测试分支）→ `git_tag`（附注）→ `git_push`（tag） | 提交成功；推送 `refs/heads/<测试分支>: ok`；标签推送成功。远端被策略拒绝时**逐字上报**、不重试、不伪装成功 |
| TC-204-C6 | 凭据文件镜像（AC-204-13） | 进程内取证：`.git-credentials` 路径、`stat.mode & 0o777`、行数、单行结构（协议/host 长度、用户与口令非空长度） | 路径 = `${DSH_HOME}/.git-credentials`；`0600`；该主机一行存在；**输出不含任何凭据字符** |
| TC-204-C7 | 仅文件凭据可用（AC-204-13） | 用 `matchCredential` 从文件取凭据、**绕过凭据库**调一次 `listServerRefs` | 认证通过（返回 refs 条数） |

## 5. 真机：围栏、设置页与密钥卫生

| 编号 | 用例 | 操作 | 预期 |
|---|---|---|---|
| TC-204-S1 | 越界拒绝（AC-204-6） | `git_init` 指向会话工作区之外（如 `${DSH_HOME}/…`） | `[sandbox: …]` 拒绝 + 同轮提权提示；模型带 `sandbox_permissions`+`justification` 重试时出现审批面板 |
| TC-204-S2 | 审批处置 | 在 TC-204-S1 的审批面板选择「拒绝」/「允许一次」 | 拒绝：如实报「用户拒绝提权」，不重试；允许：该次调用在批准根下执行 |
| TC-204-S3 | 设置页状态与删除 | 再保存一条占位主机 → 查看状态 → 删除 | 状态显示「已配置」；删除后行消失、对应 ref 从 `.credentials.yaml` 消失；真实主机不受影响 |
| TC-204-S4 | 密钥卫生（AC-204-8） | 在会话记录、`app.log`、`node.log`、`cordis.patch.yml` 中检索口令与 API Key 原文 | **四处均无明文**；只允许出现 `GIT_CREDENTIAL_*` ref 名与 `***` 抹过的地址 |
| TC-204-S5 | 二进制差异（FR-204-013） | 对含 NUL 字节的文件调 `git_diff` | 只输出 `Binary files a/… and b/… differ` |
| TC-204-S6 | revert fail-closed（AC-204-10） | 先 revert 一个提交，再改写同一路径的工作区内容，随后对同一提交再次 revert | 第二次**拒绝**并列出冲突路径；工作区未被覆盖 |

---

## 6. 通过判据

- **Critical（必须全绿）**：TC-204-B1…B4、D0…D3、S1、S4。
- **主体功能**：TC-204-A1…A8、C1…C5 全部有结论；**预期失败项**（无凭据 push、服务端策略拒绝删除分支等）按「如实上报」判通过。
- **允许受限但不阻塞**：依赖设备网络可达性（A 组）、远端服务端策略（C5 的删除分支）、`localStorage` 主机列表（L6）。
- 任一项失败必须在 `TEST_REPORT.md` 给出：现象、归因（文件/行）、处置（修 / 登记为已知限制）。
