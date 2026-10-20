# 109-jitless —— 测试用例（test-cases）

> 判据口径：✅ 本机/真机实测 ｜ 🔶 沿用参考工程 ｜ ⚠️ 推断 ｜ ⬜ 未取证
> 设备：`3QC0226526001227`（HAD-W32 / 2in1 / HarmonyOS 7.0.0.107 / API 26）
> 实测记录：`logs/20261020-2/TEST_REPORT.md`（compat 与 jit 两个 HAP 各一轮）

## A. 本机（PC）

### TC-109-001 jit 对照臂：兼容层零动作
- 前置：本机 Node v24.x（WASM 可用）
- 步骤：`node payload/jitless/selftest.mjs`
- 期望：`WebAssembly defined`；`installIfNeeded().active === false`；`globalThis.fetch` 仍是原生实现；回环自检（GET/POST/SSE/Abort/FormData）走**原生 fetch** 全通；另用 `shimFetch` 直连再跑一轮全通（证明垫片实现本身不依赖 WASM）
- 证据：终端输出

### TC-109-002 compat 目标臂：fetch 全能力
- 前置：`node --jitless`
- 步骤：同上
- 期望：`typeof WebAssembly === 'undefined'`；`active=true`、`httpLazy=installed`、`fetch=installed`；回环自检全 ok（`response.body` 是 `ReadableStream` 且能 `getReader()`）；**同一脚本再用 `shimFetch` 直连跑一轮**（区分「垫片坏了」与「接管坏了」）
- 证据：终端输出

### TC-109-003 惰性 getter 封印的正确性
- 步骤：compat 下读 `http.maxHeaderSize`（数值 16384）、`https.globalAgent.protocol === 'https:'`、`https.request` 可发起请求
- 期望：不触发 undici/WASM 初始化；https 默认 agent 仍可用（参考实现踩过的坑）
- 证据：`runSelfCheck` 的 `http-lazy-sealed` 用例（`maxHeaderSize` 为数值、`https.globalAgent.protocol === 'https:'`）。`https.request` 的端到端不在自检里造 TLS 服务，沿用参考工程 🔶 实测

### TC-109-004 切换脚本幂等
- 步骤：`node scripts/set-node-mode.mjs compat` 连跑两次；再 `jit` 连跑两次
- 期望：第二次无文件变化（`git diff` 为空）；非法参数退出码 ≠ 0；pattern 不匹配时拒绝写入
- 证据：命令输出 + `git status`

### TC-109-005 HAP 声明面
- 步骤：构建 compat HAP → `unzip -p entry-default-signed.hap module.json | jq '.module.requestPermissions'`
- 期望：无 `ALLOW_WRITABLE_CODE_MEMORY`；目录两项仍在；`definePermissions` 无 JIT
- 步骤：`--node-mode jit` 构建 → 同上
- 期望：两处均出现 JIT 权限

## B. 真机

### TC-109-006 compat HAP 安装与启动
- 步骤：`hdc install -r entry-default-signed.hap`；`hdc shell aa start -a EntryAbility -b org.fellow99.dsh.DshDesktopArk`
- 期望：安装成功；应用进入 `RUNNING`；`node.log` 的 `argv` 中 `--jitless` 位于脚本路径之前；无 `Cpp Crash`
- 证据：`hdc shell cat .../payload/{node.log,ready.json}`、`hilog`

### TC-109-007 compat 兼容层事实
- 步骤：读 `ready.json`
- 期望：`compat.active=true`、`webAssembly=undefined`、`fetch=installed`、`selfcheck.status=ok`（GET/POST/SSE/Abort 四例全过）
- 证据：`ready.json` 原文

### TC-109-008 compat UI 可用性
- 步骤：拉起 UI，确认页面加载、输入框可交互；触发一次本地路由请求（页面自身 `/_ohos/*` 或首页数据）
- 期望：页面正常渲染，无「服务未就绪」；Host 日志无 fetch 异常
- 证据：截图 + `app.log`

### TC-109-009 jit HAP 回归
- 步骤：`node scripts/set-node-mode.mjs jit` → 构建 → 安装 → 启动
- 期望：`node.log` 无 `--jitless`；`ready.json#compat.active=false`；启动耗时与改造前同量级
- 证据：`node.log`、`ready.json`

### TC-109-010 权限面复核
- 步骤：`hdc shell "atm dump -t -b org.fellow99.dsh.DshDesktopArk" | grep -E "DOCUMENTS|DOWNLOAD|WRITABLE"`
- 期望（compat 变体）：目录两项存在（用户授权语义），JIT 项不存在
- 证据：dump 输出

## C. 回归与降级

### TC-109-011 现有能力回归（compat 下）
- `node:sqlite` + FTS5：`ready.json#sqlite` 为 `available=true fts5=true`
- `sharp` 替身：图片读写走宿主桥，不抛错
- 工作区选择器：沙箱根可列；文档/下载按授权态如实呈现

### TC-109-012 未覆盖的 WASM 能力如实失败
- 步骤：若将来挂载文档转换/code-mode，调用一次
- 期望：返回明确错误（`WebAssembly is not defined` 被捕获并转成业务错误），进程不崩
- 证据：日志（当前 ⬜ 未挂载，登记）
