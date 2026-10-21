# 技术方案：插件·品牌位（205-plugin-branding）

> 工程：`dsh-desktop-ark`
> 对应规格：[spec.md](./spec.md)（`FR-205-*` / `AC-205-*` / `NFR-205-*`）
> 宪法合规：C1（上游零补丁）、C2（不假装）、C12（编号即契约）
> 状态：implemented（宿主 Node 端到端 + 负向对照通过；真机待验）

---

## 1. 技术上下文

| 事实 | 结论 |
|---|---|
| `sidebar.brand.mark` / `sidebar.brand.name` / `conversation.hero.brand.mark` 均为 `single` 槽位，兜底是鱼形图标与 `brand.localBuild` | 占用即取代兜底（不需要隐藏/覆盖） |
| `locale.register(ns, {zh,en})` 对同一 (ns, 语言) 只允许一个占用者，重复注册**抛错** | 不能覆盖 `brand.localBuild` / `hero.headline`；只能占用槽位 + 自建命名空间 |
| `hero.headline` 与 `hero.preview` 是上游组件里的字面渲染，**无槽位** | 只能隐藏；隐藏的锚点必须是我们自己的标记（否则上游结构变化会误伤） |
| 槽位出口元素是 `div[data-slot="…"]`，`display: contents` | `:has()` 需要 `> span > [data-slot] [data-dsh-ohos-hero]` 这种"允许中间层级"的写法 |
| 窗口标题由 `ui-layout` 的 `DocumentTitle` 写入，产品名取 `process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')`；预构建产物里 `process.env` 被折叠成 `{}` | 标题恒为上游文案，且每次切换会话都会重写 ⇒ 需要"守卫"而非一次性赋值 |
| `webServer.tapIndex(transform)` 是上游公开的原始 HTML 变换口；`webserver/index-inject` 支持 `{kind:'style'}` 行 | 首屏标题与 hero 样式都不需要改上游 HTML 模板 |
| `@deepseek-ai/dsh-client-modules` 扫描**活动 Loader 行**的 `dsh.client` 声明并在运行时下发浏览器半边 | 本模块能在预构建的 Web 产物之外新增客户端插件（无需重编上游 web dist） |
| ArkWeb（API 24）为 Chromium 内核，`CSS :has()` / `MutationObserver` 可用 | 本模块的浏览器能力前提（NFR-205-03） |

---

## 2. 数据流

```
bundle 行 branding-ohos（packages/bundle-ohos/cordis.patch.yml）
  └─ @dsh-ohos/branding
       ├─ Host 半边（lib/index.js，ESM，cordis 插件）
       │    ├─ webServer.tapIndex(replacePageTitle)      → 首屏 <title>DSH Desktop</title>
       │    └─ webserver/index-inject → { kind:'style' }  → 隐藏上游 hero 标语/Preview 徽标
       └─ Browser 半边（lib/client.js，window.__ModuleLoader__.load）
            ├─ ctx.locale.register('brand.ohos', {zh,en})  → 自有文案（product）
            ├─ ctx.effect(installTitleGuard)               → 跟随上游标题写入，替换产品名
            └─ 槽位占用：sidebar.brand.mark / sidebar.brand.name / conversation.hero.brand.mark
```

首次引导（不涉及本插件代码，全在 bundle 配置层）：

| 行 | 操作 | 生效点 |
|---|---|---|
| `ui-settings-general` | `config.welcomeNoticeVersion = <上游 WELCOME_NOTICE_VERSION>` | `WelcomeNotice` 认为已致谢 ⇒ 不渲染 |
| `ui-settings-models` | `config.credentialOnboarding = false` | `DeepSeekOnboardingDialog` 的 `automatic` 为假且非显式 ⇒ `return null` |
| `ui-brand-official` | `disabled: true` | 上游官方品牌位不加载（即使构建环境切成 `official`） |

---

## 3. 接口契约

### 3.1 `@dsh-ohos/branding`（host 半边）

| 导出 | 说明 |
|---|---|
| `name = 'branding-ohos'` | 与 bundle 行 id 一致 |
| `inject = ['webServer']` | 两处注入都依赖它 |
| `PRODUCT_TITLE` | 产品名唯一来源（宿主侧）；`replacePageTitle` 使用 |
| `BRAND_MARKER = 'DSH_OHOS_BRANDING'` | 审计标记，出现在下发的样式注释里 |
| `HERO_ATTR = 'data-dsh-ohos-hero'` | 与浏览器半边同值（`verify-upstream.mjs` 校验） |
| `HERO_CSS` | 隐藏上游 hero 标语/徽标的规则 |
| `replacePageTitle(html)` | 幂等替换首个 `<title>`；无 `<title>` 时原样返回 |

### 3.2 `@dsh-ohos/branding`（browser 半边）

| 导出 | 说明 |
|---|---|
| `inject = ['slots', 'locale']` | 槽位与文案 |
| `NS = 'brand.ohos'` | 自有命名空间（不占用上游） |
| `SidebarMark` / `SidebarName` | 侧栏 logo / 产品名 |
| `HeroBrand` | hero logo + 产品名；根节点带 `data-dsh-ohos-hero` |
| `rewriteTitle(raw, product)` | 纯函数：把上游产品名替换成产品名（可单测） |
| `installTitleGuard(product)` | 立即纠正一次 + 观察 `<head>` 变化；返回卸载函数 |
| `UPSTREAM_PRODUCT_TITLES` | 上游 `brand.localBuild` 的中英文文案（`verify-upstream.mjs` 校验覆盖） |

