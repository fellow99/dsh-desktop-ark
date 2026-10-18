# 数据模型（overall-data-model.md）

> 工程：`dsh-desktop-ark`
> 版本：v0.1（`000-scaffold`）
> 状态：`implemented` 的实体来自实际代码；`planned` 的实体来自 `docs/000-工程规划.md` 对应章节。
> 所有跨进程数据均为 **JSON 文本**，以文件或 HTTP 承载，不引入序列化框架。

---

## 1. 实体总览

| 实体 | 载体 | 生产方 | 消费方 | 状态 |
|---|---|---|---|---|
| `ReadyInfo` | `<filesDir>/payload/ready.json` | Node（`bootstrap.js`/`host.js`） | ArkTS（`DshRuntime`） | implemented |
| `LaunchSnapshot` | 进程内对象 | `DshRuntime` | `pages/Index.ets` | implemented |
| `CapabilityRequest` / `CapabilityEnvelope` | 文件信箱 / 宿主桥 | Node ↔ ArkTS | 双向 | implemented |
| `RuntimeFacts` | 能力 `runtime.facts` 的返回值 | ArkTS | Node | implemented（字段子集） |
| `ShimRecord` | `RuntimeFacts.shims[]` + `app.log` | Node | Node/诊断 | implemented |
| `WorkspaceRoot` | 能力 `fs.roots`（planned） | ArkTS | Node | planned |
| `UserDirAvailability` | `RuntimeFacts.userDirs` | ArkTS | Node/UI | implemented（字段子集） |
| `PayloadVersion` | `resfile/dsh-payload/dsh.version` | 构建脚本 | Node（幂等键） | implemented |
| `ProfileManifest` | `profiles/ohos/package.json` | 仓库 | 上游 `app-boot` | implemented |
| `BundlePatch` | `packages/bundle-ohos/cordis.patch.yml` | 仓库 | 上游 `app-boot` | implemented |
| `MailboxFile` | `<filesDir>/node-bridge/mailbox/*` | 双向 | 双向 | implemented |

---

## 2. `ReadyInfo`

```jsonc
{
  "schema": 1,
  "phase": "preparing | extracting | payload-missing | starting | ready | failed",
  "at": 1730000000000,            // epochMs
  "url": "http://127.0.0.1:34567/?token=…",  // 仅 phase=ready
  "origin": "http://127.0.0.1:34567",
  "token": "…",                   // 仅 phase=ready；不写日志
  "pid": 12345,
  "version": "0.1.0+scaffold",
  "payload": { "sha256": "…", "root": "/data/storage/el2/…/payload/ab12cd34ef56/dsh" },
  "shims": ["fs.link", "fs.symlink", "flock", "sharp", "node:sqlite"],
  "diagnostic": "…"               // 仅 phase=failed / payload-missing
}
```

**规则**

- 写入 MUST 原子：先写 `ready.json.tmp`，`fsync`，再 `rename`。
- `phase=ready` MUST 同时有 `url` 与非空 `token`；其它 phase MUST NOT 有 `token`。
- `url` MUST 是 `http://127.0.0.1:<port>/`（不写死端口）；凭据只通过 query 传递一次。
- 读取方 MUST 容忍未知字段（向前兼容）并校验 `schema`。

---

## 3. `LaunchSnapshot`（ArkTS 内存态）

| 字段 | 类型 | 说明 |
|---|---|---|
| `phase` | `LaunchPhase` | `IDLE / PREPARING / STARTING / WAITING / PROBING / READY / RUNNING / FAILED / STOPPING / STOPPED` |
| `message` | `string` | 面向用户的一句话阶段说明 |
| `detail` | `string` | 失败详情（错误 + 日志尾 + 崩溃记录），可复制 |
| `url` | `string` | 仅 `READY/RUNNING` 非空 |

**状态迁移约束**

```
IDLE → PREPARING → STARTING → WAITING → PROBING → READY → RUNNING
                        │          │         │
                        └──────────┴─────────┴→ FAILED（终态）
RUNNING → STOPPING → STOPPED
```

- `FAILED` 是终态；再次启动 MUST 由应用重启完成（`node::Start` 每进程一次）。
- `READY → RUNNING` 由页面首个 `onPageEnd` 驱动（planned）；`000-scaffold` 中 `READY` 即置 `RUNNING`。

---

## 4. 宿主能力协议

### 4.1 请求

```jsonc
{ "id": "1730000000000-0001", "name": "fs.pickFolder", "args": "{\"initial\":\"/…\"}" }
```

