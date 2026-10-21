# 规格：插件·品牌位（205-plugin-branding）

> 工程：`dsh-desktop-ark`（ArkWeb + 进程内 `libnode.so`）
> 需求编号：`205-plugin-branding`　需求名称：插件：品牌位（Logo / 名称 / 窗口标题）
> 状态：**implemented**（宿主 Node 上跑通端到端断言 + 负向对照；真机未验，见 §7）
> 来源：
> - 需求原文（需求方提供）：上游的 Logo 与标题必须按本产品身份替换，且**不得引入上游源码补丁**
> - `../dsh-desktop-hos/patches/dsh-v0.2.1-rc.2/dsh-rebrand.patch`（Electron 版做法：改上游 locale 与组件源码，**本工程不复用**）
> - `../dsh-desktop-hos/patches/dsh-v0.2.1-rc.2/dsh-disable-welcome-notice.patch`（Electron 版做法：整块摘除首次引导 UI，**本工程不复用**）
> - 本工程：`specs/constitution.md`（C1 上游零补丁、C2 不假装）、`specs/105-upstream-adapter-bundle/`（bundle 覆盖层范式）、`specs/108-compliance-release/`（标识与合规边界）
> 需求语言遵循 RFC 2119（MUST / SHOULD / MAY）。**本文件只写 WHAT（可验证的行为），实现细节在 `plan.md`。**

---

## 1. 模块概述

**目的**：让运行在 ArkWeb 里的 dsh Web UI 以**本产品的身份**出现：侧栏 logo 与产品名、会话空态 hero 的品牌位、窗口/页面标题；同时让上游的"预览版说明"与 DeepSeek 首次配置引导**不再自动弹出**，但能力本身不删。

**问题**：
- 上游 Web 客户端把产品身份写死在三处：`sidebar.brand.mark` / `sidebar.brand.name` 的**兜底**（鱼形图标 + `brand.localBuild`）、会话空态 hero 的**标语**（`hero.headline`）与 Preview 徽标、以及窗口标题（`ui-layout` 的 `DocumentTitle` 用 `process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')`，预构建产物里 `process.env` 被折叠成空对象 ⇒ 恒取 `brand.localBuild`）。
- `brand.localBuild` / `hero.headline` 属于上游命名空间，`locale.register` 对同一 (命名空间, 语言) 只允许一个占用者（重复注册**抛错**）⇒ 客户端插件**无法**用 locale 覆盖这两条文案。
- hero 标语与 Preview 徽标**没有槽位**，是上游组件里的字面渲染。
- 首次引导（预览版说明 + DeepSeek 首次配置）在上游是两个 `settings.onboarding` 行，行由上游插件注册，**第三方插件无法注销他人的注册**。
- 若照搬 Electron 版补丁：改上游 `locale`/组件源码 ⇒ 违反 C1（上游零补丁），且每次升 tag 都要重做。

**范围**：
- 范围内：侧栏品牌位（logo + 名称）、会话空态 hero 品牌位（logo + 名称）、页面/窗口标题、上游 hero 标语与 Preview 徽标的隐藏、首次引导两个自动弹窗的关闭、上游"官方品牌位"行的禁用、上游文案漂移的构建期门禁。
- 范围外：上游源码改动、`dshDesktop` 全局的伪造、产品分析上报的开启、账号/推理等业务身份、应用图标与包名（属 `108`）、应用商店文案。

**与 Electron 版的关系**：目标一致（产品身份替换 + 不打扰的首次体验），**手段相反**——Electron 版改上游源码；本工程只用上游官方的配置口、槽位、locale 命名空间与 index 注入口，属"零补丁"实现。Electron 版的补丁**不作为本模块依据**，只作为行为对照。

---

## 2. 用户故事

- 作为用户，我打开应用看到的是"DSH Desktop"和本产品图标，而不是上游的鱼形标识与"本地构建"字样。
- 作为用户，我不希望第一次打开就被上游的"预览版说明"和"DeepSeek 首次配置"弹窗拦住；需要时我能自己从设置里找到它们。
- 作为用户/审核方，我能看到这个界面**不是** DeepSeek 官方构建的界面，不会把本产品误认成官方发行版。
- 作为维护者，我希望上游改文案或改结构时**构建先红**，而不是等用户发现界面回退。
- 作为维护者，我希望换 logo/改产品名只改**一处常量**，不碰逻辑。

---

## 3. 功能需求

### 3.1 品牌位（Brand Slots）

- **FR-205-001**：侧栏的品牌图标位与品牌名称位 MUST 由本产品占用，MUST NOT 呈现上游鱼形图标或 `brand.localBuild` 文案（任何语言）。
- **FR-205-002**：会话空态的 hero 品牌位 MUST 呈现本产品图标 + 产品名，MUST NOT 呈现上游 `hero.headline` 标语与 `hero.preview` 徽标。
- **FR-205-003**：窗口/页面标题 MUST 为产品名；上游随后把标题改写成「会话名 — 上游产品名」时，标题 MUST 仍以本产品名收尾（会话名部分保留）。
- **FR-205-004**：品牌位与标题的实现 MUST 只使用上游公开口子（槽位注册、自有 locale 命名空间、`webServer.tapIndex`、`webserver/index-inject` 的注入行），MUST NOT 修改上游工作树。
- **FR-205-005**：本产品名 MUST 与 `AppScope` 的应用名一致；产品名与图标几何 MUST 各只有一个来源常量，改产品名/换图标 MUST 不超过两处改动（一处宿主、一处浏览器）。

