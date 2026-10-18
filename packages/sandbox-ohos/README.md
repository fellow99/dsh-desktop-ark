# `@dsh-ohos/sandbox`

`ctx.sandbox` 的 HarmonyOS 实现：**只有策略层，没有内核隔离**。

## 为什么是“策略层”

上游 `sandbox-local` 在无后端时 fail-closed 抛 `SandboxUnavailableError`（`packages/sandbox/sandbox-local/src/index.ts:153-158`）。HarmonyOS 应用域没有 bwrap/Landlock/Seatbelt/ACL 等价物；工程决定是“工具调用不因 sandbox 缺失而失败，但必须在 UI/诊断里诚实显示无隔离”（规划 §5.2 #3、§5.4）。因此：

- `confine(argv, policy)` **不改写 argv**，返回 seam 的 `ConfinedArgv` 形状：
  `{ argv, enforcement:'partial', denialSignatures:[], runnerFailureRules:[], isolation:'none', enforced:false, mode, workspaceRoot }`；
- `enforcement:'partial'` 是契约词汇里最接近的值（“无法治理所有承诺的文件效果”），但额外字段 `isolation:'none'` / `enforced:false` 明确表示**没有任何边界**；
- `capabilities()` 返回 `{ sandbox:'none', kernelIsolation:false, enforcement:'none', argvRewrite:false, policyLayer:true }`；
- 需要 fail-closed 的部署可调用 `confineStrict()`：除 `danger-full-access` 外一律抛 `SandboxUnavailableError`（`code:'SANDBOX_UNAVAILABLE'`）。

## 策略层（真实实现）

- `writableRoots(policy)`：`read-only → []`；`workspace-write → [workspaceRoot, /tmp, os.tmpdir(), <userRoot>/{Desktop,Documents,Download}]`（canonical 去重）。`danger-full-access → []`（表示无界）。
- `isPathWritable(path, policy)`：按上面派生根做 canonical 包含判定。
- `validatePolicy(policy)`：`mode` ∈ 三值；`workspaceRoot` 必须绝对。
- **没有 `writableRoots` 配置键**：上游 `sandbox-policy` 的 `Config` 只有 `mode`/`workspaceRoot`（`packages/sandbox/sandbox-policy/src/index.ts:71-79`），本包同样不引入新配置键。

> 注意：上游 `fs-sandbox` 用的是它自己的 `writableRoots(policy)`（`packages/sandbox/sandbox/src/roots.ts:52-55`，只有 workspace + `/tmp` + tmpdir），本包导出的判定函数供**我们自己的** fs 侧消费者使用；两者语义差异已在 README/报告中记录。

## 配置

无配置键（bundle 行 `sandbox-ohos` 不带 `config`）。`workspaceRoot` 来自 `SandboxExecutionPolicy` / `sandbox-policy` 行。

## 已知限制

- 这是**可信代码里的策略检查**，不是内核边界；恶意命令可以绕过。
- 用户目录（Desktop/Documents/Download）需要系统授权，未授权时策略层允许但真实写入会被内核拒绝。
