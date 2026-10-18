# 宪法原则（constitution.md）

> 工程：`dsh-desktop-ark`
> 版本：v0.1（`000-scaffold`）
> 状态：**约束性文档**。与本文件冲突的实现一律视为缺陷，而不是"另一种风格"。
> 依据：`docs/000-工程规划.md` §1–§5、`deepseek-harness` 上游契约、`ohos-node-bridge` 硬约束。

本文件只写**能被检查**的原则：每条都有"违反时的可观察症状"。不可检查的口号不写入。

---

## 一、产品边界

### C1 上游是唯一事实源，本工程只做装配

- 不 fork、不改写 dsh Web 前端；不做 ArkUI 原生聊天界面。
- 平台适配优先走上游扩展点（profile / bundle / seam 插件）；上游源码补丁为 0 是目标。
- **违反症状**：`deepseek-harness` 工作区出现未登记的改动；`specs/` 里出现"我们改了前端"。

### C2 平台真相不隐藏

- 能力未实现就回 `not-implemented` + `hint`；未注册就回 `unregistered`；不返回伪造的成功。
- `--jitless`、无沙箱、无 PTY 等降级必须在 UI 与文档中显式登记。
- **违反症状**：能力调用返回 `{ok:true}` 但实际没做事；文档写"已支持"却无证据。

### C3 证据优先

- 任何"可用/通过"的结论必须附可复现证据：命令输出、截图、`ready.json`、`/facts` JSON、hilog 片段。
- 禁止作为判据：`uitest dumpLayout`、某一条 hilog、"目录存在"、"看起来生效"。
- **违反症状**：验收表里只有 ✅ 没有证据链接/片段。

---

## 二、运行时纪律

### C4 单进程、单实例、不可重启

- Node 跑在应用进程内（`node::Start` 每进程一次）；崩溃即终态，只能重启应用。
- 单实例（`launchType: singleton`）；端口必须随机（`--port 0`）。
- **违反症状**：代码里出现"自动重启 Node"；固定端口；多实例争同一 `filesDir`。

### C5 谁写谁读

- 载荷解包只能由 Node 自己完成；ArkTS 不得写入 Node 将要读取的树。
- `rawfile` 不是磁盘目录；随包载荷必须落 `resfile`。
- **违反症状**：ArkTS 解压后 Node 报 `MODULE_NOT_FOUND`；Node 直接读 `rawfile` 路径。

### C6 路径只用绝对路径

- 真机 `process.cwd()` 为 `/`、`execPath` 为 `/system/bin/appspawn`、`os.cpus().length` 为 0。
- 所有路径由 `context.filesDir` / `context.resourceDir` 派生。
- **违反症状**：任何相对路径的字面量；用 `cwd`/`execPath` 做探测或版本判断。

### C7 平台垫片必须可审计

- 垫片只允许 §5.3 白名单内的 5 条（`fs.link`、`fs.symlink`、`flock`、`sharp`、`node:sqlite`）。
- 每条垫片：唯一标记字符串、启动日志一行、`selfcheck` 断言、撤销条件。
- **违反症状**：`payload/shims/` 出现第 6 个文件却没有登记；垫片静默生效。

### C8 未捕获异常不得 abort 整个应用

- 载荷必须安装 `uncaughtException` / `unhandledRejection` 兜底：只落日志，不 `process.exit`（启动阶段致命错误除外）。
- **违反症状**：一个端口冲突/插件异常导致应用进程消失。

---

## 三、安全与隐私

### C9 鉴权只在 Host，不在壳里

- 页面进入靠 `authenticatedUrl` 的一次性 token → 303 签名 cookie（HttpOnly / SameSite=Strict）。
- 壳不做鉴权、不做 Host 头改写、不绑 `0.0.0.0`。
- **违反症状**：ArkTS 里出现 token 解析/校验；`--host 0.0.0.0`；`onBeforeSendHeaders` 之类改写。

### C10 权限最小化

- 未实现的能力不声明权限；`user_grant` 权限按需触发，不冷启批量弹窗。
- **违反症状**：`module.json5` 声明了代码从未使用的权限。

### C11 密钥与凭据不入库、不进日志

- 签名材料走 `signing.<mode>.local.json`（gitignored）或环境变量。
- token / cookie / API key 不得出现在 `app.log` 或诊断串。
- **违反症状**：仓库里出现 `.p12`/`.cer`/`signing.*.local.json`；日志能 grep 到 token。

---

## 四、工程质量

### C12 目录与编号即契约

- 规范文档编号（`NNN-<模块>-<二级模块>`）与代码目录一一对应；新增模块必须同时更新 `specs/SPECS_CHECKLIST.md`。
- **违反症状**：`specs/` 有目录但代码里找不到对应实现，或反之。

### C13 每次构建可复现

- 二进制（`libnode.so`、`dsh.tar.gz`、HAR）不入库；由脚本投放/生成。
- 构建脚本幂等；载荷有 `sha256` 幂等键。
- **违反症状**：仓库里出现 >10 MB 的二进制；重复构建产物 hash 不同。

### C14 文档描述"是什么"，不描述"希望是什么"

- 规范文档区分 `Status: implemented | planned`；未实现部分必须标 `planned` 并给出来源章节。
- **违反症状**：`planned` 的能力在测试用例里被当成已通过。

---

## 五、检查方式（可执行）

| 原则 | 检查点 | 方式 |
|---|---|---|
| C1 | 上游零补丁 | `git -C ../deepseek-harness status --porcelain` 为空 |
| C2 | 能力诚实 | `payload/selfcheck.js` 输出每项能力的 `implemented/not-implemented` |
| C3 | 证据 | `logs/<date>-N/` 下存在命令输出与截图 |
| C4 | 单实例/随机端口 | `module.json5` 的 `launchType`；`args` 含 `--port 0` |
| C5 | 谁写谁读 | `bootstrap.js` 是唯一解包者；`/facts` 的 `roots.extracted` 由 Node 给出 |
| C6 | 绝对路径 | `grep -rn "'\./" entry/src` 为空 |
| C7 | 垫片审计 | `/facts` 的 `shims[]` 与 §5.3 白名单逐项对齐 |
| C8 | 兜底 | `bootstrap.js` 含 `uncaughtException` 处理；故障注入后应用仍在 |
| C9 | 鉴权面 | `grep -rn "token" entry/src/main/ets` 只出现在透传字段 |
| C10 | 权限 | `module.json5` 的权限项与 §12.1 清单一致 |
| C11 | 秘密 | `git ls-files | grep -E "\.(p12|cer|pem)$"` 为空 |
| C12 | 编号对齐 | `specs/SPECS_CHECKLIST.md` 与目录树一致 |
| C13 | 可复现 | `scripts/` 全流程重跑产物 hash 稳定 |
| C14 | 状态标注 | `grep -rn "planned" specs/` 与实现状态一致 |
