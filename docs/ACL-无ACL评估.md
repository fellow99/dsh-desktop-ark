# 无 ACL 评估（零受限权限方案）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-20 |
| 状态 | **评估记录**：本版**不采用**零 ACL；本文留档其可行性、代价与落地路线 |
| 适用工程 | `dsh-desktop-ark`（DSH Desktop · HarmonyOS Edition：ArkTS 宿主 + ArkWeb 前端 + 进程内 Node 24.2.0 + dsh Host） |
| 关联 | [`ACL配置.md`](ACL配置.md)、[`010-真机调试记录.md`](010-真机调试记录.md)、`docs/000-工程规划.md` §10 |
| 判定口径 | ✅ 真机或本机实测 ｜ 🔶 沿用他工程实测 ｜ ⚠️ 推断（有证据链但未直接验证） ｜ ⬜ 未取证 |

---

## 1. 一句话结论

**比姊妹工程（`pi-desktop-ark`）更轻，但仍不可行。**

轻的地方：本工程的载荷**不含任何 `.wasm`**（15,110 个文件里 0 个），`--jitless` 下 Host 能**正常起到 `phase=ready`**（本机实测，见 §4.1）——
姊妹工程在这一点上是**硬失败**（Next 启动期要 SWC-WASM）。

不可行的地方在**第二条硬门**：`--jitless` ⇒ `WebAssembly` 不存在 ⇒ Node 内置 undici 的 WASM llhttp 起不来 ⇒ **`fetch` 全废**，
而 dsh 调模型就是 `globalThis.fetch`（`dsh-llm-deepseek/lib/index.js:658`）⇒ 第一次真实对话必定失败（本机实测，见 §4.2）。

要落地零 ACL，最少要做一件架构级改动（**纯 JS `fetch` 垫片**）加一组逐项验证。

---

## 2. 现役权限面（本次定稿）

- `requestPermissions`：**9 项**（8 项本工程声明 + `GET_NETWORK_INFO` 由 `@fellow99/node-bridge` HAR 合并）
- `definePermissions`：`kernel.ALLOW_WRITABLE_CODE_MEMORY`
- Ability 后台模式：`taskKeeping`
- **现役 ACL 只有 1 项**：`ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY`

**2026-10-20 撤销的 4 项**（详见 `ACL配置.md` §3）：`READ_PASTEBOARD`、`READ_WRITE_DESKTOP_DIRECTORY`
（两项都是需 ACL 的 `system_basic`）、`FILE_ACCESS_PERSIST`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`（后两项无使用点）。

⇒ 从「需 ACL 3 项」降到 **1 项**。零 ACL 方案的剩余距离，就是**这最后一项**。

---

## 3. 零 ACL 在机制层意味着什么

| 能力 | 有 ACL（JIT 可用） | 零 ACL（必须 `--jitless`） |
|---|---|---|
| V8 Sparkplug / Maglev / TurboFan | 可用 | **全部关闭**，纯解释器执行 |
| `WebAssembly` | 可用 | **`typeof WebAssembly === 'undefined'`**（不是变慢，是不存在） |
| RegExp（irregexp） | 编译成机器码 | 退化为解释器 |
| 启动参数 | `--no-verify-heap --expose-internals` | **必须**再加 `--jitless`；否则 V8 一申请可执行页就 SIGTRAP |
| `fetch`（undici） | 可用 | **不可用**（llhttp 是 WASM） |
| N-API 原生库 / `fs` / `net` / `zlib` / `crypto` / `node:sqlite` | 不受影响 | 不受影响（`node:sqlite` 是原生，不是 WASM） |
| ArkTS / ArkUI 产物 | 不受影响 | 不受影响 |
| **ArkWeb 页面里的 JS** | 不受影响 | **同样不受影响**（渲染进程不在应用权限域内；姊妹工程实测 uid 不同） |

---

## 4. 本工程的两道门（本轮实测）

### 4.1 硬门一（姊妹工程有、本工程**没有**）：启动期 WASM

| 判据 | 结果 |
|---|---|
| 载荷里的 `.wasm` 数量 | ✅ **0 个**（`find build/payload-stage/dsh -name '*.wasm'` → 0） |
| `--jitless` 起 Host | ✅ **起到 `phase=ready`**：`node --jitless --expose-internals payload/bootstrap.js` → `ready.json` `phase=ready`、`dsh web: http://127.0.0.1:65184/?token=…` |
| 垫片在 jitless 下 | ✅ S1/S2/S5/S6 全部正常（`DSH_OHOS_SHIM node-addon-require-builtin: installed=true`；`node:sqlite available=true fts5=true`） |
| profile / 插件加载 | ✅ 无 `did not activate` 行 |

