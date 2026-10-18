# `@dsh-ohos/shell`

`ctx.shell` 的 HarmonyOS 实现（bundle 行 `shell-ohos`），顶替上游 `bash-sandbox`/`bash-local`。

## 契约

服务定义：`packages/shell/shell/src/index.ts:64-94`；类型 `types.ts:140-238`。

- `resolve(request)`：夹紧超时（`min(request.timeoutMs ?? config.timeoutMs, 600000)`），`workdir` 默认取 `DSH_OHOS_WORKSPACE`，**绝不使用 `process.cwd()`**；`onExpiry` 默认 `'kill'`；`sandboxPolicy` 原样透传。
- `execute(spec)`：返回 `ShellExecution`（`status/exitCode/signal/done/readOutput/observed/kill/result`）。
- `result()` 只对基础设施失败 reject；非零退出/超时/abort 都 resolve，`timedOut`/`aborted` **首因互斥**；`done` 永不 reject。
- `readOutput()` 消费式；`observed.stdout/stderr` 非消费偏移读；退出后仍可读。

## 常驻 `sh` + 哨兵行

无 PTY（`/dev/ptmx` 不存在），因此复用一个常驻 `/system/bin/sh`（`lib/framing.js`）：

```
printf '%s\n' '__DSH_BEGIN_<nonce>__'
(
cd -- '<workdir>' || exit 125
<command>
)
printf '\n%s %s\n' '__DSH_END_<nonce>__' "$?"
```

- 命令在**子 shell** 里跑：`cd`、变量、`exit` 都不跨调用残留；每次调用前置 `cd`。
- 哨兵由 `crypto.randomBytes(12)` 生成，命令输出撞上的概率可忽略；哨兵行从捕获输出中剔除。
- `cd` 失败 → 退出码 125 + 一行 `shell-ohos: cannot change directory to …` 到 stderr。
- 超时/abort/`kill()` → 终止该 `sh`，下一次调用自动重启；捕获到的部分输出保留。
- 带 `stdin` 的调用改用一次性子进程（`sh -c`），否则 stdin 会破坏哨兵分帧。

## 配置（必须与 bundle 行一致）

| 键 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | `120000` | 默认前台超时 |
| `shellPath` | `/system/bin/sh` | 必须绝对路径 |

其余预算为常量：`MAX_TIMEOUT_MS=600000`、`MAX_OUTPUT_BYTES=64000`、`MAX_SPILL_BYTES=64MiB`、`GRACE_MS=3000`。

## 已知限制

- 不提供真终端：无 PTY，因此没有交互式会话、没有窗口尺寸、没有前台进程组。
- `sandboxMode` 返回 `undefined`：本执行器不做任何隔离（`@dsh-ohos/sandbox` 诚实上报 `sandbox:'none'`）。
- `stdout`/`stderr` 是两条独立管道，合并读取（`readOutput`）时顺序不保证与终端一致。
- 超时后重新拉起 `sh`：上一次命令若 fork 了后台进程，只有进程组被 SIGTERM/SIGKILL 波及，未做存活探测。
