# @dsh-ohos/branding —— DSH Desktop 品牌位

把 dsh Web UI 里的**产品身份**换成本产品的：侧栏 logo / 名称、会话空态 hero 品牌位、页面与窗口标题；并关掉上游"预览版说明"和 DeepSeek 首次配置的**自动**弹窗。

**上游零补丁**：只用上游公开的口子 —— 槽位注册、自有 locale 命名空间、`webServer.tapIndex`、`webserver/index-inject` 的 `style` 行、以及上游自己的两个配置项。规格见 [`specs/205-plugin-branding/`](../../specs/205-plugin-branding/spec.md)。

## 做了什么

| 位置 | 上游行为 | 本包做法 |
|---|---|---|
| 侧栏图标 / 名称 | 鱼形图标 + `brand.localBuild`（"DSH 本地构建"）兜底 | 占用 `sidebar.brand.mark` / `sidebar.brand.name`（两个 `single` 槽位），渲染产品图标 + 产品名 |
| 会话空态 hero | 鱼形图标 + `hero.headline`（"探索未至之境"）+ Preview 徽标 | 占用 `conversation.hero.brand.mark` 渲染"图标 + 产品名"；Host 半边下发一条 `style` 行，隐藏不含品牌位的那一路（标语 + 徽标） |
| 页面 / 窗口标题 | `<title>DSH Local Build</title>`，且客户端随后用 `brand.localBuild` 覆盖（切会话时重写） | Host 半边 `tapIndex` 改首屏 `<title>`；浏览器半边观察 `<head>`，把上游产品名替换成产品名（会话名前缀保留） |
| 首次弹窗 | "预览版说明"与 DeepSeek 首次配置自动弹出 | 不在本包：由 `packages/bundle-ohos/cordis.patch.yml` 的两条上游配置行关闭（见下） |

首次引导的三行配置（在 bundle 里，不在本包）：

```yaml
- id: ui-settings-general
  config:
    welcomeNoticeVersion: '2026-09-28.1'   # = 上游 WELCOME_NOTICE_VERSION
- id: ui-settings-models
  config:
    credentialOnboarding: false            # 只取消"自动弹出"，设置里仍可手动进入
- id: ui-brand-official
  disabled: true                           # 不使用上游官方品牌位
```

## 换 Logo / 改产品名

- **产品名**：`lib/client.js` 的 `zh`/`en` 字典（`product`）+ `lib/index.js` 的 `PRODUCT_TITLE`，两者必须与 `AppScope/resources/base/element/string.json` 的 `app_name` 一致。
- **图标**：`lib/client.js` 的 `LOGO_PATHS`（1024 viewBox 的路径与填色）。图标内联为 SVG，不走网络、不依赖 CSP 的 `img-src`。
- 改完跑 `node scripts/verify-upstream.mjs` 与 `specs/205-plugin-branding/plan.md` §5 的端到端断言。

上游若改了 `WELCOME_NOTICE_VERSION` 或 `brand.localBuild` 的中英文文案，`scripts/verify-upstream.mjs` 会**先红**并指出要同步的文件 —— 不要绕过它。

## 合规边界（不要越界）

- **不**伪造 `dshDesktop` 全局。那是上游"官方桌面壳"的开关，会顺带打开 `product-analytics` 的订阅与账号侧桌面引导分支；本包只做品牌，不碰这些。
- **不**删除上游的首次引导组件、**不**关闭 DeepSeek 账号/推理等业务入口 —— 只取消自动打扰。
- **保留**上游事实性归属（设置页里"登录 DeepSeek Harness 账号"之类文案、LICENSE、版权声明）。本包替换的是**产品身份**，不是抹去上游作者。
- 应用图标与包名属 `specs/108-compliance-release/`，不在本包范围内。

## 已知限制

- 上游改动 hero 结构时，隐藏标语的选择器会**不再匹配**（标语回归原样，不会误伤别的元素）。升级 dsh tag 时请重跑端到端断言。
- 窗口标题守卫认的是上游 `brand.localBuild` 的中英文两种文案；上游新增语言或改文案时需同步 `UPSTREAM_PRODUCT_TITLES`（门禁会先红）。
- 依赖 `CSS :has()`（ArkWeb 为 Chromium 内核，API 24 起可用）。
- 真机尚未验证（宿主 Node + Chromium 内核已通过正/负向断言）；`document.title` 是否被系统窗口标题采用需在设备上复核。

## 验证

```bash
node scripts/verify-upstream.mjs     # 上游零补丁 + 欢迎提示版本/标题文案/锚点对齐
node scripts/smoke-payload.mjs       # bundle 行与禁用行
# 端到端：宿主 Node 起载荷 → 浏览器断言（标题/侧栏/hero/无弹窗），并做一次去掉 bundle 行的负向对照
```