---

## 4. 关键实现决策

1. **为什么宿主也要改标题**：`tapIndex` 让首屏（客户端脚本执行前）就是产品名，避免闪过上游标题；浏览器半边的守卫负责后续被上游改写的情况。两层职责不同，都要保留。
2. **为什么隐藏 hero 标语用 CSS 而不是 DOM 手术**：`style` 行在 `<head>` 里、先于首帧生效，没有闪烁；以 `data-dsh-ohos-hero` 为锚点 ⇒ 品牌位没装上（插件未激活/加载失败）时规则**不匹配**，界面回退成上游原样而不是空白（FR-205-012）。
3. **为什么不用伪造 `dshDesktop` 全局**：那会顺带打开 `product-analytics` 的服务订阅与账号侧的桌面引导分支（上游 `ui-settings-account` 的 `desktopOnboardingVisible`），属于"用别人的开关换自己的目的"，违反 C2 与 FR-205-009。
4. **为什么标题用 `MutationObserver` 而不是拦截 `document.title` setter**：不修改平台 API；`apply` 幂等，无变化不写入，观察器不会自激（NFR-205-02）。
5. **为什么首次引导走配置而不是删组件**：删除等于让用户永久失去入口；`credentialOnboarding=false` 只是取消"自动弹出"，设置页条目仍在（FR-205-007）。
6. **为什么 `ui-brand-official` 显式禁用**：当前载荷产物里 `process.env` 被折叠，该行本就不会注册；显式禁用是**意图声明 + 未来防线**，避免构建环境变化时冒出上游官方标识（FR-205-008）。

---

## 5. 验证

| 门禁 | 命令 | 断言 |
|---|---|---|
| 上游零补丁 + 配置对齐 | `node scripts/verify-upstream.mjs` | tag/clean/patch id；`welcomeNoticeVersion` == 上游常量；`ui-brand-official` 已禁用；`branding-ohos` 行存在；两半边 `HERO_ATTR` 同值；上游 `brand.localBuild` 两种文案都被覆盖 |
| 装配 | `node scripts/smoke-payload.mjs` | 行数、禁用行含 `ui-brand-official`、`@dsh-ohos` 行含 `branding-ohos` |
| 端到端（宿主 Node） | `node --expose-internals payload/bootstrap.js` + 浏览器断言 | 标题/侧栏/hero 品牌位、上游标语与徽标不可见、无弹窗、`__DSH_BOOT__` 含本插件、注入的 `<style>` 存在；`zh-CN` 与 `en-US` 两种语言各跑一遍 |
| 负向对照 | 去掉三条 bundle 行重跑同一断言集 | 回到上游表现（标题=`DSH 本地构建`、鱼形图标、标语+徽标可见、"预览版说明"弹窗出现） |

已跑通的证据（本轮）：正/负向各一次，语言 zh-CN / en-US；正向 14 项断言全绿（其中 `http status 200` 覆盖入口跳转）。截图与报告在会话临时目录，不入库。

---

## 6. 文件清单

| 文件 | 作用 |
|---|---|
| `packages/branding-ohos/package.json` | 包清单：`main`（host 半边）、`exports./client`（browser 半边）、`dsh.client`（注入包声明 + `platform: web`） |
| `packages/branding-ohos/lib/index.js` | host 半边：标题、`style` 行、常量与审计标记 |
| `packages/branding-ohos/lib/client.js` | browser 半边：三个品牌槽位、自有 locale、标题守卫、内联 SVG 图标 |
| `packages/branding-ohos/README.md` | 用法、替换点、合规边界、已知限制 |
| `packages/bundle-ohos/cordis.patch.yml` | 挂载行 `branding-ohos`；首次引导两行配置；`ui-brand-official` 禁用 |
| `scripts/verify-upstream.mjs` | 6/7/8 号门禁：欢迎提示版本、品牌锚点、上游标题文案 |
| `specs/205-plugin-branding/{spec,plan}.md` | 本需求文档 |

不改动：`../deepseek-harness` 任何文件（`verify-upstream.mjs` 断言工作树干净）、`entry/`、`payload/`、既有 seam 插件。

---

## 7. 已知限制与升级路径

| 限制 | 影响 | 处置 |
|---|---|---|
| 上游改了 hero 结构 | 隐藏规则不匹配，标语回归 | 门禁不覆盖 DOM 结构 ⇒ 依赖 `spec.md` AC-205-01 的回归脚本；升级 tag 时重跑并调整选择器 |
| 上游改了 `WELCOME_NOTICE_VERSION` | 预览提示重新弹一次 | `verify-upstream.mjs` 先红；同步 `cordis.patch.yml` 一行 |
| 上游改了 `brand.localBuild` 文案 | 标题守卫漏替换（标题回退） | `verify-upstream.mjs` 先红；同步 `UPSTREAM_PRODUCT_TITLES` |
| ArkWeb 不支持 `:has()` | 标语无法隐藏 | 已确认 ArkWeb 为 Chromium 内核（API 24）；真机 L1 复核 |
| 真机未验 | 图标渲染尺寸 / 系统窗口标题 / 语种跟随 | 记入 `spec.md` §7，随 L1 取证 |
