# 102 载荷管线 —— 技术方案（plan）

> 模块：`102-payload-pipeline`｜状态：**部分 implemented（3 项 planned）**｜最后更新：2026-10-18
> 对应 spec：`specs/102-payload-pipeline/spec.md`

## 1. 技术上下文

| 项 | 值 |
|---|---|
| 运行时 | Node **v24.2.0**（`libnode.so`，ABI 137）；仅用内置 `fs`/`path`/`crypto`/`zlib`/`url`/`module` |
| 上游 | `deepseek-harness` `dsh-v0.2.1-rc.2`，`@deepseek-ai/dsh-app-boot` / `dsh/profile-boot` |
| 构建脚本 | Node ESM（`.mjs`），宿主 Node ≥ 18；无构建期 npm 依赖 |
| Shell 脚本 | Bash（Git Bash on Windows），依赖 `cygpath`/`cmd` |
| 归档格式 | ustar（magic `ustar`）+ gzip level 9；无 pax、无长名扩展 |
| 版本声明 | `dsh.version` 单行 4 字段；sha256 为幂等键 |
| 目标产物 | `entry/src/main/resources/resfile/dsh-payload/{bootstrap.js,host.js,lib,shims,dsh.tar.gz,dsh.version}` |

## 2. 宪法合规检查（C1–C14）

| 原则 | 状态 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 只消费上游包，不改源码；`patches/` 为空；垫片不进上游 |
| C2 平台真相不隐藏 | ⚠️ | 载荷缺失/失败有独立阶段；但 S3/S4 在替身包缺失时只打日志并把 `installed=false` 交给公告，自检不覆盖它们 |
| C3 证据优先 | ⚠️ | 自检可离线跑；无真机 `resfile` 自解包证据（G5 pending） |
| C4 单进程/单实例/随机端口 | ✅ | 解包在 Node 单进程内；不涉及端口 |
| C5 谁写谁读 | ✅ | `bootstrap.js` 是唯一解包者；ArkTS 只传路径 |
| C6 绝对路径 | ✅ | 归档/载荷根/日志均来自环境变量或 `__dirname` 派生；不使用 `cwd` |
| C7 垫片可审计 | ⚠️ | 5 条标记齐全、日志各一行；但 S3/S4/S5 只是探针，不是行为替身，与「等价替代」有距离 |
| C8 异常兜底 | ✅ | `uncaughtException`/`unhandledRejection` 只写 `app.log`，不退出 |
| C9 鉴权只在 Host | ✅ | 载荷不解析 token；`host.js` 只取 `authenticatedUrl` |
| C10 权限最小化 | ✅ | 载荷不声明权限 |
| C11 秘密不入库/不进日志 | ⚠️ | token 写入 `ready.json`（落盘），`host.js` 只记长度；公告文件权限未收紧 |
| C12 编号即契约 | ✅ | `102-payload-pipeline/` 与 `payload/`、`scripts/` 对应 |
| C13 可复现 | ⚠️ | 归档内容可复现（排序 + 固定 mtime/uid/gid），但 `sync-payload.mjs` 每次重写 `builtAt`，`dsh.version` 文件逐次不同 |
| C14 文档描述现状 | ⚠️ | 既有文档把 S3/S4/S5 写成已实现、把解包写成流式；本文件逐条标 `planned`/`not-implemented` |

## 3. 研究结论

