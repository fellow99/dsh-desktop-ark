# 技术方案：插件·GIT 操作（204-plugin-git）

> 工程：`dsh-desktop-ark`　需求：`204-plugin-git`
> 上游基线：`deepseek-harness` `dsh-v0.2.1-rc.2`；运行时 Node **v24.2.0**（`ohos-node-bridge` HAR）
> 同源实现：`../dsh-desktop-hos/plugins/harmony-plugin-git`（Electron 版，已真机验收）+ `../dsh-desktop-hos/docs/204-插件-GIT.md`
> 本文件只写 HOW；WHAT 见 `spec.md`。

---

## 1. 方案主轴

| 议题 | 采用 | 否决项与理由 |
|---|---|---|
| git 实现 | **isomorphic-git 1.44.2**（`http/node` 客户端） | `http/web`（全局 fetch）依赖少 43 包但流式 POST 行为不确定；`simple-get` 走原生 `http/https`，与本工程 jitless 兼容层同一条路 |
| 文件访问 | **插件内 `node:fs/promises` 适配器，以仓库根为 chroot** | 扩展 `ctx.fs` 接缝需新增 5~6 个上游补丁（本工程宪法 NFR-204-001 零补丁）；vendored 单文件 bundle 违反「无构建步骤」约定 |
| 依赖供给 | **嵌套物化到插件自己的 `node_modules/`** | 顶层平铺会覆盖载荷里已有的 `pako@0.2.9` 等同名包（实测顶层 `pako` 为 0.2.9，isomorphic-git 需要 1.x） |
| 工具粒度 | **一动词一工具（21 个）** | 单 `git` 工具 + `command` 枚举：大联合 schema 易传错参、无法按工具出用例 |
| diff 渲染 | **复用宿主闭包 jsdiff（`diff@9.0.0`）** | 物化第二份 jsdiff 会与宿主同名包冲突且多 0.8 MB |
| 挂载平面 | **宿主平面单行** | 见 §3 |
| 凭据 | **凭据库（设置页）+ `<DSH_HOME>/.git-credentials`（git 原生）** | 只放凭据库：`$DSH_HOME` 拷走后外部 git 用不了；只放文件：与设置页的用户意图脱节 |

---

## 2. 组件与代码结构

```
dsh-desktop-ark/
├── packages/git-ohos/                     ← 新 seam 插件（dual-face，单包）→ @dsh-ohos/git
│   ├── package.json       name=@dsh-ohos/git / private / type=module
│   │                      exports { ".":"./lib/index.js", "./client":"./lib/client.js", "./package.json" }
│   │                      dsh.client { platform:"web", inject:[api-remotes, client-ui-settings, client-locale] }
│   │                      peerDependencies: @deepseek-ai/{cordis,dsh-tools,dsh-fs,dsh-sandbox,
│   │                                        dsh-credentials,schemastery} + diff ^9.0.0
│   ├── lib/
│   │   ├── index.js       host 面：命名导出 name/inject/Config/apply（无 default export）
│   │   ├── config.js      Config（schemastery）：authorName/authorEmail/maxDiffBlobBytes/networkTimeoutMs
│   │   ├── runtime.js     isomorphic-git（插件内嵌套闭包）+ jsdiff（宿主闭包）的惰性装载与版本断言
│   │   ├── fence.js       仓库根解析 + chroot 校验 + 一次性提权（与上游 FsMutationSandbox 同形）
│   │   ├── fs-adapter.js  isomorphic-git 的 fs 适配器（node:fs/promises，chroot 内，全 async）
│   │   ├── auth.js        按 host 解析凭据 → onAuth / onAuthFailure，并镜像回 .git-credentials
│   │   ├── git-credentials.js  .git-credentials 的解析 / 匹配 / 写入 / 删除（git 原生格式，0600）
│   │   ├── diff.js        宿主闭包 jsdiff 封装（unified diff / stat / 二进制检测）
│   │   ├── report.js      输出渲染（status 矩阵、提交摘要、冲突列表…）
│   │   ├── url.js         远端地址 userinfo 抹除（保证 AC-8）
│   │   └── tools/         21 个工具，一文件一工具
│   ├── lib/client.js      client 面：注册 settings.section（id `git-credentials`）
│   ├── test/              纯函数单测（fs-adapter 契约、git-credentials）
│   └── README.md / README_zh.md
├── scripts/assemble-payload.mjs           + collectGitRuntime() / assertGitRuntimeArtifact()
├── packages/bundle-ohos/cordis.patch.yml  + insert 一行 git
├── entry/src/main/ets/common/BuildConfig.ets   + INSPECT_PORT（debug 取证通道）
├── entry/src/main/ets/app/DshRuntime.ets       + 拼 --inspect=127.0.0.1:<port>
└── specs/204-plugin-git/                  spec / plan / tasks / test-cases
```

