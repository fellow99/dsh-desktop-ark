# 012-pnpm-integration 技术方案

> HOW 见 [`docs/pnpm+dsh-market.md`](../docs/pnpm+dsh-market.md) §3.1、§3.3、§3.4、§3.5；本文件只做 FR→落点映射与验证口径。

## 1. 落点映射

| FR | 落点 | 说明 |
|---|---|---|
| FR-012-001~005 | `scripts/assemble-payload.mjs` `collectMarketPNPM()` / `prunePnpmEngine()` / `assertPnpmEngineArtifact()` | pnpm 10.34.6 → `<stage>/node_modules/dsh-market-pnpm`；版本/入口断言；剪枝 |
| FR-012-006~008 | `payload/host.js` `ensureProfilePnpmConfig()` | 运行期生成 `pnpm-workspace.yaml`（绝对 `storeDir`），仅缺失时写 |
| FR-012-010~016 | `packages/market-ohos/lib/pnpm-inprocess.js`、`lib/pnpm-worker.mjs` | worker、argv、execPath、symlink 回退（真机 + 冒烟观察，单测未覆盖）、CI/XDG、完成信号 |
| FR-012-017 | 同上 | worker 起不来 → 127（无同线程降级） |
| FR-012-018 | 同上 | `cancel()` / abort → `worker.terminate()`；父侧补 stderr |
| FR-012-019 | `lib/pnpm-inprocess.js` | 单飞闸门，同步抛错（busy 语义） |
| FR-012-020~024 | `packages/market-ohos/lib/index.js` | 只认 `profileContext.dir`；provide 两服务；args 透传 + `--dir` |
| FR-012-030~032 | 同上 + `payload/bootstrap.js` | 日志前缀、worker 探针、`__dshOhosMarket` |
| FR-012-040~043 | 全体 + `scripts/assemble-payload.mjs` | 幂等、零新增权限、`ignoreScripts`、undici 替身 |

## 2. 关键实现约束

1. **新 realm**：worker 内必须先装 jitless 兼容层（`DSH_OHOS_JITLESS_ENTRY`），否则 `node:http` 会拉起 undici（WASM 不可用）。
2. **完成信号**：只有 worker 退出码可信；不得用 `import()` 返回。
3. **加载方式**：`await import(pathToFileURL(entry).href)`；不 require（pnpm 的 `bin/pnpm.cjs` 是 CJS 入口，import 亦可）。
4. **argv 形态**：`[execPath, entry, ...marketArgs, '--dir', profileDir]`。
5. **不改主线程**：worker 之外不动 `process.argv` / `process.exit`。

## 3. 验证

| 层 | 手段 |
|---|---|
| 单测 | `node --test packages/market-ohos/test/*.test.mjs`（引擎断言、argv 合成、单飞抛错/释放、取消、probe） |
| 构建期 | `node scripts/assemble-payload.mjs --apply` 的断言输出 |
| 本机 | `node payload/bootstrap.js`（dev root）+ 本机真 pnpm 安装测试包 |
| 真机 | 市场安装/卸载 + `hdc shell ls` + `app.log` |

## 4. 风险

见设计 §8 R1–R8；本模块重点：R2（jitless 安装耗时）、worker 可用性。
