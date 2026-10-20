/**
 * OHOS 垫片 S3：`@deepseek-ai/node-addon-system/flock` 的单进程替身。
 *
 * 【为什么必须替换】上游 `lib/flock.js` 只在 `linux` / `darwin` 上加载原生 binding；
 * OHOS 会抛 `flock is not supported on openharmony-arm64`，而
 * `dsh-session-persistence-jsonl` 在**第一次写入会话**时就会取这把锁 ⇒ 首轮对话直接失败。
 *
 * 【为什么"立即成功"是正确的】该锁的语义是「跨进程写所有权」。本工程是**单进程**宿主
 * （`node::Start` 每进程一次，见 `ohos-node-bridge` 契约 §2.6），JSONL 后端自己的
 * in-process write claim 已经排除了所有写者；上游 webworker 运行时对同一模块用的就是
 * 这个替身（`dsh-experimental-webworker-runtime/lib/types/node/external_packages/
 * node-addon-system-flock.js`）。
 *
 * 【契约】与上游一致：`tryLockExclusive(fd): Promise<void>`；成功 resolve，争用 reject
 * `EAGAIN`/`EWOULDBLOCK`。单进程下没有争用，因此永远 resolve。
 *
 * 标记：DSH_OHOS_FLOCK_STUB（`payload/shims/flock.js` 用它判定替换是否真的生效）
 */

export async function tryLockExclusive(_fd) {
  return;
}

export const __esModule = true;

export default { tryLockExclusive };
