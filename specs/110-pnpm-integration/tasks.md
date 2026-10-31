# 110-pnpm-integration 任务分解

> 状态图例：⬜ 未开始 / 🟨 进行中 / ✅ 完成

| ID | 任务 | 落点 | 状态 |
|---|---|---|---|
| T-110-01 | pnpm 引擎物化 + 剪枝 + 断言 | `scripts/assemble-payload.mjs` | ✅ |
| T-110-02 | 契约插件骨架（package.json / lib/index.js / bundle 插入行） | `packages/market-ohos/` | ✅ |
| T-110-03 | worker 调用器（argv / execPath / symlink 回退 / CI / XDG / 完成信号） | `lib/pnpm-inprocess.js`、`lib/pnpm-worker.mjs` | ✅ |
| T-110-04 | 新 realm 兼容层安装（`DSH_OHOS_JITLESS_ENTRY`） | `lib/pnpm-worker.mjs`、`payload/bootstrap.js` | ✅ |
| T-110-05 | 单飞闸门（同步抛错）与取消 | `lib/pnpm-inprocess.js` | ✅ |
| T-110-06 | profile pnpm 配置生成（绝对 storeDir / autoInstallPeers / storeDir 自愈） | `payload/host.js` | ✅ |
| T-110-07 | worker 探针 + `__dshOhosMarket` 诊断 | `lib/index.js` | ✅ |
| T-110-08 | 单测（引擎断言 / argv / 单飞抛错与释放 / 取消 / probe） | `packages/market-ohos/test/` | ✅ |
| T-110-09 | 包 README（契约、限制） | `packages/market-ohos/README*.md` | ✅ |
| T-110-10 | 规格同步（specs/README、SPECS_CHECKLIST） | `specs/` | ✅ |
