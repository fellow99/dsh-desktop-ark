# 无 ACL 评估（零受限权限方案）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-20（首版 2026-10-20，同日按姊妹工程最新实测重评） |
| 状态 | **已采用为默认形态（109-jitless，2026-10-20）** —— 默认 `compat`（`--jitless`，零 ACL 声明）；`jit` 仍作为另一编译期变体保留 |
| 适用工程 | `dsh-desktop-ark`（DSH Desktop · HarmonyOS Edition：ArkTS 宿主 + ArkWeb 前端 + 进程内 Node 24.2.0 + dsh Host） |
| 关联 | [`ACL配置.md`](ACL配置.md)、[`010-真机调试记录.md`](010-真机调试记录.md)、`docs/000-工程规划.md` §10 |
| 判定口径 | ✅ 真机或本机实测 ｜ 🔶 沿用他工程实测 ｜ ⚠️ 推断（有证据链但未直接验证） ｜ ⬜ 未取证 |

---

## 1. 一句话结论

> **2026-10-20 更新（需求 109-jitless）**：本方案已落地为**默认形态**。
> ArkTS 侧用编译期常量 `BuildConfig.NODE_MODE = 'compat'`，载荷侧装纯 JS `fetch` 兼容层
> （`payload/jitless/**`，仅在 `WebAssembly === undefined` 时动作），ACL 声明面收敛为 0 项；
> 实测与验收见 [`../specs/109-jitless/`](../specs/109-jitless/) 与 [`109-jitless-方案决策.md`](109-jitless-方案决策.md)。
> 下面保留原始评估（决策依据与代价量化）。

**本工程离零 ACL 只差一处代码（纯 JS `fetch` 垫片），而且这条路已经被姊妹工程走通并量产。**

- 姊妹工程 `pi-desktop-ark` 2026-10-20 的实测结论（`docs/ACL-无ACL评估.md` §10）：**三处 WASM 硬门已在载荷侧改掉**
  （`next.config` 预编译成 `.mjs`、`fetch` 换纯 JS 垫片、`photon` 换纯 JS），compat（`--jitless`）形态
  **在所有 `deviceTypes` 上默认启用**，真正缺失的功能只有 code-mode 一项，性能退化 7–10×（图片重编码 ≈15×）。
- 本工程比它更轻：载荷**不含任何 `.wasm`**（15,110 个文件里 0 个），`--jitless` 下 Host 能**正常起到 `phase=ready`**（§4.1）。
  唯一的硬门是 `fetch`（§4.2），改一处即可。
- 本版仍**保留** `kernel.ALLOW_WRITABLE_CODE_MEMORY`：本工程只出 2in1/tablet（ACL 拿得到），
  没有「ACL 申请不下来」的机型压力；而 compat 的代价（7–10× + 关掉 code-mode）在这条产品线上不值得先付。

---

## 2. 现役权限面（本次定稿）

- `requestPermissions`（**历史数字，109-jitless 前**）：9 项。**现为 compat 20 / jit 21**（2026-10-21 **R4** 全量对齐参考工程 `pi-desktop-ark`；JIT 仅 jit 变体声明）
- `definePermissions`（历史）：`kernel.ALLOW_WRITABLE_CODE_MEMORY`。**现为 compat `LOCK_WINDOW_CURSOR` 1 项 / jit 2 项**
- Ability 后台模式：`taskKeeping`
- **现役 ACL**：compat **0 项** / jit 1 项（`kernel.ALLOW_WRITABLE_CODE_MEMORY`）
- R4 补充事实：20 项声明**全部是 `availableLevel: normal`**（3 项 `user_grant`，其余 `system_grant`）⇒ 零 ACL Profile 直接装机成功（§11 真机记录）

