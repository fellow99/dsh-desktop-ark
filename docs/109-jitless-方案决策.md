# 109-jitless 方案决策（头脑风暴 + 可行性评估）

| 项 | 内容 |
|---|---|
| 日期 | 2026-10-20 |
| 需求 | **109-jitless 无 JIT 模式**：同一份代码兼容「有 ACL（JIT + WASM）」与「无 ACL（必须 `--jitless`，无 WASM）」两种运行形态 |
| 涉及工程 | 父工程（仅子模块指针，不改动）＋ `dsh-desktop-ark`（全部实现与文档） |
| 规范产出 | [`../specs/109-jitless/`](../specs/109-jitless/)（spec / plan / tasks / test-cases） |
| 输入依据 | [`ACL配置.md`](ACL配置.md)、[`ACL-无ACL评估.md`](ACL-无ACL评估.md)、参考工程 `pi-desktop-ark` 的 `docs/108-jitless-方案决策.md` 与 `payload/jitless/**` |
| 取证口径 | ✅ 本机/真机实测 ｜ 🔶 沿用他工程一手记录 ｜ ⚠️ 推断（链路完整未直测） ｜ ⬜ 未取证 |

---

## 1. 一句话结论

**可行，且不牺牲「有 ACL」形态。** 本工程离零 ACL 只差 **1 处硬门**（`fetch` / undici 的 WASM llhttp）＋
**1 处配套封印**（`node:http/https` 的惰性 getter）；兼容层只在 `typeof WebAssembly === 'undefined'` 时安装，
WASM 可用时**一个动作都不做**（jit 形态零可观察差异）。

形态按产品决策做成**编译期常量**：默认 `compat`（`--jitless`），另一形态把常量改 `jit` 重新构建。

---

## 2. 需要做兼容的模块（逐项取证）

| # | 模块 | 失效机制 | 用户可见后果 | 判定 |
|---|---|---|---|---|
| 1 | Node 内建 undici（`globalThis.fetch`，解析器 llhttp 为 WASM） | `--jitless` 下 `typeof WebAssembly === 'undefined'`（本机 Node v24.7.0 实测）⇒ `fetch failed / WebAssembly is not defined` | **致命**：`dsh-llm-deepseek/lib/index.js:658` 用 `globalThis.fetch`，一说话就失败（SSE 全废） | **必须改** |
| 2 | `node:http/https` 惰性 getter（`lazyUndici`） | 首次访问即拉起 undici 模块 ⇒ 触发 WASM 初始化 | 与 1 同源；即使装了 fetch 垫片也会被它拖死 | **必须改** |
| 3 | `undici` npm 8.11.2（载荷内） | 无进程内消费者（`grep` 只命中 `openai` 的 mTLS 懒路径，profiles 不加载） | 无 | 不改（仅登记） |
| 4 | `sharp` | 已由垫片 S4 的纯 JS 替身 + 宿主桥 `image.normalize` 顶掉 | 无 | 无需改 |
| 5 | `node:sqlite` + FTS5 | 原生 C++ 模块，不是 WASM（本机/真机探针 `fts5=true`） | 无 | 无需改 |
| 6 | `esbuild` / `tsx` / `amaro`（Node 类型擦除） | 运行时未加载：`hmr` 在 `@dsh-ohos/bundle` 里 `disabled: true`，载荷是已编译 JS | 无 | 无需改 |
| 7 | `libreoffice-kit` worker、`dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js` | 前者功能未挂载；后者跑在 ArkWeb 渲染进程（不在应用权限域） | 无（若将来挂载该功能会如实失败） | 登记降级 |
| 8 | Next / photon / quickjs-wasi | 本工程载荷 **0 个 `.wasm`**（`find … -name '*.wasm'` = 0），不存在这些依赖 | 无 | N/A |

> 与参考工程的差别：它的载荷有 8 个 `.wasm`（SWC / llhttp / photon / quickjs / source-map08 / og / msw / doom），
> 需要逐个处置；本工程只有 undici 一条。

---

## 3. 证据（本机实测，2026-10-20）

```bash
$ node -v
v24.7.0
$ node --jitless -e "console.log(typeof WebAssembly)"
undefined
$ node --jitless -e "…http.createServer…fetch('http://127.0.0.1:<port>/x')…"
fetch FAILED: fetch failed | WebAssembly is not defined
$ node -e "console.log(typeof WebAssembly)"          # 对照臂
object
```

载荷侧（`build/payload-stage/dsh`，15,055 个文件）：

```bash
$ find . -name '*.wasm' | wc -l                      # → 0
$ grep -n "globalThis.fetch" node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js
658:  this.fetchImpl = options.fetch ?? globalThis.fetch;
```