> 结论：本工程**不需要**像姊妹工程那样去预编译 `next.config.ts` —— 我们根本没有 Next（Web UI 是 dsh 自己的前端产物）。

### 4.2 硬门二（本工程**成立**）：`fetch` 依赖 WASM llhttp

**本机实测（Node v24.7.0，2026-10-20）**：

```
$ node --jitless -e "console.log('WebAssembly:', typeof WebAssembly)"
WebAssembly: undefined

$ node --jitless -e "…http.createServer(…).listen(0) → fetch('http://127.0.0.1:<port>/x')"
fetch FAILED: fetch failed | cause: WebAssembly is not defined

$ node -e "console.log('WebAssembly(JIT):', typeof WebAssembly)"
WebAssembly(JIT): object
```

**为什么这对本工程是致命的**：dsh 的模型调用走全局 `fetch`
（`node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:658` → `this.fetchImpl = options.fetch ?? globalThis.fetch`；
同型实现见 `dsh-llm-pi-ai`、`dsh-llm-deepseek-account`）。⇒ 零 ACL 下「UI 能打开、一说话就失败」。

**他工程同源台账（`dshm` / Node 22 与 24 均复现）**：

| 结论 | 出处 |
|---|---|
| `unhandledRejection: ReferenceError: WebAssembly is not defined at lazyllhttp (node:internal/deps/undici/undici:5988:9)` | `dshm/docs/50-端侧核心运行架构.md` E33/E34/E35 |
| 触发点是 `node:http` 的惰性 getter ⇒ `lazyUndici` | 同上 E38 |
| 封掉 `node:http` 全部惰性 getter（`maxHeaderSize`/`globalAgent`/`WebSocket`/`CloseEvent`/`MessageEvent`）后该报错在本机与真机双双消失 | 同上 E39 |
| `--no-experimental-fetch` 无效（Node 24 已移除该 flag） | 同上 E35 |

---

## 5. 载荷里与 WASM/JIT 相关的面（本工程实测）

| # | 项 | 现状 | 零 ACL 后果 | 判定 |
|---|---|---|---|---|
| 1 | 载荷 `.wasm` 文件 | **0 个** | 无 | ✅ 无需处理 |
| 2 | undici / llhttp（Node 内置） | `fetch` 的唯一实现 | **致命**：`fetch` 抛 `WebAssembly is not defined`（§4.2） | 必须处理 |
| 3 | `node:sqlite` + FTS5 | 内置原生（非 WASM），真机实测 `fts5=true` | 不受影响 | ✅ |
| 4 | 图像（`sharp` 替身 S4） | 纯 JS 头解析 + 宿主桥 `image.normalize`（ArkTS 侧原生） | 不受影响 | ✅ |
| 5 | `flock`（S3）/ `fs.link`（S1）/ `fs.symlink`（S2） | 纯 JS 替身 | 不受影响 | ✅ |
| 6 | `node-addon-require-builtin`（S6） | 纯 JS + `--expose-internals` | 不受影响 | ✅ |
| 7 | `@deepseek-ai/dsh-web-frontend` 前端产物 | 浏览器执行（ArkWeb 渲染进程） | 不受影响 | ✅ |

---

## 6. 若要落地零 ACL：需要做什么

| # | 现状 | 替代方案 | 改动面 | 代价 / 风险 |
|---|---|---|---|---|
| 1 | `fetch`（undici + WASM llhttp） | **纯 JS `fetch` 垫片**：基于原生 llhttp 的 `node:http`/`node:https` + `node:stream/web` 的 `ReadableStream`；同时封掉 `node:http` 的惰性 getter 阻断 undici 初始化 | 新增 `payload/fetch-shim.js` + bootstrap 最早安装（与 S1–S6 同层） | 中；`dshm` 已有 ~960 行成熟实现与门禁可对照；需覆盖 SSE 流式响应 |
| 2 | `--jitless` 必须进 argv | 由 ArkTS 侧 `NodeRuntimeOptions.jitless` 下发（**已有字段**：`DshRuntime.ets` 现在传 `jitless: false`，改 `true` 即可） | 1 处配置 + 双发行线 | 低 |
| 3 | 性能 | 接受解释器（姊妹工程探针：热循环 6–9 ms → **294–305 ms / 2e6**，≈40×） | 无 | 高（长回合 agent 会明显变慢） |
| 4 | 若将来出现 WASM 依赖 | 用前先 `typeof WebAssembly` 探测并如实降级，而不是静默失败 | 逐项 | 低 |