**2026-10-20 撤销的 4 项**（详见 `ACL配置.md` §3）：`READ_PASTEBOARD`、`READ_WRITE_DESKTOP_DIRECTORY`
（两项都是需 ACL 的 `system_basic`）、`FILE_ACCESS_PERSIST`（无使用点）。
**更正（2026-10-21 R4）**：`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 已**重新声明**（对齐参考工程）；
它是 `normal` 级开放权限、不需要 ACL，仍**不能**替代 JIT 那条 ACL。

⇒ 从「需 ACL 3 项」降到 **1 项**。零 ACL 方案的剩余距离，就是**这最后一项**。

---

## 3. 零 ACL 在机制层意味着什么

| 能力 | 有 ACL（JIT 可用） | 零 ACL（必须 `--jitless`） |
|---|---|---|
| V8 Sparkplug / Maglev / TurboFan | 可用 | **全部关闭**，纯解释器执行 |
| `WebAssembly` | 可用 | **`typeof WebAssembly === 'undefined'`**（不是变慢，是不存在） |
| RegExp（irregexp） | 编译成机器码 | 退化为解释器 |
| 启动参数 | `--no-verify-heap --expose-internals` | **必须**再加 `--jitless`；否则 V8 一申请可执行页就 SIGTRAP |
| `fetch`（undici） | 可用 | **不可用**（llhttp 是 WASM）——本工程唯一硬门，可垫片修掉（§6） |
| N-API 原生库 / `fs` / `net` / `zlib` / `crypto` / `node:sqlite` | 不受影响 | 不受影响（`node:sqlite` 是原生，不是 WASM） |
| ArkTS / ArkUI 产物 | 不受影响 | 不受影响 |
| **ArkWeb 页面里的 JS** | 不受影响 | **同样不受影响**（渲染进程不在应用权限域内；姊妹工程实测 uid 不同） |

### 3.1 关键事实：**权限位不是 JIT 可用性的预检**

姊妹工程 2026-10-20 在手机 `JUY-AL80` 上的实测（`docs/ACL-无ACL评估.md` §10.6）：

> `ALLOW_WRITABLE_CODE_MEMORY` 查询**已授予**（`grantStatus=0`），但按 jit 启动时进程在
> `libnode_bridge` 内 **SIGTRAP(TRAP_BRKPT) 秒崩**；同一 HAP 改 compat 后 1.6 s 就绪。

⇒ **不能做「先查权限位、再决定 jit/compat」的运行期探测**：一次误判 = 终态 `failed`（进程内 Node 不能重启），
代价远大于 compat 的 7–10× 变慢。姊妹工程据此把模式固化成**编译期常量**，并移除了
`probeFlags` / `piNodeMode` / 偏好设置三条运行期入口。

本工程若要走零 ACL，同样应做成**编译期开关**，不要做运行期探测。

---

## 4. 本工程的两道门（本轮实测）

### 4.1 硬门一（姊妹工程有、本工程**没有**）：启动期 WASM

| 判据 | 结果 |
|---|---|
| 载荷里的 `.wasm` 数量 | ✅ **0 个**（`find build/payload-stage/dsh -name '*.wasm'` → 0） |
| `--jitless` 起 Host | ✅ **起到 `phase=ready`**：`node --jitless --expose-internals payload/bootstrap.js` → `ready.json` `phase=ready`、`dsh web: http://127.0.0.1:<port>/?token=…` |
| 垫片在 jitless 下 | ✅ S1/S2/S5/S6 全部正常（`DSH_OHOS_SHIM node-addon-require-builtin: installed=true`；`node:sqlite available=true fts5=true`） |
| profile / 插件加载 | ✅ 无 `did not activate` 行 |

> 本工程**不需要**像姊妹工程那样预编译 `next.config.ts` —— 我们根本没有 Next（Web UI 是 dsh 自己的前端产物）。

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
| 2 | undici / llhttp（Node 内置） | `fetch` 的唯一实现 | **致命**：`fetch` 抛 `WebAssembly is not defined`（§4.2） | 必须处理（1 处垫片） |
| 3 | `node:sqlite` + FTS5 | 内置原生（非 WASM），真机实测 `fts5=true` | 不受影响 | ✅ |
| 4 | 图像（`sharp` 替身 S4） | 纯 JS 头解析 + 宿主桥 `image.normalize`（ArkTS 侧原生） | 不受影响 | ✅ |
| 5 | `flock`（S3）/ `fs.link`（S1）/ `fs.symlink`（S2） | 纯 JS 替身 | 不受影响 | ✅ |
| 6 | `node-addon-require-builtin`（S6） | 纯 JS + `--expose-internals` | 不受影响 | ✅ |
| 7 | `@deepseek-ai/dsh-web-frontend` 前端产物 | 浏览器执行（ArkWeb 渲染进程） | 不受影响 | ✅ |