**组件边界**（单一目的、可独立理解与测试）：

| 单元 | 输入 | 职责 | 依赖 |
|---|---|---|---|
| `runtime.js` | 无 | 装载 isomorphic-git（嵌套闭包）/ jsdiff（宿主闭包），断言版本 | 插件内嵌套闭包 + 宿主闭包 |
| `fence.js` | `dir` + exec 上下文 | 解析仓库根、chroot 校验、提权决议、错误映射 | `ctx.fs`、`ctx.sandboxPolicy`、`@deepseek-ai/dsh-sandbox` |
| `fs-adapter.js` | 仓库根 | 提供 isomorphic-git 所需 POSIX 文件语义，越界即拒 | `node:fs/promises` |
| `auth.js` | 目标 URL | 按 host 解析凭据（库优先、回落文件）、映射 `onAuth`、镜像回文件 | `ctx.credentials`、`git-credentials.js` |
| `git-credentials.js` | `<DSH_HOME>/.git-credentials` | 解析 / 匹配 / 写入 / 删除（临时文件 + rename 原子替换、强制 0600） | `node:fs` |
| `diff.js` | 两段字节 | unified diff / stat / 二进制判定 | 宿主闭包 jsdiff |
| `report.js` | 各 API 返回值 | 渲染成模型可读文本 | 无 |
| `tools/*.js` | 工具参数 | 一个 git 动作一个工具 | 以上全部 |
| `client.js` | `settings.section` | 凭据设置页 | `remote.credentials` |

---

## 3. 挂载平面（为什么是宿主单行）

本工程没有 Electron 与 agent preset 的两平面之分：`profiles/ohos` 的 bundles 是 `dsh-base` → `dsh-web-app` → `@dsh-ohos/bundle`，所有上游行（`tools`、`tool-fs`、`fs-sandbox`、`sandbox-policy`、`approval`、`credentials` 提供方）都在**同一棵 Loader 树**里。

- 因此 **一行 `@dsh-ohos/git` 同时交付两件事**：① 21 个工具注册进 `ctx.tools`（对 agent 可见）；② `dsh.client` 声明被 client-modules 扫描到，设置页进入启动图。
- 同工程先例：`@dsh-ohos/workspace-picker-client` 就是「宿主面空实现 + `dsh.client`」的双面包，其行同样在 `@dsh-ohos/bundle` 里。
- **不复制上游行内容**（`105-upstream-adapter-bundle/spec.md` 的三类允许操作）：本模块只 `insert`。

```yaml
- insert:
    # Git 操作：纯 JS git（isomorphic-git）+ 21 个工具 + 「Git 凭据」设置页
    - id: git
      name: '@dsh-ohos/git'
```

`inject` 只声明本文件**直接使用**的服务（`tools`、`fs`）；`credentials` / `sandboxPolicy` / `approval` 通过 `ctx.get(...)` 取——宿主平面一行注入不存在的服务会永久 pending，进而拖垮整棵树（`spec.md` FR-204-006）。

---

## 4. 依赖物化（构建期）

新增 `collectGitRuntime(stage)`，形状对齐本工程既有物化步骤（`collectOhosPackages`）：

1. 常量 pin：`ISOMORPHIC_GIT_VERSION = '1.44.2'`（唯一可改点，同时被 `lib/runtime.js` 引用为断言值）。
2. 在 `build/payload-stage/.work/git-runtime` 里写最小 `package.json`，跑
   `pnpm add isomorphic-git@1.44.2 --config.node-linker=hoisted --ignore-scripts`（幂等：目标已存在且版本一致即走快路径）。
3. 把**整棵扁平闭包**（55 包 / ≈8.4 MiB）复制到
   `<stage>/node_modules/@dsh-ohos/git/node_modules/`。
4. 断言（`assertGitRuntimeArtifact`）：
   - `isomorphic-git/package.json` 版本 === pin；
   - `isomorphic-git/index.js`（或 exports 指向的入口）存在且非空；
   - 闭包的 `package.json` 计数 ≥ 50；
   - 插件自己的 `node_modules/` 内**不出现** `diff`；
   - `<stage>/node_modules/diff` 仍是宿主版本（`9.x`）。