**明确不要做的事**：

- ❌ 不要只覆盖 `globalThis.fetch` 就以为绕开 undici（`dshm` E36 已否证：触发点在 `node:http` 惰性 getter）；
- ❌ 不要用 `--no-experimental-fetch`（Node 24 已移除，传了直接报错）；
- ❌ 不要把「解释器模式」当成「只是慢」——没有 fetch 垫片时它是**不可用**；
- ❌ 不要用 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 之类开放权限去替代 ACL JIT（`ohos-node-bridge` 探针实测仍 SIGTRAP）。

---

## 7. 分阶段路线与判据（若将来要走零 ACL）

| 阶段 | 动作 | 判据（必须实测） |
|---|---|---|
| P0 | ArkTS 侧固定 `jitless: true`（release 也生效） | 设备启动到 `phase=ready` 不出现 SIGTRAP；`node.log` 的 `argv` 里 `--jitless` 在脚本路径之前 |
| P1 | 装纯 JS `fetch` 垫片 + 封 `node:http` 惰性 getter | 本机 `--jitless` 下 `fetch('http://127.0.0.1:<port>/')` 成功；真机 SSE 流式对话成功（`stopReason=stop`） |
| P2 | 逐项回归载荷能力 | `node:sqlite`+FTS5、`sharp` 替身、`flock`/`fs.link`/`fs.symlink`、工作区选择器三 Tab、命令执行哨兵，全部在 jitless 下通过 |
| P3 | 性能基线 | 冷启、首屏、单轮工具调用耗时对比（把 §3 的 ≈40× 纳入验收口径，写进 README） |
| P4 | 双发行线 | `standard`（带 ACL）与 `standard-jitless`（零 ACL）各出一份 HAP，装机与启动分别取证 |

---

## 8. 未取证清单

| # | 项 | 说明 |
|---|---|---|
| 1 | 真机 `--jitless` 启动 | 本机已过（§4.1），设备侧未跑（当前接入的是 `phone` 机型，本工程只声明 `2in1`/`tablet`，装不上） |
| 2 | 真机 jitless 下的 `fetch` | 同上；本机已确证失败形态 |
| 3 | jitless 下长回合稳定性 | 未测（未做长跑） |
| 4 | `dsh` 侧是否还有「首次对话之外」的 WASM 依赖 | 本机 `--jitless` 起到 ready 只覆盖启动期；对话期只确认了 `fetch` 一条链路 |
| 5 | 撤销 4 项权限后的一次完整装机 | 需要重新生成 Profile 覆盖新声明面（旧 Profile 里的 4 条 ACL 属多余授权，不影响装机） |

---

## 附：本轮实测命令（可复跑）

```bash
# 1) 载荷里有没有 WASM
find build/payload-stage/dsh -name '*.wasm' | wc -l          # → 0

# 2) jitless 能不能起到 ready（本机）
NODE_BRIDGE_PAYLOAD_ROOT=$PWD/build/payload-stage DSH_HOME=/tmp/dsh-home \
DSH_OHOS_APP_LOG=/tmp/probe.log DSH_OHOS_WORKSPACE=/tmp/ws \
  node --jitless --expose-internals payload/bootstrap.js
# → dsh web: http://127.0.0.1:<port>/?token=…；ready.json phase=ready

# 3) jitless 下 WebAssembly / fetch
node --jitless -e "console.log(typeof WebAssembly)"          # undefined
node --jitless -e "require('node:http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',async function(){ \
  const p=this.address().port; try { const r=await fetch('http://127.0.0.1:'+p+'/x'); console.log('ok', await r.text()) } \
  catch(e) { console.log('FAILED', e.cause&&e.cause.message) } this.close() })"
# → FAILED WebAssembly is not defined

# 4) dsh 用全局 fetch 调模型
grep -n "globalThis.fetch" build/payload-stage/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js
# → 658: this.fetchImpl = options.fetch ?? globalThis.fetch
```

**结论**：本版**保留** `kernel.ALLOW_WRITABLE_CODE_MEMORY`（现役唯一 ACL）。零 ACL 作为一条**有明确代价（纯 JS fetch 垫片 + ≈40× 解释器开销）与执行清单**的备选路线留档；
若将来要上「ACL 申请不下来」的机型，按 §7 的 P0→P4 推进，每阶段的判据必须实测，不得以「应该可以」代替。