> 与姊妹工程的差别值得记一笔：它的载荷里有 **8 个 `.wasm`**（Next 的 SWC-WASM 30.4 MB、undici llhttp、
> `photon`、`quickjs-wasi`、`source-map08`、`@vercel/og`、`msw`、示例 `doom.wasm`），要逐个处置；
> 本工程 **只有 undici 一条**，因为 dsh 的图片链路走的是宿主桥原生（S4），不是 WASM。

---

## 6. 若要落地零 ACL：需要做什么（已压缩到 1 处 + 回归）

| # | 现状 | 替代方案 | 改动面 | 代价 / 风险 |
|---|---|---|---|---|
| 1 | `fetch`（undici + WASM llhttp） | **纯 JS `fetch` 垫片**：基于原生 llhttp 的 `node:http`/`node:https` + `node:stream/web` 的 `ReadableStream`；同时封掉 `node:http` 的惰性 getter 阻断 undici 初始化 | 新增 `payload/fetch-shim.js` + `bootstrap.js` 最早安装（与 S1–S6 同层） | 中；`dshm` 已有 ~960 行成熟实现可对照；姊妹工程已量产 ⇒ 风险显著降低。必须覆盖 SSE 流式响应 |
| 2 | `--jitless` 必须进 argv | 由 ArkTS 侧 `NodeRuntimeOptions.jitless` 下发（**已有字段**：`DshRuntime.ets` 现在传 `jitless: false`，改 `true` 即可） | 1 处配置 + 双发行线 | 低 |
| 3 | 性能 | 接受解释器（姊妹工程真机：热循环 **7–10×** 慢；图片重编码 **≈15×**；冷启动几乎无差异 871–926 ms vs 885–969 ms） | 无 | 中—高（长回合 agent 明显变慢；图片"超限重编码"最坏 25–30 s） |
| 4 | 若将来出现 WASM 依赖 | 用前先 `typeof WebAssembly` 探测并如实降级，而不是静默失败 | 逐项 | 低 |
| 5 | 运行期模式切换 | **不要做**（§3.1：权限位不是预检，误判 = 终态 failed）；用编译期常量 | 1 处 | 低 |

**明确不要做的事**：

- ❌ 不要只覆盖 `globalThis.fetch` 就以为绕开 undici（`dshm` E36 已否证：触发点在 `node:http` 惰性 getter）；
- ❌ 不要用 `--no-experimental-fetch`（Node 24 已移除，传了直接报错）；
- ❌ 不要把「解释器模式」当成「只是慢」——没有 fetch 垫片时它是**不可用**；
- ❌ 不要用 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 之类开放权限去替代 ACL JIT（`ohos-node-bridge` 探针实测仍 SIGTRAP）；
- ❌ 不要用「查 `grantStatus` 决定 jit/compat」做运行期探测（§3.1 手机实测反例）。

---

## 7. 分阶段路线与判据（若将来要走零 ACL）

| 阶段 | 动作 | 判据（必须实测） |
|---|---|---|
| P0 | ArkTS 侧固定 `jitless: true`（**编译期常量**，release 也生效；不做运行期入口） | 设备启动到 `phase=ready` 不出现 SIGTRAP；`node.log` 的 `argv` 里 `--jitless` 在脚本路径之前 |
| P1 | 装纯 JS `fetch` 垫片 + 封 `node:http` 惰性 getter | 本机 `--jitless` 下 `fetch('http://127.0.0.1:<port>/')` 成功；**真机 SSE 流式对话成功**（`stopReason=stop`） |
| P2 | 逐项回归载荷能力 | `node:sqlite`+FTS5、`sharp` 替身 + `image.normalize`、`flock`/`fs.link`/`fs.symlink`、工作区选择器三 Tab、命令执行哨兵，全部在 jitless 下通过 |
| P3 | 性能基线 | 冷启、首屏、单轮工具调用耗时对比（把姊妹工程的 7–10× / 图片 ≈15× 纳入验收口径，写进 README） |
| P4 | 双发行线 | `standard`（带 ACL）与 `standard-jitless`（零 ACL）各出一份 HAP，装机与启动分别取证 |