5. 失败方式：抛错（不用 `process.exit`），由 `overlay()` 的调用点统一转成 `fail(1, …)`，保证 `finally` 清理 staging。

**为什么嵌套而不是顶层平铺**：载荷顶层已有 `pako@0.2.9`（isomorphic-git 依赖 `pako@^1`）、以及 `buffer`/`readable-stream` 等不同版本；平铺会覆盖它们从而破坏上游。嵌套后 Node 从 `@dsh-ohos/git/lib/*.js` 向上第一跳即命中自己的闭包。

**顺序**：`assemble-payload.mjs` 的既有顺序是 `prunePayload → overlay → assertStage`，`collectGitRuntime()` 在 `overlay()` 内、`collectOhosPackages()` **之后**执行，因此嵌套闭包不参与剪裁规则（`prunePayload` 只剪上游树）。

---

## 5. 围栏（安全属性）

决策点是**仓库根**，不是每一个文件操作：

1. `fence.open()` 用 `ctx.fs.resolve(dir, { cwd: policy.workspaceRoot ?? sessionCwd, signal })` → `ctx.fs.processPath(target)` 得到绝对路径；此后全部 I/O 只用这个根。
2. 策略来自 `ctx.sandboxPolicy.resolve(...)`；根不在 `policy.workspaceRoot` 内且 mode ≠ `danger-full-access` ⇒ `FsError('FS_SANDBOX_DENIED')` + `sandboxDenialMarker` + `escalationHintMarker`。
3. 提权：`approveEscalation({requestedMode, justification, effectiveMode, subject:'operation'}, {approver: ctx.get('approval'), …})`，一次性；被拒如实上报。
4. 适配层每个路径 `join(root, rel) → normalize → 前缀包含 + realpathDeepest 双检`；越界抛 `PathOutsideRepositoryError`，不落到 `node:fs`。
5. **所有** promises 方法声明为 `async`（同源教训：同步抛错会被 `isPromiseFs()` 判成 callback 方言 ⇒ 11 个命令全被 `pify` 包成「等回调」⇒ 永久挂起）。

**已知取舍**：仓内写入不逐次过 `fs-sandbox.checkedTarget`，围栏粒度是仓库根单点（与上游 `bash` 工具绕过 fs 围栏同级、但更严）。已在 `spec.md` L5 登记。

---

## 6. 凭据流程

```
工具调用需要认证
   │
   ▼
auth.js：目标 URL → host[:port] → 规整为 GIT_CREDENTIAL_<HOST>
   │   ① 设置页保存过的主机（凭据库 ctx.credentials.resolve(ref)）优先
   │   ② 否则回落到 $DSH_HOME/.git-credentials（git 原生格式，按协议+host，路径前缀优先，后者覆盖前者）
   │
命中 ─► onAuth 返回 { username, password }（明文只在 host 进程内存）
   │      并尽力镜像回 .git-credentials（失败不影响本次操作）
未命中 ─► onAuth 返回 { cancel: true }
        → 报错点名 key 名 / 设置入口 / 文件路径 / 可照抄占位行（非裸 401）
onAuthFailure ─► 「凭据被拒绝」+ key 名 + 文件路径，最多重试 1 次
```

- ref 命名与值格式是**宿主契约**，设置页就地展示（`lib/client.js` 里有一份两行镜像，含 `GIT_CREDENTIAL_` 前缀）。
- 明文不进对话 / 日志 / `cordis.patch.yml`；远端地址进输出前经 `url.js:scrubUrl` 抹掉 userinfo。
- 身份（`user.name`/`user.email`）不进凭据库：`git_config` 写仓库本地配置；`Config` 默认是明显占位值。

---

## 7. 工具面（21 个，与同源实现逐字一致）