- `name` MUST 匹配 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`，长度 ≤ 128。
- `args` MUST 是 JSON 字符串，长度 ≤ 8 MiB（库的 `capBytes`）。

### 4.2 成功 / 失败

```jsonc
{ "ok": true,  "result": { } }
{ "ok": false, "error": "unregistered | not-implemented | bad-args | payload-too-large | internal", "hint": "…" }
```

**规则**

- 处理器 MUST NOT 抛异常；所有异常映射为 `internal` + `hint`。
- 未注册 → `unregistered`；已注册但未实现 → `not-implemented` + 可执行提示。
- 错误码是**封闭集合**；新增错误码需同步本文件与 `specs/104-*/spec.md`。

### 4.3 能力清单（冻结名）

| 能力 | 状态 |
|---|---|
| `runtime.facts` | implemented |
| `perm.check` / `perm.request` / `perm.openAppInfo` | implemented |
| `fs.pickFolder` / `fs.pickFiles` / `fs.saveFile` | `not-implemented`（占位） |
| `shell.openExternal` | implemented |
| `notify.show` | `not-implemented`（占位） |
| `clipboard.readImage` / `clipboard.writeText` | `not-implemented`（占位） |
| `image.normalize` | `not-implemented`（占位） |
| `log.hilog` | implemented |
| `power.keepAwake` | `not-implemented`（占位） |

---

## 5. `RuntimeFacts`

```jsonc
{
  "schema": 1,
  "app": { "bundleName": "org.fellow99.dsh.DshDesktopArk", "versionName": "0.1.0", "versionCode": 100 },
  "node": { "expected": "v24.2.0", "abi": 137 },
  "paths": { "filesDir": "…", "resourceDir": "…", "payloadRoot": "…", "dshHome": "…", "workspace": "…" },
  "userDirs": [ { "id": "desktop", "path": "/storage/Users/currentUser/Desktop", "available": true } ],
  "capabilities": { "notify.show": "not-implemented", "fs.pickFolder": "not-implemented" },
  "jitless": false
}
```

**规则**：`paths` 全部为绝对路径；`userDirs` 只报存在性（`fs.stat`），不报内容；不含任何凭据。

---

## 6. `PayloadVersion`（`dsh.version`）

```
<sha256>  <fileCount>  <bytes>  <builtAt>
```

- 首行第一个字段是 sha256（64 hex），Node 侧据此形成幂等 marker `<payloadRoot>/.ready-<sha12>`。
- 缺失该文件时，Node MUST 记录 `payload-missing` 而不是猜测版本。
- `sha12` MUST 匹配 `^[0-9a-f]{12}$`。

---

## 7. `ProfileManifest` 与 `BundlePatch`

`profiles/ohos/package.json`：

```jsonc
{ "name": "dsh-ohos-profile", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-ohos/bundle"] } } }
```

`packages/bundle-ohos/cordis.patch.yml`：按 `id` 覆盖上游行（`hmr`、`subprocess`、`sandbox`、`bash-sandbox`、`directory-picker`、`open-in-app`、`session-query-sqlite`），并插入 `shell` / `workspace-picker` / `notify` / `facts`。

**规则**：patch 只允许"整行替换/禁用/插入"，不得复制上游行内容；未知 id MUST 报错而不是静默跳过。

---

## 8. 信箱文件（`<filesDir>/node-bridge/mailbox/`）

| 后缀 | 含义 | 生命周期 |
|---|---|---|
| `.tmp` | 正在写 | 写完后 `rename` 为 `.req` |
| `.req` | 待处理 | ArkTS 取走时 `rename` 为 `.wip` |
| `.wip` | 处理中 | 完成后写 `.done`/`.fail`（陈旧回收时**豁免**） |
| `.done` / `.fail` | 结果 | Node 读取后清理五件套 |

**规则**

- 文件内容 MUST 是单个 JSON 对象；空文件或未以 `}` 结尾视为未写完，不得消费。
- 单文件 ≤ 8 MiB；陈旧阈值 10 min；轮询 100 ms。
- 排序取字典序最小（`13 位时间戳 + 4 位序号`）。

---

## 9. 数据归属与生命周期

| 数据 | 位置 | 卸载 | 升级 | 备注 |
|---|---|---|---|---|
| 会话/日志 | `<filesDir>/dsh-home/` | 删除 | 保留 | 卸载即撤销全部会话 |
| 凭据（cookie 签名密钥） | `<filesDir>/dsh-home/.credentials.yaml` | 删除 | 保留 | 600 权限 |
| 载荷 | `<filesDir>/payload/<sha12>/` | 删除 | 按版本保留 1 份 | `current` 指针切换 |
| 运行期日志 | `<filesDir>/payload/app.log`、`node.log` | 删除 | 保留 | 单文件轮转 |
| 崩溃记录 | `<filesDir>/node-bridge/last-crash.json` | 删除 | 保留 | 原生写入 |
| 工作区 | `<filesDir>/workspace/` + 三个用户目录 | 沙箱内删除；用户目录保留 | 保留 | 用户目录受 ACL 保护 |
