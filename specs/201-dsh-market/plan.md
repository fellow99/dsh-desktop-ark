# 201-dsh-market 技术方案

> HOW 见 [`docs/pnpm+dsh-market.md`](../docs/pnpm+dsh-market.md) §3.1、§3.2、§3.5；本文件做 FR→落点映射与验证口径。

## 1. 落点映射

| FR | 落点 | 说明 |
|---|---|---|
| FR-201-001~005 | `scripts/assemble-payload.mjs` `collectDshMarket()` / `copyMarketRuntimeDeps()` / `assertDshMarketArtifact()` | 白名单复制 + 依赖闭包 + 闭包级断言 + 版本断言（1.66.42） |
| FR-201-006 | `profiles/ohos/package.json` | `dsh.profile.bundles` 追加 `dshmarket`（在 `@dsh-ohos/bundle` 之后） |
| FR-201-007 | 同上 | 不写 `dependencies.dshmarket` |
| FR-201-008 | `profiles/ohos/package.json` / 用户 patch | 不给市场行注入 `config.profile` |
| FR-201-010~013 | `payload/host.js`、`payload/bootstrap.js` | `DSH_PNPM_ENGINE`、`ensureProfilePnpmConfig()`、`DSH_OHOS_JITLESS_ENTRY` |
| FR-201-014 | `packages/market-ohos/lib/index.js` + 启动日志 | 契约提供/未提供各一行日志 |
| FR-201-020~021 | `packages/market-ohos/README*.md`、`docs/鸿蒙环境能力清单-0.2.1.md` | 限制披露 |

## 2. 装配顺序

```
overlay(stage)
  profiles/ohos                      → <stage>/profiles/ohos
  collectOhosPackages()              → <stage>/node_modules/@dsh-ohos/*
  collectGitRuntime()                → @dsh-ohos/git/node_modules
  collectMarketPNPM()                → <stage>/node_modules/dsh-market-pnpm   （012）
  collectDshMarket()                 → <stage>/node_modules/dshmarket         （201）
  installRequireBuiltinShim / flock / sharp / attachment 补丁
assertStage()
  + dshmarket 入口与闭包（由 collectDshMarket 内部断言）
  + insert 行可解析、无 symlink
```

## 3. 加载链路（as-built）

```
bootstrap.js ──解包──> host.js
  DSH_PNPM_ENGINE / ensureProfilePnpmConfig(profileDir)
  loadProfileDirectory('dsh', <runRoot>/profiles/ohos, <runRoot>/node_modules/@deepseek-ai/dsh/package.json)
    layers: dsh-base → dsh-web-app → @dsh-ohos/bundle → dshmarket
      @dsh-ohos/bundle 内插入行 market = @dsh-ohos/market → provide desktopProfiles/desktopPnpm
      dshmarket 的 cordis.patch.yml 插入行 dsh-market → apply()：ctx.get('desktopProfiles') 命中
```

## 4. 验证

| 层 | 手段 | 判据 |
|---|---|---|
| 构建期 | `assemble-payload.mjs --apply` | 版本/入口/闭包断言通过；`dshmarket/node_modules` 无 `@deepseek-ai` |
| 本机 | `node payload/bootstrap.js` + 浏览器打开 `ready.json` 的 url | 设置页出现「插件市场」；日志有「契约已提供」 |
| 真机 | 见 `test-cases.md` TC-201-* | 安装/使用/卸载三判据 |

## 5. 风险

见设计 §8：R1 网络、R4 市场版本漂移、R5 `ignoreScripts` 限制、R6 载荷分代、R8 hot mount 等待。