| # | 工具 | isomorphic-git 原语 | 备注 |
|---|---|---|---|
| 1 | `git_init` | `init` | 默认分支可指定 |
| 2 | `git_clone` | `clone` | `ref`/`depth`/`noTags`/`singleBranch` |
| 3 | `git_status` | `statusMatrix` | 五分组 + 冲突标记扫描 |
| 4 | `git_diff` | `statusMatrix`/`readBlob`/`readTree`/`resolveRef`/`expandOid` + jsdiff | 四模式 / pathspec / stat |
| 5 | `git_log` | `log`/`walk` | `depth`/`ref`/pathspec/`follow` |
| 6 | `git_show` | `readCommit`/`readTree`/`readBlob`/`readTag` | 自建拼装 |
| 7 | `git_add` | `add`/`remove`/`updateIndex`/`resetIndex` | 暂存 / 删除登记 / 取消暂存 |
| 8 | `git_commit` | `commit`/`getConfig`/`resolveRef` | `message`/`author`/`amend`/隐式暂存 |
| 9 | `git_branch` | `listBranches`/`currentBranch`/`branch`/`deleteBranch`/`renameBranch` | |
| 10 | `git_checkout` | `checkout`/`fastCheckout`/`resolveRef` | 切换 / 检出 / restore |
| 11 | `git_reset` | `resetIndex`/`writeRef`/`branch`/`checkout` | soft/mixed/hard |
| 12 | `git_merge` | `merge`/`abortMerge`/`findMergeBase`/`isDescendent`/`fastForward` | `fastForward`/`no-ff`/`dryRun`/中止 |
| 13 | `git_cherry_pick` | `cherryPick`/`abortMerge` | |
| 14 | `git_revert` | `readCommit`/`readTree`/`readBlob`/`add`/`commit` | **自建，fail-closed** |
| 15 | `git_stash` | `stash` | push/pop/apply/drop/list/clear |
| 16 | `git_tag` | `tag`/`annotatedTag`/`listTags`/`deleteTag` | |
| 17 | `git_remote` | `listRemotes`/`addRemote`/`deleteRemote`/`getRemoteInfo2`/`listServerRefs` | 服务端探测只读 |
| 18 | `git_fetch` | `fetch` | `depth`/`prune`/`tags` |
| 19 | `git_pull` | `pull`/`fastForward` | `fastForwardOnly` |
| 20 | `git_push` | `push` | `force`/`delete` 显式开关 |
| 21 | `git_config` | `getConfig`/`getConfigAll`/`setConfig` | 仓库本地 / 全局 |

**提权参数**：`fence.escalationFields()` 在**所有**仓库相关工具上广告（read 形状的 `status` 也会刷新索引、`fetch` 会写对象），避免「挑漏一个就永远拿不到权限」。

---

## 8. 数据流

```
构建期
  assemble-payload.mjs --deploy --apply
    ├ pnpm deploy（上游树）→ prunePayload
    ├ overlay()
    │   ├ profiles/ohos → <stage>/profiles/ohos
    │   ├ collectOhosPackages() → <stage>/node_modules/@dsh-ohos/*
    │   └ collectGitRuntime()   → <stage>/node_modules/@dsh-ohos/git/node_modules/（isomorphic-git 闭包）
    └ assertStage()：insert 行可解析 / 无 symlink / 无 unlink 断言
  package-payload.mjs → dsh.tar.gz → resfile → HAP

启动期
  bootstrap.js 解包 → host.js：loadProfileDirectory('dsh', <run>/profiles/ohos)
    → runProfile：bundle 顺序 dsh-base → dsh-web-app → @dsh-ohos/bundle
    → 行 git = @dsh-ohos/git 激活：apply() 注册 21 个工具 + 自报一行日志
    → client-modules 扫到 dsh.client → 设置页进启动图
    → debug 构建：Node 以 --inspect=127.0.0.1:19229 启动（BuildConfig.INSPECT_PORT）

交互期（模型调用）
  工具调用(dir, …)
    ├ fence.open：ctx.fs.resolve → processPath → 仓库根；越界 → FS_SANDBOX_DENIED + 提权提示
    ├ runtime.loadGit()：isomorphic-git（嵌套闭包，版本断言）+ http/node
    ├ fs-adapter：全部文件 IO 在仓库根内（词法 + realpath 双重校验）
    ├ auth：需要认证时按 host 取凭据（库优先，回落文件），并把用到的凭据镜像回文件
    └ report：结构化结果 → 模型可读文本
```

---

## 9. 调试通道（`--inspect`）