1. **`dsh.version` 的 sha256 有两个来源，含义不同**：`package-payload.mjs` 写**归档 gz 的 sha256**（与 `bootstrap.js` 的比较口径一致）；`sync-payload.mjs` 写**resfile 内载荷文件（含归档）的聚合 hash**。若只跑同步不跑打包，`bootstrap` 计算归档 sha 后必然不匹配 → 载荷缺失。构建顺序必须是 `sync-payload → package-payload`（`scripts/build-hap.sh` 正是此顺序）。
2. **版本声明不是严格幂等**：`sync-payload.mjs` 注释称「内容不变不改写首行哈希」，实际每次都写新的 `builtAt`；哈希稳定但文件字节不稳定，与 FR-102-016 的「相同输入相同声明」有差距。
3. **解包不是流式**：`tar-extract.js` 用 `readFileSync` + `gunzipSync` 整包读入内存，峰值 ≈ 压缩包 + 解压后体积；与规划 §7.4「流式 gunzip」不符，大载荷（60–90 MB）在低内存设备有被回收风险。`extracting` 公告只带 `sha12`，不带文件数进度（规划 §7.4 的 `files:N` 未实现）。
4. **ustar 名字上限 100 字节且未拒绝**：`package-payload.mjs` 用 `pad(name, 100)` **截断**超长路径，不写 `prefix`、不报错。真实 `node_modules` 深层路径几乎必然超过 100 字节 → 归档内条目重名/丢失。这是当前打包器最严重的正确性缺口（FR-102-017 要求「不得静默」）。
5. **解包侧校验比打包侧严格**：解包拒绝绝对路径、`..`、逃逸根、非普通条目、截断；magic 只认 `ustar`（`readString` 返回值不含 NUL，`'ustar '` 分支不可达但无害）。
6. **S3/S4 不是替身，是探针**：`flock.js`/`sharp.js` 只检查 `runRoot/node_modules/...` 下替身包的 `package.json` 是否存在，不注入模块解析、不提供 `tryLockExclusive`/`metadata` 行为；`assemble-payload.mjs` 也不物化替身包。`ARCHITECTURE.md` §8「5 条垫片 implemented」与事实不符。
7. **S5 只测量**：`sqlite.js` 打开内存库并 `CREATE VIRTUAL TABLE ... USING fts5`，返回 `{available,fts5,detail}`；没有 `module.register` 重定向。
8. **解包无 fsync**：`writeReady` 用 `tmp + rename`，但没有 `fsync` 文件或目录（`overall-data-model.md` §2 要求 fsync）。
9. **旧版本不清理**：`resolveRunRoot` 只按 `sha12` 新建目录，从不删除旧版本；规划 §4.5/§8.5 的「保留最近 1 份」未实现（FR-102-019 planned）。
10. **装配脚本是空壳**：`assemble-payload.mjs` 只支持 `--from <已构建树>` 复制，不做 pnpm deploy、裁剪、覆盖层注入与断言（规划 §7.2 ①–⑤）；`package-payload.mjs` 在无 stage 时以 0 退出（dry-run 语义，但也可被误当成功）。
11. **profile 未物化到 `$DSH_HOME`**：`profiles/ohos/` 只在仓库里，`host.js` 却从 `$DSH_HOME/profiles/ohos` 载入；没有任何脚本把它复制过去（属 105 的落地缺口，但由本模块的装配阶段负责注入，标 `planned`）。

## 4. 数据模型（真实字段）

**`dsh.version`（一行四字段）**：`<sha256 64hex> <fileCount> <bytes> <builtAt ISO>`；`bootstrap` 只取首行，校验 `^[0-9a-f]{64}$`，派生 `sha12 = sha256.slice(0,12)`。

**幂等标记 `<payloadRoot>/.ready-<sha12>`**：`<sha256> <fileCount> <epochMs>\n`。

**`ready.json`（`bootstrap`/`host` 写入）**：`schema:1`、`at`、`version:'0.1.0+scaffold'`、`phase`、`sha12?`、`shims[]`、`diagnostic?`；`host.js` 追加 `url`、`origin`、`token`、`pid`、`sqlite{marker,available,fts5,detail}`、`roots{payload,dshHome,workspace,readonly}`。

| 实体 | 真实字段 |
|---|---|
| `ShimRecord`（fs.link / fs.symlink） | `{marker, installed:boolean, changed:boolean}` |
| `ShimRecord`（flock / sharp） | `{marker, installed:boolean, present:boolean, manifest:string}` |
| `ShimRecord`（node:sqlite） | `{marker, available:boolean, fts5:boolean, detail:string}` |
| `SelfcheckReport` | `{ok:boolean, results:[{name,ok,detail}]}` |
| `HostStartContext` | `{runRoot,payloadRoot,assetDir,version,shims,sqlite,log,writeReady}` |

**解析结果**：`resolveRunRoot` 返回 `string|null`；`null` 触发 `payload-missing`（含 diagnostic 多行）。

## 5. 接口契约

### 5.1 Provided（载荷对运行时/外壳）

