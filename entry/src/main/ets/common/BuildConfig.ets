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

/**
 * 204-plugin-git：真机取证用的 **Node inspector 端口**（编译期常量）。
 *
 *   · `0`  = 关闭（**默认**；提交里的值永远是 0 —— 源码态默认不开调试口）；
 *   · `>0` = 以 `--inspect=127.0.0.1:<port>` 启动进程内 Node。
 *
 * **由构建脚本按构建类型改写**：`bash scripts/build-hap.sh --debug` → `19229`；
 * `--release` → `0`（`scripts/set-inspect.mjs`，与 `set-node-mode.mjs` 同一范式）。
 * 直接用 DevEco 打开工程构建时不会改本文件，因此拿到的是**关闭**态。
 *
 * 只绑**回环**：设备之外要连上必须 `hdc fport tcp:<port> tcp:<port>`，不对外暴露；
 * 它只改变 Node 的 `flags` 字符串，不新增设置项、不改网关与围栏语义（见
 * `specs/204-plugin-git/spec.md` FR-204-050/051）。
 */
export const INSPECT_PORT: number = 0;
