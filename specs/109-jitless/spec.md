# 109 无 JIT 模式（compat / jitless）—— 模块规格（spec）

> 模块：`109-jitless`｜状态：**implemented（本机 + 真机双形态已取证）**｜最后更新：2026-10-20
> 需求编号：`109-jitless`｜涉及工程：`dsh-desktop-ark`（父工程仅子模块指针，不改动）
> 实现方案见 `specs/109-jitless/plan.md`；决策依据见 `docs/109-jitless-方案决策.md`

## 1. 模块概述

**目的**：同一份代码同时支持两种运行形态 ——

| 形态 | ACL `kernel.ALLOW_WRITABLE_CODE_MEMORY` | 启动参数 | WASM |
|---|---|---|---|
| `jit`（有 ACL） | 声明并授予 | 现状（不带 `--jitless`） | 可用 |
| `compat`（无 ACL，默认） | **不声明** | 带 `--jitless` | **不存在** |

**要解决的问题**

| # | 问题 | 本模块的回答 |
|---|---|---|
| P1 | 无 ACL 的设备上按 JIT 启动即 SIGTRAP，应用级失败 | 形态做成**编译期常量**，默认 `compat` |
| P2 | `--jitless` 下 `WebAssembly === undefined`，Node 自带 `fetch`（WASM llhttp）不可用 | 纯 JS `fetch` 垫片（原生 `node:http/https` + `node:stream/web`），并封印 http 惰性 getter |
| P3 | 无 ACL 的安装面不能出现受限权限声明 | `compat` 构建的 `requestPermissions` / `definePermissions` 均无 JIT 项 |
| P4 | 两种形态容易互相污染 | 兼容层只在 `typeof WebAssembly === 'undefined'` 时安装；WASM 可用时**零动作** |

**范围内**：编译期形态常量与启动参数、载荷兼容层（fetch / http 惰性 getter）、ACL 声明面、切换脚本、诊断事实、验收用例。
**范围外**：运行期形态切换与 ACL 探测决策、目录权限的功能改造、上游 `node_modules` 修改、真实 provider 凭据管理。

**现状事实（取证）**

| 判据 | 结果 |
|---|---|
| 本机 `node --jitless` 的 `typeof WebAssembly` | `undefined`（Node v24.7.0） |
| 本机 `node --jitless` 下 `fetch` 本地 http | `fetch failed / WebAssembly is not defined` |
| 载荷 `.wasm` 数量 | `0` |
| 载荷是否用 `globalThis.fetch` | 是（`dsh-llm-deepseek/lib/index.js:658`） |
| `--jitless` 下 Host 启动 | ✅ 起到 `phase=ready`（`build/payload-stage/probe-jitless.log`） |
| `node:sqlite` + FTS5（jitless） | ✅ `available=true fts5=true` |

## 2. 用户故事

- 作为在**没有 JIT ACL** 的设备上安装应用的用户，我能装上并正常使用（模型调用、工作区、终端），而不是启动即崩。
- 作为在**有 ACL** 的设备上使用的用户，我得到与今天完全一致的行为与性能。
- 作为维护者，我能用一条命令切换形态并重新构建，且两种形态的声明面/参数不会错配。
- 作为排障者，我能从 `app.log` / `hilog` 一眼看出「本次是哪种形态、依据是什么、兼容层装没装」。

## 3. 术语

- **形态（node mode）**：`jit` / `compat`，由编译期常量决定，运行期不可切换。
- **兼容层**：`payload/jitless/`，仅在 WASM 缺失时接管 `globalThis.fetch` 并封印 `node:http/https` 惰性 getter。
- **依据串**：形如 `mode=compat（依据：编译期常量 BuildConfig.NODE_MODE=compat…）` 的可 grep 事实。

## 4. 功能需求（RFC 2119）

### 4.1 形态与启动参数

- **FR-109-001**：形态 MUST 由编译期常量 `entry/src/main/ets/common/BuildConfig.ets` 的 `NODE_MODE` 决定；默认 MUST 为 `compat`。
- **FR-109-002**：运行期 MUST NOT 提供形态切换入口（调试参数、偏好设置、ACL 探测均不得参与决策）。
- **FR-109-003**：`compat` MUST 通过 `NodeRuntimeOptions.jitless = true` 注入 `--jitless`（库保证它排在脚本路径之前）。
- **FR-109-004**：`jit` MUST 保持现状启动参数（`--no-verify-heap --expose-internals`）与现状行为。
- **FR-109-005**：启动日志 MUST 记录形态与依据；ACL 探测读数 MAY 作为诊断信息出现，但 MUST NOT 影响决策。
- **FR-109-006**：形态判定 MUST 对非法常量值 fail-safe 到 `compat`（宁慢不崩）。

### 4.2 ACL 声明面

- **FR-109-007**：`compat` 构建的 `module.json5` MUST NOT 声明 `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`（`requestPermissions` 与 `definePermissions` 均无）。
- **FR-109-008**：`jit` 构建 MUST 在该两处成对声明上述权限。
- **FR-109-009**：`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY` MUST 保留声明（`normal` + `user_grant`）；二者 MUST NOT 出现在签名 Profile 的 `acls.allowed-acls` 中（重签收敛，文档给复验命令）。
- **FR-109-010**：形态切换 MUST 可脚本化、幂等、可校验：`scripts/set-node-mode.mjs <jit|compat>`；任一目标 pattern 不匹配时 MUST 拒绝写入并以非零码退出。