| 契约 | 形式 | 说明 |
|---|---|---|
| 入口脚本 | `bootstrap.js` 绝对路径 | 由外壳传入，交给 `node::Start` |
| 输入环境 | `NODE_BRIDGE_PAYLOAD_ROOT`、`NODE_BRIDGE_READONLY_ROOT`、`NODE_BRIDGE_ARCHIVE`、`DSH_OHOS_APP_LOG`、`DSH_OHOS_HOME`、`DSH_HOME`、`DSH_OHOS_WORKSPACE`、`DSH_OHOS_MAILBOX`、`DSH_OHOS_USER_ROOT` | 全部来自库注入的 `env` |
| 阶段公告 | `ready.json` 六个 phase | 供模块 101 读取 |
| 业务日志 | `<payloadRoot>/app.log` | 每行 `ISO 时间 + 文本` |
| 垫片标记 | `DSH_OHOS_SHIM fs.link` / `fs.symlink` / `flock` / `sharp` / `node:sqlite` | 各一行安装/探测日志 |
| 自检 | `node selfcheck.js` → JSON + 退出码 | 0 全通过，1 有失败 |
| 脚本 CLI | `--from` / `--apply` / 环境 `ALLOW_MISSING` / `OHOS_CLT` | 退出码见 §6 |

### 5.2 Consumed（依赖）

| 来源 | 契约 |
|---|---|
| 库注入 | `NODE_BRIDGE_ENTRY`、`NODE_BRIDGE_ARCHIVE_SHA`、`NODE_BRIDGE_CWD`、`NODE_BRIDGE_LIBDIR` 由库设置；本载荷实际只读 `PAYLOAD_ROOT`/`READONLY_ROOT`/`ARCHIVE`，`ARCHIVE_SHA` 未使用 |
| 上游 | `loadProfileDirectory(name, dir, installAnchor)`、`loadLayeredEnv('dsh')`、`reportSkippedBundles`、`runProfile({environment,profile,resolvedProfile,patchFiles,args})`、`ctx.webServer.{protocol,port}`、`ctx.connection.authenticatedUrl(origin)` |
| Node 内置 | `zlib.gunzipSync`、`crypto.createHash`、`fs.*Sync`、`module.createRequire`、`url.pathToFileURL` |
| 项目脚本 | `ohos-node-bridge/tools/provision.mjs --check/--out`；`hvigorw assembleHar`/`assembleHap` |

### 5.3 事件协议

- **阶段事件**：`ready.json.phase` 严格单向：`preparing → extracting → starting → ready`，失败分支 `payload-missing`/`failed` 为终态；无事件推送，消费方轮询文件。
- **日志事件**：`app.log` 行内嵌垫片标记与阶段；`node.log` 由库接管 stdout/stderr。
- **退出码事件**：`sync-payload`（0/2）、`package-payload`（0，含跳过）、`assemble-payload`（0 dry-run / 2 缺输入）、`build-bridge-har`（0/1/2）、`provision-runtime`（0/2，`ALLOW_MISSING=1` 时 0）。

## 6. 实现策略

**架构模式**：Node 侧「引导脚本 + 纯函数库 + 探针式垫片」；构建侧「同步 → 打包 → 投放 → 构建 HAP」四段流水线。

**启动顺序（固定）**：建载荷根 → 安装异常兜底 → 日志 → S1/S2 安装 → S5 探测 → 读版本 → 写 `preparing` → 解析/解包 → 装 S3/S4 探针 → 加载 `host.js` → `runProfile` → 写 `ready`（FR-102-012、FR-102-013）。

**解包算法（`resolveRunRoot`）**

1. 若 `<payloadRoot>/dsh/node_modules/@deepseek-ai/dsh/package.json` 存在 → 直接复用（开发树，不校验 sha）（FR-102-001、FR-102-006）。
2. 无归档或无合法版本声明 → `null`（FR-102-002）。
3. `target=<payloadRoot>/<sha12>/dsh`、`marker=<payloadRoot>/.ready-<sha12>`；两者都存在 → 复用（FR-102-003）。
4. 写 `extracting`；1 MiB 分块算归档 sha256；不匹配 → `null`（诊断不含期望/实际哈希，只进日志）（FR-102-005）。
5. 删 `<sha12>.staging` → 解包到 staging → 删旧 `target` → `rename(staging, <payloadRoot>/<sha12>)` → 写标记（FR-102-004、FR-102-008、FR-102-009）。