**可复用的现成资产**（姊妹工程已量产，直接对照即可，不必从零试）：
`next.config` 预编译、`fetch` 纯 JS 垫片（原生 llhttp + `node:stream/web`）、`photon` → `jpeg-js` + `pngjs` + 自研 Lanczos3、
以及「每个替换都配带对照臂的门禁（没有垫片必须失败）」的验证纪律。

---

## 8. 未取证清单

| # | 项 | 说明 |
|---|---|---|
| 1 | 真机 `--jitless` 启动 | 本机已过（§4.1），**设备侧未跑**（本工程 `deviceTypes` 只声明 `2in1`/`tablet`，当前接入的手机装不上） |
| 2 | 真机 jitless 下的 `fetch` | 同上；本机已确证失败形态，垫片未写 |
| 3 | jitless 下长回合稳定性 | 未测（未做长跑）；姊妹工程已跑通多轮对话与工具链，可作 🔶 参考 |
| 4 | `dsh` 侧「首次对话之外」的 WASM 依赖 | 本机 `--jitless` 起到 ready 只覆盖启动期；对话期只确认了 `fetch` 一条链路 |
| 5 | 撤销 4 项权限后的一次完整装机 | 需要重新生成 Profile 覆盖新声明面（旧 Profile 里的 4 条 ACL 属多余授权，不影响装机） |
| 6 | 纯 JS `fetch` 垫片在本工程的 SSE 表现 | 未实现，故未测（姊妹工程已量产，但那是 Next/pi-web 的链路） |

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

**结论（历史，已被 109-jitless 取代）**：~~保留 `kernel.ALLOW_WRITABLE_CODE_MEMORY`~~；现默认 compat 不声明该权限（见 §11 与 `ACL配置.md` §10）。零 ACL 是一条
**代价已量化（1 处垫片 + 7–10× 解释器开销 + code-mode 不可用）、且有量产先例（姊妹工程）**的备选路线；
若将来要上「ACL 申请不下来」的机型，按 §7 的 P0→P4 推进，每阶段判据必须实测，不得以「应该可以」代替。

---

## 11. 落地记录（109-jitless，2026-10-20）

| 项 | 结果 |
|---|---|
| 载荷兼容层 | `payload/jitless/{index.js,fetch-shim.js,http-lazy-undici.js,selfcheck.js}`（纯 JS，零第三方依赖） |
| 安装判据 | 仅 `typeof WebAssembly === 'undefined'`；WASM 可用时**零动作**（jit 对照臂实测 `active=false`） |
| 本机自检 | `node --jitless payload/jitless/selftest.mjs` → PASS（GET / POST JSON / SSE 分块 / Abort / FormData / 惰性 getter 封印） |
| 启动自检 | `compat` 下每次启动跑一次回环自检，事实写 `app.log` 与 `ready.json#compat.selfcheck`（≈195 ms） |
| 形态切换 | `node scripts/set-node-mode.mjs jit|compat`（幂等；同步 `BuildConfig.NODE_MODE` 与 `module.json5` 声明面） |
| 未覆盖 | `libreoffice-kit`（WASM worker，功能未挂载）、code-mode 类能力：如实失败，不伪造成功 |
| 声明面口径 | **2026-10-21 R4**：`requestPermissions` 改为**全量对齐参考工程 `pi-desktop-ark`**（compat 20 项 / jit 21 项）；审计口径区分「已声明未使用」与「已使用」（`ACL配置.md` §1 逐项标注） |