### 4.3 载荷兼容层

- **FR-109-011**：兼容层 MUST 只在 `typeof WebAssembly === 'undefined'` 时安装；WASM 可用时 MUST NOT 修改任何全局或模块属性。
- **FR-109-012**：安装顺序 MUST 为「先封印 `node:http/https` 惰性 getter，再接管 `globalThis.fetch`」。
- **FR-109-013**：兼容 `fetch` MUST 支持：GET/POST、自定义 headers、`AbortSignal`、≤5 次重定向、`response.{ok,status,statusText,headers,text,json,arrayBuffer,body}`；`body` MUST 是标准 `ReadableStream`（SSE 逐块读，不得整体缓冲）。
- **FR-109-014**：请求体 MUST 支持 string / Buffer / TypedArray / `FormData` / `Blob` / `ReadableStream`；对外来（原生）`FormData`/`Blob` MUST 按能力识别，不得只依赖 `instanceof`。
- **FR-109-015**：兼容层 MUST NOT 依赖任何第三方包（只用 `node:` 内置），且 MUST NOT 修改载荷中的 `node_modules`。
- **FR-109-016**：安装结果 MUST 以三态（`installed` / `kept` / `failed`）写入 `app.log`，并随 `ready.json` 的 `compat` 字段对外可见。
- **FR-109-017**：`compat` 启动 MUST 跑一次**本地回环自检**（GET / POST JSON / SSE 分块 / Abort），结果写入 `app.log` 与 `ready.json`；自检失败 MUST NOT 阻断启动。
- **FR-109-018**：兼容层内的异常 MUST NOT 让进程退出；失败 MUST 记录具体原因。

### 4.4 降级与如实呈现

- **FR-109-019**：未覆盖的 WASM 依赖能力（如文档转换 worker、code-mode 类）MUST 如实失败并留日志，MUST NOT 伪造成功。
- **FR-109-020**：`ready.json` 的既有字段（`schema`/`phase`/`url`/`token`/`shims`…）MUST 保持不变；新增字段 MUST 向后兼容（读取方容忍未知字段）。

## 5. 关键实体

### 5.1 `BuildConfig.NODE_MODE`
`'compat' | 'jit'` 的字符串常量；编译期唯一形态开关。

### 5.2 `NodeModeDecision`
`{ mode, reason, isCompat(), describe() }`：形态、依据串、便捷判定。

### 5.3 `ready.json#compat`
```json
{
  "active": true,
  "webAssembly": "undefined",
  "httpLazy": "installed",
  "sealed": ["maxHeaderSize", "globalAgent", "..."],
  "fetch": "installed",
  "globals": { "Headers": "kept" },
  "selfcheck": { "status": "ok", "cases": [{"name": "get", "ok": true}] }
}
```
WASM 可用时：`{ "active": false, "webAssembly": "defined", ... }`，`selfcheck.status = "skipped"`。

## 6. 验收场景（摘要，详见 `test-cases.md`）

- **TC-109-001** `jit` 对照臂：兼容层不安装，原生 fetch 正常。
- **TC-109-002** `compat` 下 GET/POST/SSE/Abort/FormData 全通。
- **TC-109-003** `compat` 下 `node:http` 惰性 getter 已封印且 `https.request` 仍可用。
- **TC-109-004** 切换脚本幂等，`compat` 构建的 HAP 内无 JIT 权限声明。
- **TC-109-005** 真机 `compat` HAP：安装、启动到 `RUNNING`，`node.log` 的 argv 含 `--jitless`。
- **TC-109-006** 真机 `compat`：`app.log` / `ready.json#compat.selfcheck` 为 ok。
- **TC-109-007** 真机 `jit` HAP 回归：行为与改造前一致。
- **TC-109-008** `atm dump` 复核：目录权限仍在声明面、JIT 权限在 `compat` 下不存在。

## 7. 非功能需求

- **NFR-109-001** `jit` 形态零可观察差异：兼容层不安装、不新增全局、不新增请求。
- **NFR-109-002** `compat` 启动自检开销 ≤ 200 ms（本机与真机各测一次），不引入新进程/线程。
- **NFR-109-003** 性能退化如实登记（参考工程真机：热循环 7–10×；冷启动差异小）。
- **NFR-109-004** 可审计：形态、兼容层三态、自检结果都能从设备文件读出。

## 8. 假设与约束

- 运行时 Node **v24.2.0**（`ohos-node-bridge` 随包 `libnode.so`）；`--jitless` 仍受支持（Node 上游有移除讨论，见 `nodejs/node#66459`，升级前必须重跑本用例）。
- `ohos-node-bridge` 已支持 `NodeRuntimeOptions.jitless`（`NodeRuntime.ets:233`）。
- 兼容层实现复用参考工程 `pi-desktop-ark/payload/jitless/**`（同一作者、已量产），只做来源标注与最小适配。

## 9. 依赖

| 依赖 | 用途 |
|---|---|
| `@fellow99/node-bridge`（HAR） | `NodeRuntimeOptions.jitless`、崩溃记录、日志环 |
| `payload/bootstrap.js` | 安装兼容层、写 `app.log` / `ready.json` |
| `payload/host.js` | 把 `compat` 事实并入最终 `ready.json` |
| `scripts/set-node-mode.mjs` / `build-hap.sh` | 形态切换与构建 |
| `hdc`（真机） | 安装、启动、取证 |
