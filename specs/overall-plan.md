# 整体技术方案（overall-plan.md）

> 工程：`dsh-desktop-ark`
> 版本：v0.1（`000-scaffold`）
> 对应规格：`overall-spec.md`；架构见 `ARCHITECTURE.md`；选型见 `TECH.md`。
> 状态：`000-scaffold` 已实现的部分标 **implemented**，其余标 **planned**。

---

## 1. 技术上下文

| 项 | 值 |
|---|---|
| 目标平台 | HarmonyOS 2in1 / tablet；`compatibleSdkVersion 5.0.5(17)`、`targetSdkVersion 6.1.1(24)` |
| 构建工具 | hvigor 6.1.1.280（CLT），`ohpm` 管理 HAR |
| 运行时 | `@fellow99/node-bridge` HAR 0.1.0 + `libnode.so`（Node v24.2.0，ABI 137） |
| 上游 | `deepseek-harness` tag `dsh-v0.2.1-rc.2` |
| 渲染 | ArkWeb（系统 Chromium），加载 `http://127.0.0.1:<port>/` |
| 桥 | 文件信箱（`.tmp→.req→.wip→.done/.fail`，100 ms 轮询） |

---

## 2. 宪法合规检查（对应 constitution.md）

| 原则 | 本方案如何满足 | 状态 |
|---|---|---|
| C1 上游唯一事实源 | 只写 profile/bundle/seam 插件；垫片不进上游 | ✅ |
| C2 平台真相不隐藏 | 能力面 `not-implemented` 占位；`payload-missing` 显式失败 | ✅ |
| C3 证据优先 | 门禁 G1–G10 + `SPECS_CHECKLIST` 证据列 | ✅（待真机执行） |
| C4 单进程/单实例/随机端口 | `launchType: singleton` + `--port 0` | ✅ |
| C5 谁写谁读 | `bootstrap.js` 唯一解包者；载荷落 `resfile` | ✅ |
| C6 绝对路径 | `Constants` 全部由 `filesDir`/`resourceDir` 派生 | ✅ |
| C7 垫片可审计 | 5 条白名单 + 标记 + `selfcheck` | ✅ |
| C8 异常兜底 | `bootstrap.js` 安装 `uncaughtException`/`unhandledRejection` | ✅ |
| C9 鉴权只在 Host | 壳只透传 `url`；无 token 逻辑 | ✅ |
| C10 权限最小化 | 仅声明本轮实现所需 + 四主目录 | ✅ |
| C11 秘密不入库 | `signing.*.local.json` gitignored；日志脱敏 | ✅ |
| C12 编号即契约 | `specs/101-108` 与目录一一对应 | ✅ |
| C13 可复现 | 二进制不入库；`dsh.version` sha 幂等 | ✅ |
| C14 状态标注 | 各文档 `implemented/planned` | ✅ |

---

## 3. 实现策略（分模块）

| 模块 | 策略 | 关键产物 | 状态 |
|---|---|---|---|
| `101-runtime-launch-orchestration` | 状态机 + 库投递语义 + 双通道就绪（`ready.json` / 日志行） | `DshRuntime.ets`、`Probe.ets`、`Constants.ets` | implemented |
| `102-payload-pipeline` | Node 侧自解包 + 幂等 marker + 5 条垫片 | `payload/bootstrap.js`、`payload/host.js`、`shims/` | implemented（无归档时降级） |
| `103-arkweb-shell` | ArkWeb 配置矩阵 + 导航围栏 + 加载/错误覆盖层 | `pages/Index.ets`、`entryability/EntryAbility.ets` | implemented |
| `104-host-capability-bridge` | 冻结能力名 + JSON 进出 + 永不抛；信箱传输 | `host/HostCapabilities.ets` | 部分 implemented |
| `105-upstream-adapter-bundle` | `ohos` profile + `@dsh-ohos/bundle` YAML 层 + seam 插件 | `profiles/ohos/`、`packages/bundle-ohos/` | YAML implemented；插件 planned |
| `106-workspace-picker` | dual-face 插件 + browse 后端原语 + 根围栏 | `packages/workspace-picker-ohos/` | planned |
| `107-diagnostics-observability` | 四通道日志 + 调试端点 + selfcheck | `payload/selfcheck.js`、`/_ohos/facts` | 部分 implemented |
| `108-compliance-release` | ACL 清单 + 双发行 + 签名注入 + 上架材料 | `module.json5`、`hvigorfile.ts` | 部分 implemented |

