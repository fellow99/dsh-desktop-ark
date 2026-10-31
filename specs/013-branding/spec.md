# 品牌化 功能规格

> Module: 013-branding
> Status: Implemented（as-built）
> Last Updated: 2026-11-01

## 1. 模块概述

### 1.1 目的（Why this module exists）

本模块定义 `dsh-desktop-ark`（HarmonyOS Edition）的应用级产品身份：应用名、应用图标、启动图标、主窗口标题与启动/错误覆盖层标题。Web UI 内部的侧栏/hero 品牌位由 `205-plugin-branding` 负责，本模块不重复。

### 1.2 解决的问题

- HarmonyOS 桌面默认显示上游/工程名，需明确本产品身份。
- 应用图标为占位图，需要与父工程 `assets/` 的统一 logo 对齐。
- boot/loading 页与主窗口标题需要与 app 名一致，避免出现上游文案。

### 1.3 范围

**包含：**

- 应用名 `DSH Desktop Ark`（`AppScope` 的 `app_name`、`entry` 的 `EntryAbility_label`）。
- 应用图标 `app_icon.png`、启动图标 `startIcon.png`、模块图标 `icon.png`。
- boot/loading 页标题与主窗口标题（`Index.ets`、`boot.html`）。
- 物料来源：父工程 `assets/`（复制/生成）。

**不包含：**

- Web UI 内部品牌位（`brand.localBuild` / `hero` / 页面标题）——由 `205-plugin-branding` 以零补丁 seam 实现。
- 包名 `org.fellow99.dsh.DshDesktopArk`、版本号、签名与 ACL（属 `108-compliance-release`）。
- 应用商店 listing 文案与截图。

## 2. 用户故事

- 作为用户，我希望 HarmonyOS 桌面上应用名称是 “DSH Desktop Ark”，图标是本产品 logo。
- 作为用户，我打开应用时 loading 页与窗口标题显示本产品名，而不是上游 “DSH Local Build”。
- 作为维护者，我希望应用级品牌物料与 Web 品牌位（205）职责分离，换图标/改应用名不影响 Web UI。

## 3. 功能需求

### 3.1 应用身份

- FR-013-001：`AppScope/resources/base/element/string.json` 的 `app_name` MUST 为 `DSH Desktop Ark`。
- FR-013-002：`entry/src/main/resources/base/element/string.json` 的 `EntryAbility_label` MUST 为 `DSH Desktop Ark`。
- FR-013-003：`AppScope/app.json5` MUST 通过 `$media:app_icon` 与 `$string:app_name` 引用应用图标与名称。
- FR-013-004：应用包名、`versionName`、`versionCode` MUST 由 `108-compliance-release` 管理，本模块不修改。

### 3.2 图标

- FR-013-005：`AppScope/resources/base/media/app_icon.png` MUST 为产品 logo（应用级图标）。
- FR-013-006：`entry/src/main/resources/base/media/startIcon.png` MUST 为产品 logo（启动图标）。
- FR-013-007：`entry/src/main/resources/base/media/icon.png` MUST 为产品 logo（模块图标）。
- FR-013-008：品牌物料 MUST 以父工程 `assets/` 为唯一来源；分发/生成 MUST 不修改物料源。

### 3.3 标题与启动页

- FR-013-009：`entry/src/main/ets/pages/Index.ets` 的启动/错误覆盖层标题 MUST 为 `DSH Desktop Ark`。
- FR-013-010：`entry/src/main/resources/rawfile/boot.html` 的 `<title>` 与页面内标题 MUST 为 `DSH Desktop Ark`。
- FR-013-011：应用名、boot 页标题、窗口标题 MUST 保持一致（应用级身份），不得出现上游 “DSH Local Build”/“DSH 本地构建”。

### 3.4 与 Web 品牌位的边界

- FR-013-012：Web UI 内部品牌位（侧栏 logo/名称、hero、document title）MUST 由 `205-plugin-branding` 负责；本模块 MUST NOT 通过上游源码补丁修改 Web UI。
- FR-013-013：应用级品牌名 `DSH Desktop Ark` 与 Web 品牌名 `DSH Desktop` 的差异 MUST 在文档中显式登记，避免被误判为不一致缺陷。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|------|------|----------|
| 应用身份 | HarmonyOS 应用名 | `app_name`、`EntryAbility_label` |
| 应用图标 | 应用级 | `app_icon.png` |
| 启动/模块图标 | 启动页/模块 | `startIcon.png`、`icon.png` |
| 标题 | boot/窗口 | `boot.html`、`Index.ets` |
| 物料源 | 父工程 `assets/` | `logo.png` 等 |

## 5. 验收场景

### 场景：HarmonyOS 桌面

- Given 编译并安装 HAP
- When 查看系统桌面
- Then 应用名为 `DSH Desktop Ark`，图标为产品 logo

### 场景：启动覆盖层

- Given 应用冷启动
- When 观察 boot/loading 页
- Then 标题为 `DSH Desktop Ark`，无上游文案

### 场景：Web 品牌位边界

- Given 应用加载 dsh Web UI
- When 查看侧栏/hero
- Then 品牌位由 `205-plugin-branding` 接管（`DSH Desktop`），应用级名称仍为 `DSH Desktop Ark`

## 6. 非功能需求

- **一致性**：应用级名称在三处（AppScope、entry label、boot 标题）一致。
- **可维护性**：品牌物料/字符串集中，换品牌只改固定文件。
- **零上游补丁**：应用级品牌化不得修改 `deepseek-harness` 工作树。
- **证据**：真机桌面与 boot 页截图为准。

## 7. 假设与约束

- 应用级名称 `DSH Desktop Ark` 用于区分同一设备上的 Electron 版（`DSH Desktop`）。
- 约束：不修改包名与签名材料；不实现 Web 品牌位（属 205）。
- 约束：图标物料必须符合 HarmonyOS 应用图标规范。

## 8. 依赖

- 物料：父工程 `assets/`。
- 下游：`108-compliance-release`（包名/签名/版本）、`205-plugin-branding`（Web 品牌位）。
