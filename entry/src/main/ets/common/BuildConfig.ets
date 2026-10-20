/**
 * 109-jitless：**编译期**运行形态（本工程唯一的形态开关）。
 *
 * 背景：`kernel.ALLOW_WRITABLE_CODE_MEMORY` 是受限权限（需 ACL）。无 ACL 的设备上按 JIT 启动
 * 会在 V8 申请可执行页时 **SIGTRAP**（应用级失败，进程内 Node 不能重启）；有 ACL 时 `--jitless`
 * 只是变慢。两害相权，默认取 `compat`。
 *
 *   · `compat`（默认）：不声明 JIT ACL；`--jitless`；载荷安装纯 JS fetch 兼容层；
 *   · `jit`：声明 JIT ACL；不带 `--jitless`；兼容层一个动作都不做（原生行为）。
 *
 * 运行期**没有**调试参数、没有设置项、没有 ACL 探测参与决策 —— `--jitless` 是进程级形态，
 * 误判一次就是整机不可用（见 `docs/ACL-无ACL评估.md` §3.1）。
 *
 * 切换形态：`node scripts/set-node-mode.mjs jit|compat`（同时改本常量与 `module.json5` 声明面），
 * 然后重新构建。
 */
export const NODE_MODE: string = 'compat';