- `BuildConfig.ets` 新增 `export const INSPECT_PORT: number = 19229;`（`0` = 关闭），注释写明「仅 debug 取证；release 置 0」。
- `DshRuntime.ets` 在拼 `flags` 时追加 `--inspect=127.0.0.1:<port>`（**只绑回环**，设备外必须 `hdc fport` 才可达）。
- 取证方式：`hdc fport tcp:19229 tcp:19229` → `curl http://127.0.0.1:19229/json/list` → CDP `Runtime.evaluate`。
  - inspector 的全局作用域**没有** `require`；入口是 CJS，可用 `process.mainModule.require`；
  - 插件是 ESM，读插件模块用 `import('file:///…/lib/git-credentials.js')`（`awaitPromise:true`）；
  - inspector **触达不到 `ctx`**（无全局句柄），故「行是否激活」靠插件自报日志与工具表。
- 该通道不改业务行为（NFR-204-051）：端口开关只影响 `flags` 字符串。

---

## 10. 错误处理

| 场景 | 表现 |
|---|---|
| 目标目录不是仓库 | 明确报「不是 git 仓库」并给 `git_init` / `git_clone` 建议（库的 `Could not find HEAD.` 在此单点改写） |
| 缺凭据 | 点名 key 名、设置入口、`.git-credentials` 路径、可照抄占位行 |
| 凭据被拒 | 「凭据被拒绝」+ key 名 + 文件路径，最多重试 1 次 |
| 合并 / 摘取冲突 | `abortOnConflict` 默认 true（不污染工作区），报冲突路径，提示可中止 |
| `revert` 工作区已分叉 | fail-closed 拒绝并列出冲突路径 |
| 越出工作区 | `FS_SANDBOX_DENIED` + 提权提示；审批被拒如实报「用户拒绝提权」 |
| 用户目录 OS 未授权 | `EPERM`/`EACCES` 原样归因，提示需系统设置授权并重启 |
| 网络不可达 / DNS 失败 | 报主机名与底层错误，不假装成功 |
| 远端拒绝推送（non-fast-forward） | 原样报服务端 `PushResult.error`，不自动 force |
| clone 体积 / 超时 | 报已用时与建议（`depth`/`singleBranch`）；`signal` 全程透传 |
| 调用被取消 | 停止执行并交由注册表处理取消语义，不当作失败报告 |
| 依赖缺失/版本漂移 | 每次调用明确报「依赖不可装载」+ 补救命令（不拖垮启动） |

---

## 11. 宪法合规（`specs/constitution.md`）

| 原则 | 状态 | 说明 |
|---|---|---|
| C1 零上游改动 | ✅ | `deepseek-harness` 工作树零改动、零新补丁；只新增本工程插件与装配步 |
| C2 不隐藏平台真相 | ✅ | 拓扑/权限/网络/性能限制逐条登记（`spec.md` §6） |
| C3 谁写谁读 | ✅ | 载荷由 Node 解包；本模块只读自己根内文件 |
| C4 运行期形态固定 | ✅ | 除既有 `NODE_MODE` 外不新增运行期形态开关；`INSPECT_PORT` 是编译期常量 |
| C5 进程内 Host | ✅ | 全部工作在主进程 Node 内，不 spawn 外部二进制 |
| C6 路径不猜 | ✅ | 全部路径由 `ctx.fs` / `$DSH_HOME` 派生；不读 `process.cwd()` |
| C7 失败可归因 | ✅ | §10 每行都有可归因文本；`apply()` 内不吞错 |
| C8 装配集中在 bundle 覆盖层 | ✅ | 只 `insert` 一行；不放宽 `105` 的三类允许操作 |
| C9 依赖可复现 | ✅ | 版本 pin + 构建期断言 |
| C10 不物化第二份同名依赖 | ✅ | `diff` 走宿主闭包并有断言 |
| C11 密钥不进日志/对话 | ✅ | §6；`url.js` 抹 userinfo；检索见 AC-204-8 |
| C12 规格先行 | ✅ | 本目录四件套 |
| C13 提交规范 | ✅ | Conventional Commits 前缀，无 AI 署名 |
| C14 文档与实现同步 | ✅ | `specs/README.md`、`SPECS_CHECKLIST.md`、包 README 同步 |

---

## 12. 实现落点清单

