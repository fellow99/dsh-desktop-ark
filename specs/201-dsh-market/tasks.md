# 201-dsh-market 任务分解

> 状态图例：✅ 未开始 / 🟨 进行中 / ✅ 完成

| ID | 任务 | 落点 | 状态 |
|---|---|---|---|
| T-201-01 | dshmarket 物化 + 依赖闭包 + 闭包级断言 | `scripts/assemble-payload.mjs` | ✅ |
| T-201-02 | profile bundles 声明（不加 dependencies） | `profiles/ohos/package.json` | ✅ |
| T-201-03 | 装配顺序接线（pnpm 引擎 → dshmarket） | `scripts/assemble-payload.mjs` `overlay()` | ✅ |
| T-201-04 | `DSH_PNPM_ENGINE` + `ensureProfilePnpmConfig()` | `payload/host.js` | ✅ |
| T-201-05 | `DSH_OHOS_JITLESS_ENTRY` | `payload/bootstrap.js` | ✅ |
| T-201-06 | 契约提供日志（provided / not-provided） | `packages/market-ohos/lib/index.js` | ✅ |
| T-201-07 | 能力清单与 README 披露（限制 / 体积） | `docs/鸿蒙环境能力清单-0.2.1.md`、`README*.md` | ✅ |
| T-201-08 | 真机验收（安装 / 使用 / 卸载） | 真机 | 🟨（API 全链路通过；UI 点击部分未完成） |
| T-201-09 | 权限卡片随宿主 `permission` 行禁用（`ui-permission`） | `packages/bundle-ohos/cordis.patch.yml` | ✅ |
| T-201-10 | 构建期拒绝「源码比产物新」的市场包 | `scripts/assemble-payload.mjs` | ✅ |
