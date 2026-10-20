[English](./README.md) | 中文

# `@dsh-ohos/git`

> DSH Desktop（Ark 版）的 **git 插件**：把纯 JS 的 [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) 嵌进宿主进程，让**没有 `git` 二进制**的鸿蒙设备也能做版本控制。同源实现见 `dsh-desktop-hos/plugins/harmony-plugin-git`。

## 交付物

| 面 | 内容 |
|---|---|
| Host（`lib/index.js`） | **21 个工具**：`git_init` `git_clone` `git_status` `git_diff` `git_log` `git_show` `git_add` `git_commit` `git_branch` `git_checkout` `git_reset` `git_merge` `git_cherry_pick` `git_revert` `git_stash` `git_tag` `git_remote` `git_fetch` `git_pull` `git_push` `git_config` |
| Client（`lib/client.js`） | 设置页「Git 凭据」：保存 / 查看状态 / 删除（`settings.section`，id `git-credentials`） |

一行 `@dsh-ohos/bundle` 的 `insert` 行同时交付两者（工具注册在宿主平面；设置页由 `dsh.client` 扫描发现）。

## 配置（`Config`，schemastery）

| 键 | 默认 | 说明 |
|---|---|---|
| `authorName` | `yourname` | 提交/合并作者名。**刻意是占位值**，真实身份由 `git_config` 写进仓库本地配置 |
| `authorEmail` | `yourname@somehost` | 同上 |
| `maxDiffBlobBytes` | `1048576` | `git_diff` 的逐文件字节上限；超过则如实标记跳过，不静默截断 |
| `networkTimeoutMs` | `300000` | 单次网络操作（clone/fetch/pull/push）的墙钟预算 |

## 凭据

- 键名：`GIT_CREDENTIAL_<HOST>`，`<HOST>` = `host[:port]` 大写化、非字母数字 → `_`；值 = `username:password`（按**第一个** `:` 切分）。
- 来源优先级：设置页保存过的主机**以 dsh 凭据库为准**；其余**以 `<DSH_HOME>/.git-credentials` 为准**（git 原生格式，一行一条带 userinfo 的 URL、`0600`、可手工编辑）。
- 工具真正用到的凭据会**镜像回**该文件（尽力而为，失败不影响本次操作）——`$DSH_HOME` 整份拷走后，别处的 `git` 也能直接用同一份凭据。
- 明文**不进**对话、日志与 `cordis.patch.yml`；远端地址进输出前会抹掉 userinfo。
- 身份（`user.name`/`user.email`）**不进**凭据库。

## 围栏

每次调用先用 `ctx.fs` 把 `dir` 解析成进程可见的绝对**仓库根**，之后所有 I/O 都被限制在该根内（词法 + `realpath` 双检）：

- 仓库根在会话工作区内 → 直接执行；
- 在会话工作区外 → `FS_SANDBOX_DENIED` + 共享 marker 的提权提示；模型带 `sandbox_permissions` + `justification` 重试时走既有审批链路，一次性放行。

**已知取舍**：仓库**内部**写入不逐次经 `fs-sandbox.checkedTarget`，围栏粒度是仓库根单点（比 `bash` 工具完全无围栏更严）。

## 依赖物化（构建期，必须）

`isomorphic-git` **不随源码入库**，由 `scripts/assemble-payload.mjs` 的 `collectGitRuntime()` 物化到本包的**嵌套** `node_modules/`：

```
<stage>/node_modules/@dsh-ohos/git/node_modules/isomorphic-git@1.44.2   ← 55 包 / ≈8.4 MiB
```

- 嵌套而非平铺：载荷顶层已有 `pako@0.2.9` 等同名包，平铺会覆盖它们从而破坏上游。
- `diff` **不物化**：上游四个包已声明 `diff ^9.0.0`，载荷顶层就有 `diff@9.0.0`；本包只在 `peerDependencies` 声明它（多物化一份会同名冲突且多 0.8 MiB）。
- 版本 pin 在装配脚本里，装载时由 `lib/runtime.js` 断言。

## 已知限制

- **`rebase` 不交付**（isomorphic-git 无该原语）。
- **SSH 不可用**：只有 HTTPS 用户名/密码；`git@host:path` 与 `ssh://` 会被库改写为 https（丢弃用户名）。
- 纯 JS 性能：clone 大仓库明显慢于原生 git；本工程 `--jitless` 形态下更慢（提供 `depth`/`singleBranch`/`noTags` 作为缓解）。
- 二进制文件只报 `Binary files … differ`，不出内容级差异。
- 仅 SHA-1 仓库。
- 设置页无法枚举 ref（凭据 API 无枚举面），「已录入主机」列表存在页面 `localStorage`，页面 origin 每次启动变化 ⇒ 重启后该列表为空（凭据本身不受影响）。
- 明文 `http://` 远端会把 Basic 凭据以 base64 过网，生产环境应使用 `https://`。

## 测试

```bash
node --test packages/git-ohos/test/*.test.mjs
```

- `test/fs-adapter.contract.test.mjs`：每个 promises 方法必须是 `AsyncFunction`（同步抛错会被 isomorphic-git 判成 callback 方言 → **所有 git 调用永久挂起**）、方言探测、逃逸拒绝。
- `test/git-credentials.test.mjs`：`.git-credentials` 的解析 / 匹配 / 写入 / 删除与 `0600`。

规格与真机验收记录见 `specs/204-plugin-git/`。