**错误处理**：`main().catch` 写 `failed` + `app.log`；`host.js` 内部把上游解析失败与 `runProfile` 失败分别写 `failed` 诊断，不向 `bootstrap` 抛出（避免被当作致命退出）；`writeReady` 失败只记日志（FR-102-010）。

**性能**：包内 `cpSync` 全量复制（同步脚本）；解包整包读入（见 §3.3）；`package-payload` gzip level 9 对 60–90 MB 树耗时可达数十秒，属构建期成本。

**脚本策略**：`sync-payload` 以 `payload/` 为单一事实源重建 resfile，保留已有归档；`package-payload` 无 stage 时跳过；`provision-runtime` 先跑七项 ELF 门禁再投放，缺运行时用 `ALLOW_MISSING=1` 允许仅编译（FR-102-014、FR-102-016、FR-102-018、FR-102-020）。

## 7. 测试考虑

| 用例 | 覆盖 FR | 层 | 现状 |
|---|---|---|---|
| TC-102-001/002 | FR-102-002/003 | L0/L2 | pending（需真实归档） |
| TC-102-003 | FR-102-005/010 | L0 | pending；当前不一致只进日志，公告为 `payload-missing`，无哈希对比 |
| TC-102-004 | FR-102-011/012/013 | L0/L2 | 部分可离线验证；S3/S4 依赖替身包，仓库内不存在 |
| TC-102-005 | FR-102-011/014 | L0 | **blocked**：自检不触发 EACCES，也不检查 flock/sharp |
| TC-102-006 | FR-102-015 | L2 | pending（需真机注入） |
| TC-102-007 | FR-102-007/008 | L0 | 可离线构造恶意 tar 验证；当前无测试脚本 |

- **已执行证据（宿主 Node v24.14.1，非真机）**：`NODE_BRIDGE_PAYLOAD_ROOT=<tmp> node payload/selfcheck.js` → `ok:true`，5 项结果：`shim.fs.link`、`shim.fs.symlink`、`probe.node:sqlite`（`available=true fts5=true`）、`dirs.payloadRoot`、`ready.present`。
- 自检**不覆盖** `flock`/`sharp`，也不验证 S1 的 EACCES 回退与 S2 的递归复制；与 `overall-test-cases.md` TC-102-005 的判据不一致。
- 仓库无 `test/` 目录与测试运行器；L0 判据目前依赖 `hvigorw assembleHap` 与脚本退出码。

## 8. 文件清单

| 路径 | 行数 | 职责 |
|---|---|---|
| `payload/bootstrap.js` | 192 | 引导顺序、异常兜底、版本解析、解包、调用 Host |
| `payload/host.js` | 102 | 载入 profile、`runProfile`、上报 `ready` |
| `payload/lib/tar-extract.js` | 106 | ustar + gzip 解包与路径校验 |
| `payload/selfcheck.js` | 76 | 垫片/目录/公告自检，JSON + 退出码 |
| `payload/shims/fs-link.js` | 64 | S1：`fs.promises.link`/`fs.linkSync` 回退 `rename` |
| `payload/shims/fs-symlink.js` | 60 | S2：`symlink` 回退递归复制 |
| `payload/shims/flock.js` | 36 | S3：替身包存在性探针（行为替身 planned） |
| `payload/shims/sharp.js` | 30 | S4：替身包存在性探针（图像桥 planned） |
| `payload/shims/sqlite.js` | 43 | S5：`node:sqlite` + FTS5 探测（重定向 not-implemented） |
| `scripts/sync-payload.mjs` | 62 | `payload/` → resfile，生成 `dsh.version` |
| `scripts/package-payload.mjs` | 89 | 确定性 ustar + gzip，重写归档与版本声明 |
| `scripts/assemble-payload.mjs` | 60 | 装配（仅 `--from` 复制；裁剪/覆盖层 planned） |
| `scripts/build-bridge-har.sh` | 30 | 构建并投放 node-bridge HAR |
| `scripts/provision-runtime.sh` | 33 | 校验并投放 `libnode.so`/`libc++_shared.so` |