### 3.2 首次引导（First-run Onboarding）

- **FR-205-006**：上游"预览版说明"首次弹窗 MUST NOT 自动出现；该行为 MUST 通过上游自己的配置项（`ui-settings-general.welcomeNoticeVersion`，与上游 `WELCOME_NOTICE_VERSION` 相等）实现。
- **FR-205-007**：DeepSeek 首次配置对话框 MUST NOT 自动弹出；用户从设置里**显式**进入时 MAY 仍可使用（能力不删）。
- **FR-205-008**：上游"官方品牌位"行（`ui-brand-official`）MUST 被禁用，避免构建环境切换（如 `DSH_CLIENT_BUILD_PROFILE=official`）时出现上游官方标识。
- **FR-205-009**：实现 MUST NOT 伪造 `dshDesktop` 全局或其它"我是官方桌面壳"的开关；MUST NOT 因本模块而启用任何上报/遥测。

### 3.3 漂移门禁与降级

- **FR-205-010**：上游欢迎提示版本、`brand.localBuild` 的中英文文案、被覆盖的 bundle 行 id 若发生变化，构建期门禁 MUST 失败并指明需要同步的位置。
- **FR-205-011**：宿主与浏览器两半边的品牌位锚点属性 MUST 保持同值，不一致时门禁 MUST 失败。
- **FR-205-012**：上游若改动 hero 结构导致隐藏规则不再匹配，界面 MUST 回退为"上游标语可见"，MUST NOT 出现空白、错位或其它元素被误隐藏。

---

## 4. 验收场景

- **AC-205-01**：宿主 Node 上启动载荷后打开 Web UI —— 页面标题为产品名；侧栏图标为产品图标（4 条路径的 `svg`）、名称为产品名；hero 为产品图标 + 产品名；`body.innerText` 不含上游标语与上游产品名；无 `role="dialog"` 弹窗。
- **AC-205-02**：去掉本模块的三条 bundle 行后重跑同一断言集 —— 标题变回上游文案、鱼形图标回归、上游标语与 Preview 徽标可见、"预览版说明"弹窗出现（负向对照，证明改动有效）。
- **AC-205-03**：`node scripts/verify-upstream.mjs` 通过，并额外输出欢迎提示版本对齐、品牌位锚点、上游标题文案覆盖三条 note。
- **AC-205-04**：`node scripts/smoke-payload.mjs` 通过，禁用行列表含 `ui-brand-official`，`@dsh-ohos` 行列表含 `branding-ohos`。
- **AC-205-05**：`zh-CN` 与 `en-US` 两种浏览器语言下，场景 AC-205-01 全部成立。

---

## 5. 非功能需求

- **NFR-205-01**：品牌位渲染 MUST NOT 引入新的网络请求或图片资源（图标内联为 SVG，避免 CSP/离线问题）。
- **NFR-205-02**：标题守卫 MUST 幂等（无变化不写入），MUST NOT 造成观察器自激或可感知的性能开销。
- **NFR-205-03**：实现 MUST 对 ArkWeb（Chromium 内核）可用；`CSS :has()` 依赖 MUST 在 `plan.md` 登记为本模块的浏览器能力前提。
- **NFR-205-04**：模块 MUST 随载荷分发（`packages/branding-ohos/` → `node_modules/@dsh-ohos/branding`），MUST NOT 要求额外的构建步骤。

---

## 6. 依赖与约束

| 依赖 | 用途 | 约束 |
|---|---|---|
| `sidebar.brand.mark` / `sidebar.brand.name` | 侧栏品牌位 | 上游槽位为 `single`：占用者取代兜底 |
| `conversation.hero.brand.mark` | hero 品牌位 | 同上；`className` 是鱼形图标的动画类，不转发 |
| `ctx.locale` | 自有文案命名空间 `brand.ohos` | 不得注册上游命名空间（会抛错） |
| `webServer.tapIndex` | 首屏 `<title>` | 只在 `index.html` 文本层生效，需浏览器半边守住后续写入 |
| `webserver/index-inject`（`style` 行） | 隐藏上游 hero 标语 | 规则以本产品锚点属性为准，未装品牌位时不生效 |
| `ui-settings-general` / `ui-settings-models` 行配置 | 关闭首次引导 | 属上游公开配置项，值随上游版本漂移 |

---

## 7. 未覆盖 / 后续

- **真机未验**：本模块的证据来自宿主 Node + Chromium 内核浏览器（同 ArkWeb 内核族）。设备上的图标渲染、`document.title` 是否被系统窗口标题采用、`zh/en` 语种跟随，需在真机 L1 阶段复核。
- **favicon / `manifest.webmanifest`**：仍是上游资源（ArkWeb 无标签页，用户不可见）；如需彻底清除上游标识，属 `108` 的产物替换工作。
- **`brand.localBuild` 之外的账号类文案**（如"登录 DeepSeek Harness 账号"）保留原样：那是**事实性归属**，不是本产品品牌位，删除反而造成误导。
