# 109 无 JIT 模式 —— 实现方案（plan）

> 对应 spec：`specs/109-jitless/spec.md`｜决策：`docs/109-jitless-方案决策.md`｜更新：2026-10-20

## 1. 落点总览

| 层 | 文件 | 动作 |
|---|---|---|
| ArkTS 形态 | `entry/src/main/ets/common/BuildConfig.ets` | 新增：`NODE_MODE = 'compat'`（编译期常量） |
| ArkTS 形态 | `entry/src/main/ets/common/NodeMode.ets` | 新增：`resolve()` → `NodeModeDecision`（mode/reason/isCompat/describe），ACL 探测仅作诊断 |
| 启动编排 | `entry/src/main/ets/app/DshRuntime.ets` | 改：`jitless: decision.isCompat()`，启动前打一条形态事实 |
| 声明面 | `entry/src/main/module.json5` | 改：`compat` 默认不声明 JIT 权限（request/define 均无） |
| 兼容层 | `payload/jitless/{index.js,fetch-shim.js,http-lazy-undici.js}` | 新增：复用参考工程实现（来源标注；去掉 `PI_*` 条件入口耦合） |
| 兼容层自检 | `payload/jitless/selfcheck.js` | 新增：设备内回环自检（GET/POST/SSE/Abort） |
| 载荷入口 | `payload/bootstrap.js` | 改：异常兜底之后、垫片之前 `installIfNeeded()`；compat 下跑自检；事实传给 host |
| 载荷入口 | `payload/host.js` | 改：最终 `ready.json` 增加 `compat` 字段 |
| 切换脚本 | `scripts/set-node-mode.mjs` | 新增：幂等同步 `BuildConfig.NODE_MODE` 与 `module.json5` 声明 |
| 构建脚本 | `scripts/build-hap.sh` | 改：支持 `--node-mode jit|compat`（先调切换脚本） |

## 2. 关键实现决策

1. **形态只认常量**：`NodeMode.resolve()` 不读权限位做决策；ACL 探测只拼 `reason`（排障用）。
   非法常量 → fail-safe `compat`（FR-109-006）。
2. **`--jitless` 由库注入**：`NodeRuntimeOptions.jitless = true`（`NodeRuntime.ets:233` 会补齐且排在脚本路径前），
   不再自己拼 flags，避免同一参数两处来源。
3. **兼容层唯一开关**：`typeof WebAssembly === 'undefined'`。WASM 可用时直接返回
   `{active:false, webAssembly:'defined'}`，**不改任何全局**（NFR-109-001）。
4. **顺序承重**：先 `sealHttpLazyUndici()`，再 `installFetchShim()` —— 反序会在读
   `globalThis.Headers` 时先把 undici 拉起来。
5. **不碰上游**：兼容层只新增文件；`undici` 包不做条件入口（本工程无进程内消费者，见决策文档 §2 第 3 行）。
6. **自检不阻断**：`selfcheck.status` 只进日志与 `ready.json`；异常被兜住，Host 照常启动。

## 3. 数据流

```
BuildConfig.NODE_MODE
   ├─ NodeMode.resolve() ──► DshRuntime: jitless=true + hilog 依据串
   └─ module.json5（compat: 无 JIT 声明 / jit: 成对声明）

Node 启动(argv 含 --jitless) ──► bootstrap.js
   └─ typeof WebAssembly === 'undefined' ?
        ├─ 否 → compat.active=false（零动作）
        └─ 是 → sealHttpLazyUndici → installFetchShim → selfcheck
                  └─ 事实 → app.log + host.start(compat) → ready.json#compat
```

## 4. 兼容层 API（内部）

| 导出 | 语义 |
|---|---|
| `installIfNeeded(log)` | 幂等；返回 `{active, webAssembly, httpLazy, sealed, fetch, globals, fetchImpl}` |
| `sealHttpLazyUndici(log)` | 把 `node:http/https` 惰性 getter 换成普通值；返回带 `status` 的名字数组 |
| `installFetchShim()` | 接管 `globalThis.fetch`（缺则补 `Headers/Request/Response/FormData/Blob/File`），返回同样三态 |
| `shimFetch(input, init)` | 纯 JS fetch 实现（selftest 直接调用，不依赖全局接管） |
| `runSelfCheck(log)` | 回环自检，返回 `{status:'ok'|'failed', cases:[{name, ok, detail}]}` |

## 5. 构建与切换

```bash
node scripts/set-node-mode.mjs compat     # 默认；幂等；校验失败拒绝写入
node scripts/set-node-mode.mjs jit        # 出「有 ACL」变体
bash scripts/build-hap.sh --node-mode compat
bash scripts/build-hap.sh --node-mode jit
```

`set-node-mode.mjs` 的两处 pattern：

- `BuildConfig.ets`：`export const NODE_MODE: string = '<mode>';`
- `module.json5`：`requestPermissions` 与 `definePermissions` 中的 JIT 项（带固定注释锚点）

## 6. 验证矩阵

| # | 形态 | 环境 | 判据 |
|---|---|---|---|
| V1 | compat | 本机 `node --jitless` | `selftest.mjs` 全通；`globalThis.fetch` 被接管 |
| V2 | jit | 本机 `node`（WASM 可用） | 对照臂：兼容层 `active=false`，原生 fetch 仍可用 |
| V3 | compat | 真机 | HAP 安装成功；`node.log` argv 含 `--jitless`；`ready.json#compat.selfcheck.status=ok` |
| V4 | jit | 真机 | 回归：启动到 `RUNNING`，`compat.active=false` |
| V5 | — | HAP 内容 | `unzip -p … module.json` 在 compat 变体无 JIT 权限；jit 变体有 |

## 7. 回滚

- 代码回滚：删除 `payload/jitless/`、还原 `bootstrap.js`/`host.js`/`module.json5`/`DshRuntime.ets`，
  删除 `BuildConfig.ets`/`NodeMode.ets` 与切换脚本。
- 形态回滚：`node scripts/set-node-mode.mjs jit` 后重新构建（不需要回滚代码）。