上游一手结论（[nodejs/undici#4708](https://github.com/nodejs/undici/issues/4708)）：
> "the HTTP parser used by `fetch()` is implemented in WebAssembly for ease of distribution…
> This can be changed, but not without significant work."

⇒ 短期不会有「原生 llhttp 版 fetch」，纯 JS 垫片是正解。

Node 官方文档（[`--jitless`](https://nodejs.org/docs/latest-v24.x/api/cli.html#--jitless)）：
"Stability: 1 - Experimental. Disable runtime allocation of executable memory. This may be required on some
platforms for security reasons." —— 与 OHOS 的 W^X 约束一致。

---

## 4. fetch 替代方案对比

| 方案 | 做法 | 评估 |
|---|---|---|
| **A（选中）纯 JS fetch 垫片** | 原生 `node:http/https` + `node:stream/web` 的 `ReadableStream`；先封印 `node:http/https` 惰性 getter，再接管 `globalThis.fetch` | 可复用参考工程已量产实现（`fetch-shim.js` 1,073 行 + `http-lazy-undici.js` 160 行）；覆盖 SSE / FormData / 重定向 / AbortSignal；**零第三方依赖** |
| B `node-fetch@3` | 纯 JS fetch 实现 | `Response.body` 是 Node stream，不是 Web `ReadableStream`；上游 SSE 用 `body.getReader()` ⇒ 仍需适配层；且要 vendor 依赖树 |
| C 自研精简版 | 只做 GET/POST JSON | SSE + FormData + 中止语义三个边界必踩，收益不抵风险 |
| D 不处理 | 接受「UI 能开、一说话就失败」 | 不可行：模型调用是核心功能 |

**明确不要做的事**（沿用已否证结论）：

- ❌ 只覆盖 `globalThis.fetch` 而不封 `node:http` 惰性 getter（触发点在惰性 getter）；
- ❌ `--no-experimental-fetch`（Node 24 已移除该 flag）；
- ❌ 用 `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 之类开放权限替代 JIT ACL（探针实测仍 SIGTRAP）；
- ❌ 运行期「查权限位决定 jit/compat」（权限位不是 JIT 可用性预检，误判 = 终态 `failed`）。

---

## 5. 双模式设计（编译期）

| 项 | `compat`（默认） | `jit` |
|---|---|---|
| 编译期常量 | `BuildConfig.NODE_MODE = 'compat'` | `BuildConfig.NODE_MODE = 'jit'` |
| 启动参数 | 库在脚本路径前插入 `--jitless`（`NodeRuntimeOptions.jitless = true`） | 现状：`--no-verify-heap --expose-internals` |
| ACL 声明 | **不声明** `ALLOW_WRITABLE_CODE_MEMORY`（零 ACL 可安装） | `requestPermissions` + `definePermissions` 成对声明 |
| 载荷 | `WebAssembly === undefined` ⇒ 装兼容层 | WASM 可用 ⇒ 兼容层**不安装**、全局零改动 |
| 性能 | 解释器执行（参考工程真机：热循环 7–10×；冷启动差异小） | 现状 |

**切换方式**：`node scripts/set-node-mode.mjs jit|compat`（幂等；同时改常量与 `module.json5` 声明面，
校验失败即拒绝写入）。`bash scripts/build-hap.sh --node-mode …` 会先调用它。

**运行期不切换**：`--jitless` 是进程级形态，进程内 Node 每进程只能起一次、失败即终态
（`ohos-node-bridge` 契约 §2.6）。ACL 探测只用于**打印依据**，不参与决策。

---

## 6. ACL 收敛口径（本轮定稿）

| 权限 | 处置 |
|---|---|
| `kernel.ALLOW_WRITABLE_CODE_MEMORY` | 仅 `jit` 形态声明；`compat` 形态声明面为 **0 项 ACL** |
| `READ_WRITE_DOCUMENTS_DIRECTORY` / `READ_WRITE_DOWNLOAD_DIRECTORY` | **保留声明**（`normal` + `user_grant`，本来就不需要 ACL）；**移出**签名 Profile 的 `acls.allowed-acls`（消除 `flag 2 / status -1` 矛盾态）。Profile 重签不在本次代码改动内，给复验命令 |
| 其余（Desktop / Pasteboard / FILE_ACCESS_PERSIST / EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY） | 已撤销，不再声明 |

---

## 7. 风险与未取证

| # | 项 | 处置 |
|---|---|---|
| R1 | 解释器模式性能退化（7–10×） | 写进验收口径；长回合/图片重编码最慢（参考工程 ≈15×） |
| R2 | Node 上游在讨论移除 `--jitless`（nodejs/node#66459） | 锁定 libnode v24.2.0；登记为观察项，升级运行时前必须重跑本需求的用例 |
| R3 | 真机 `--jitless` 下调真实模型（SSE） | 本次以「设备内回环自检（GET/POST/SSE/Abort）」+ 真机启动证据为准；真实 provider 调用视设备凭据情况补测 |
| R4 | Profile 未重签 | 本轮不改签名材料；文档给「重签后复验 ACL 面」的命令 |
| R5 | 设备侧 `--jitless` 冷启动耗时 | 真机实测记录（`logs/20261020-*`） |

---

## 8. 下一步

实现与验收见 [`../specs/109-jitless/`](../specs/109-jitless/)：`spec.md` → `plan.md` → `tasks.md` → `test-cases.md`。