| # | 落点 | 文件 | 要点 |
|---|---|---|---|
| 1 | 插件包 | `packages/git-ohos/package.json` | `name` 与目录一致；`exports` 含 `./client`；`dsh.client`；上游依赖走 peer |
| 2 | host 面 | `packages/git-ohos/lib/index.js` | 命名导出 `name`/`inject`/`Config`/`apply` |
| 3 | 围栏 | `lib/fence.js` | 仓库根解析 + chroot + 提权 |
| 4 | fs 适配器 | `lib/fs-adapter.js` | 全 `async`；词法 + realpath 双检；含 `rm` |
| 5 | 凭据 | `lib/auth.js` + `lib/git-credentials.js` | 来源优先级 + 镜像 + 错误引导 |
| 6 | diff/show/revert | `lib/diff.js` + `lib/tools/{diff,show,revert}.js` | 宿主 jsdiff；revert fail-closed |
| 7 | 21 个工具 | `lib/tools/*.js` | 一文件一工具；写类带提权两参数 |
| 8 | client 面 | `lib/client.js` | `settings.section`（id `git-credentials`），locale 命名空间 `gitCredentials` |
| 9 | 依赖物化 | `scripts/assemble-payload.mjs` | `collectGitRuntime()` + 断言 + 嵌套落位 |
| 10 | 挂载 | `packages/bundle-ohos/cordis.patch.yml` | `- insert:` 一行 `git` |
| 11 | 调试通道 | `entry/src/main/ets/common/BuildConfig.ets`、`app/DshRuntime.ets` | `INSPECT_PORT` → `--inspect=127.0.0.1:<port>` |
| 12 | 单测 | `packages/git-ohos/test/*.test.mjs` | fs 适配器契约 + 凭据文件（9 例） |
| 13 | 包文档 | `packages/git-ohos/README.md`、`README_zh.md` | 配置项、凭据规则、围栏、已知限制 |
| 14 | 工程文档 | `specs/README.md`、`SPECS_CHECKLIST.md` | 登记 204 模块 |
| 15 | 规格 | `specs/204-plugin-git/` | 本目录四件套 |

---

## 13. 验证策略

| 层 | 手段 | 覆盖 |
|---|---|---|
| 单元（构建机） | `node --test packages/git-ohos/test/*.test.mjs`：适配器 async 契约 / 逃逸拒绝 / 凭据文件解析匹配写入删除与 0600 | FR-204-023/024/030–033 |
| 构建期 | `assemble-payload.mjs` 断言 + 产物核对（版本、闭包、无 diff） | AC-204-11/12 |
| 真机 `--inspect` | `hdc fport tcp:19229` + CDP `Runtime.evaluate` 读工具表、凭据文件结构、模块自检 | AC-204-1/2/8/13/14 |
| 真机 UI | 设置页走查（保存/回显/删除）+ 审批面板 | AC-204-3/6 |
| 真机对话 | 无账号全链 + 带账号读写链（脱敏记录） | AC-204-4/5/7/9/10 |
| 回归 | 基础功能（API Key / 工作区 / 对话）+ 既有插件不受影响 | AC-204-15 |

---

## 14. 风险与遗留

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 设备到 `github.com` 的可达性（同源记录里 Electron 版设备曾超时） | 无账号用例受阻 | 先探测；不可达则如实记录并改用可达的公开仓库执行同类用例，不伪造结果 |
| R2 | `--jitless` 下纯 JS 解 packfile 慢 | clone 超时/卡顿 | 暴露 `depth`/`singleBranch`/`noTags`；`signal` 透传；用例给足预算 |
| R3 | 顶层 `pako@0.2.9` 与闭包版本共存 | 上游行为漂移 | 嵌套落位 + 断言（AC-204-12） |
| R4 | 客户端面注册失败会拖累 Web 启动图 | 页面不可用 | 启动即验；失败则按 106 范式拆成独立 client 包（已登记的备用装配） |
| R5 | inspector 在进程内 Node 不可用（构建形态差异） | 取证手段受限 | 备用：插件自报日志 + 网页 CDP + 进程内探针（同源做法） |
| R6 | 内网仓库是明文 `http://` | 凭据可被链路中间人截获 | 如实登记（L10）；不在别处额外持久化 |
| R7 | 默认分支推送污染共享仓库 | 远端多一个提交 | 用例只对**测试分支**推送；默认分支写入需显式裁决 |
| R8 | hmfs/hmdfs 语义差异（大小写、无硬链接） | 同名不同大小写文件冲突 | 观察项；失败如实报错 |
| R9 | 上游升级改变 `ctx.tools` 作用域或 `ctx.fs` 语义 | 装配或围栏失效 | AC-204-1/2 作为回归门 |
| R10 | 凭据页 `localStorage` 记住的主机在重启后丢失 | 需重新输入主机名（凭据本身不丢） | 已登记 L6 |