---

## 4. 跨切面

### 4.1 错误处理

- ArkTS：能力处理器一律 `try/catch` → 结构化 `{ok:false,error,hint}`；启动编排失败落 `ready.json` + 状态机 `failed`。
- Node：`uncaughtException`/`unhandledRejection` 只写 `app.log`，绝不 `process.exit`（启动致命错误除外）。
- 页面：HTTP/WS 错误由 dsh 前端自己呈现；壳只负责启动阶段错误。

### 4.2 日志

| 通道 | 位置 | 内容 |
|---|---|---|
| 库日志 | `<filesDir>/payload/node.log` | Node stdout/stderr（含原生输出污染） |
| 业务日志 | `<filesDir>/payload/app.log` | 阶段、垫片、插件行、错误 |
| 系统日志 | hilog `DOMAIN 0xD0033` / `TAG DSH_DESKTOP_ARK` | 现场排查 |
| 崩溃记录 | `<filesDir>/node-bridge/last-crash.json` | 信号、地址、栈尾 |

### 4.3 安全

- 鉴权：Host 签发 cookie；壳不参与。
- 能力：`shell.openExternal` 白名单；`fs.*` 限定四主目录。
- 秘密：签名材料不入库；token 不进日志。

### 4.4 性能

- 启动：库投递 + 60 s 预算 + 20×500 ms 探活。
- 解包：单 `tar.gz` + 幂等 marker；首启一次性成本。
- 运行：不做额外轮询（信箱 100 ms 仅在调用期间活跃）。

---

## 5. 测试方案（对应 overall-test-cases.md）

| 层 | 内容 | 判据 |
|---|---|---|
| L0 构建门禁 | 工程可编译、HAR 可解析、profile 可解析、垫片标记存在 | `hvigorw assembleHap` 成功 + 脚本 exit 0 |
| L1 装机 | 签名、安装、启动、`ready.json` | `hdc` 命令 + 文件存在 |
| L2 功能 | FR 用例（启动/页面/能力/工作区/诊断） | 用例表逐条通过 |
| L3 性能 | 首启、解包、首 token | 基线记录，退化 >20% 报警 |
| L4 合规 | 权限、隐私、秘密、包体 | 清单全绿 |

**门禁 G1–G10**（详见 `docs/000-工程规划.md` §10.1）：loopback 可达、`node:sqlite`+FTS5、`sh` 哨兵、JIT ACL、resfile 自解包、pnpm in worker、图像桥、包体、addon 加载、用户目录可读写。

---

## 6. 交付与发布

1. `scripts/build-bridge-har.sh` → `libs/@fellow99/node-bridge.har`
2. `scripts/provision-runtime.sh` → `entry/libs/arm64-v8a/{libnode.so,libc++_shared.so}`
3. `scripts/assemble-payload.mjs` → 载荷暂存 → `scripts/package-payload.mjs` → `resfile/dsh-payload/`
4. `scripts/build-hap.sh` → `hvigorw assembleHap` → 签名 HAP
5. `hdc uninstall/install/aa start` → 真机验证 → 证据入 `logs/`

**双发行线**：`standard`（要求 JIT ACL）与 `jitless`（`--jitless`，无 WASM）。同一 HAP 结构，构建参数与 `NodeRuntimeOptions.jitless` 不同；`versionCode` 各自递增。

---

## 7. 风险与缓解（摘要）

| 风险 | 缓解 |
|---|---|
| `libnode.so` 未投放导致启动即失败 | 构建脚本提前校验；`provision.mjs --check` 七项门禁 |
| 端口冲突导致进程 abort | 随机端口 + 单实例 + 异常兜底 |
| 载荷缺失（本轮） | `bootstrap.js` 写 `payload-missing` → 错误页可复制诊断 |
| 上游 id/契约变更 | `scripts/verify-upstream.mjs` 断言；tag 固定 |
| ACL 未获批 | 双发行线；`jitless` 兜底 |
| 用户目录授权被拒 | Tab 不可用态 + 授权入口；不静默回退 |
