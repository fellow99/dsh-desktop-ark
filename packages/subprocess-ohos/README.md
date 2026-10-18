# `@dsh-ohos/subprocess`

`ctx.subprocess` 的 HarmonyOS 实现，替换上游 `@deepseek-ai/dsh-subprocess-local`（bundle 里 `subprocess` 行被禁用后插入本包）。

## 契约

服务定义：`packages/subprocess/subprocess/src/index.ts:117-162`；类型 `types.ts:22-297`。

| 方法 | 状态 | 说明 |
|---|---|---|
| `resolveExecutable(command, env?, signal?)` | implemented | 绝对路径 + PATH 解析；拒绝含分隔符的相对路径；失败抛 `SubprocessExecutableNotFoundError` |
| `terminalEnvironment()` | implemented | `{ platform:'posix', defaultShell:'/system/bin/sh' }` |
| `spawn(spec)` | implemented | 同步返回活句柄；`done` 只回 `{exitCode, signal}` |
| `spawnTerminal(spec)` | **partial / 明确不支持** | 无 PTY（无 `/dev/ptmx`），抛 `SubprocessUnsupportedError`（`code:'not-supported'`）。上游终端消费者不可用 |

## 平台围栏（本包就是执行点）

- **可执行文件**：`/system/bin/**`、`/system/bin/toybox`、以及工作区内可执行文件。所有路径先 `realpath` 再前缀校验，符号链接无法把别的二进制带进来。
- **cwd**：必须绝对、存在、是目录，且位于可写根（工作区、`/tmp`、`os.tmpdir()`）内。**从不使用 `process.cwd()`**（真机上是 `/`）。
- **环境**：只继承 `PATH`/`HOME`/`TMPDIR`/`LANG` 与 `DSH_*`，且丢掉 `KEY|PASSWORD|SECRET|TOKEN` 形状的名字；`spec.env` 显式条目最后合并（与上游“scrub 后 merged explicit”一致）。
- **graceMs** ∈ `(0, 2147483647]`；预中止的 `signal` 同步抛 `aborted before spawn: …`（对齐 `subprocess-local/src/spawn.ts:164-181`）。
- **取消**：`terminate()`/abort → 进程组 `SIGTERM`，`graceMs` 后 `SIGKILL`；幂等。

## 输出语义

`lib/output.js` 与上游 `OutputCollector`（`subprocess-local/src/output.ts:250-316`）同构：

- collect 模式的 `collected.stdout/stderr.readFrom(fromByte)` **非消费、按全流字节偏移**；
- `lossy = 偏移已滑出内存窗口`，`spillPath = 完整流文件`（当全流未超 `spill.maxBytes`）；
- 内存窗口保留**尾部** `maxBytes`；spill 打开/写入失败只降级为“仅内存尾部”，不中断收集；
- `done` 之后仍可读（`seal()` 只关文件）。

## 配置

与上游 `subprocess-local` 一样：**没有配置键**（`subprocess-local/src/index.ts:1-8`）。bundle 行 `subprocess-ohos` 不带 `config`。

## 已知限制

- 只终止**直接子进程/其进程组**；不做 Linux 的 `/proc` 进程组存活探测（上游 `process-inspector.ts` 在 OHOS 无对应物）。
- 非 POSIX 主机（开发机 Windows）上无法验证真实 spawn；smoke 测试只覆盖校验/围栏/输出窗口。
- `spawnTerminal` 不可用 = 上游“终端面板”整条能力缺失，属平台事实（规划 §5.4）。
