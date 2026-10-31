# 013-branding 技术方案（As-Built）

> 本文档记录 `dsh-desktop-ark` 应用级品牌化的实际实现。
> Module: 013-branding
> 对应规格: [spec.md](./spec.md)
> Last Updated: 2026-11-01

## 1. 技术上下文

### 1.1 运行环境

- HarmonyOS 6.1.0.135（API 24）2in1 / tablet。
- ArkTS / ArkUI Stage 模型 + ArkWeb。
- 进程内 `libnode.so`（Node v24.2.0，ohpm `@fellow99/node-runtime`）。
- 上游 dsh `dsh-v0.2.1-rc.2`（profile/bundle/seam 插件，零源码补丁）。

### 1.2 依赖与物料

| 项 | 来源 | 用途 |
|----|------|------|
| `assets/logo.png` | 父工程 `assets/` | 应用/启动/模块图标 |
| `AppScope/app.json5` | 本工程 | 应用身份与图标引用 |
| `AppScope/resources/base/element/string.json` | 本工程 | `app_name` |
| `entry/src/main/resources/base/element/string.json` | 本工程 | `EntryAbility_label` |

## 2. 宪法合规

| 原则 | 状态 | 说明 |
|------|------|------|
| C1 上游零补丁 | ✅ | 应用级品牌化不触碰上游 |
| C2 平台真相不隐藏 | ✅ | 应用名与 Web 品牌名差异显式登记 |
| C12 编号即契约 | ✅ | 013 与 205 分工写入 README/宪法 |
| C13 可复现 | ✅ | 图标为静态物料，随仓库/资产管线复制 |
| C14 文档描述是什么 | ✅ | 名称/路径均来自实际文件 |

## 3. 研究结论

- 应用级名称使用 `DSH Desktop Ark`，与 Electron 版（`DSH Desktop`）区分；Web UI 品牌位由 205 统一为 `DSH Desktop`。
- HarmonyOS 应用图标由 `AppScope/app.json5` 的 `icon`/`label` 引用；entry 模块另有 `startIcon` 与 `icon`。
- boot/loading 页由 `entry/src/main/resources/rawfile/boot.html` 与 `Index.ets` 渲染，标题需与应用名一致。
- 应用级品牌化与 Web UI 品牌位分离，避免把 205 的 seam 逻辑混入 AppScope 资源。

## 4. 数据模型

无数据实体；仅静态资源与字符串。

| 类型 | 说明 |
|------|------|
| 文件复制 | 父工程 logo → `AppScope/.../media/app_icon.png`、`entry/.../media/{startIcon,icon}.png` |
| 字符串 | `app_name`、`EntryAbility_label`、boot 页标题 |
| 引用 | `app.json5` 的 `icon`/`label` |

## 5. 接口契约

| 文件 | 内容 |
|------|------|
| `AppScope/app.json5` | `icon: "$media:app_icon"`、`label: "$string:app_name"` |
| `AppScope/resources/base/element/string.json` | `app_name = DSH Desktop Ark` |
| `AppScope/resources/base/media/app_icon.png` | 产品 logo |
| `entry/src/main/resources/base/element/string.json` | `EntryAbility_label = DSH Desktop Ark` |
| `entry/src/main/resources/base/media/startIcon.png` | 产品 logo |
| `entry/src/main/resources/base/media/icon.png` | 产品 logo |
| `entry/src/main/ets/pages/Index.ets` | 启动/错误覆盖层标题 `DSH Desktop Ark` |
| `entry/src/main/resources/rawfile/boot.html` | `<title>DSH Desktop Ark</title>` 与页面标题 |

## 6. 实现策略

### 6.1 架构模式

“应用级资源覆盖 + Web 品牌位分离”：AppScope/entry 资源负责系统可见身份；205 seam 插件负责 Web UI 内部品牌位。

### 6.2 关键实现

- 应用名：`app_name` 与 `EntryAbility_label` 同名。
- 图标：覆盖 `app_icon.png`、`startIcon.png`、`icon.png`，保持 `$media:` 引用不变。
- 标题：`Index.ets` 与 `boot.html` 的标题字符串统一。
- 与 205 的边界：013 不修改上游 locale/组件；205 使用槽位、自有 locale 命名空间与 index 注入。

### 6.3 错误处理

- 图标缺失：构建期资源缺失会直接失败（HarmonyOS 资源引用解析失败）。
- 名称不一致：验收脚本/人工检查三处字符串一致。

### 6.4 性能

静态资源，无运行时开销。

## 7. 测试考虑

- 真机桌面应用名/图标截图。
- 冷启动 boot 页标题检查。
- `grep` 三处名称一致。
- 确认 Web UI 品牌位仍由 205 接管（不因 013 回退）。

## 8. 文件清单

| 文件 | 用途 |
|------|------|
| `AppScope/app.json5` | 应用身份/图标引用 |
| `AppScope/resources/base/element/string.json` | `app_name` |
| `AppScope/resources/base/media/app_icon.png` | 应用图标 |
| `entry/src/main/resources/base/element/string.json` | `EntryAbility_label` |
| `entry/src/main/resources/base/media/startIcon.png` / `icon.png` | 启动/模块图标 |
| `entry/src/main/ets/pages/Index.ets` | 启动覆盖层标题 |
| `entry/src/main/resources/rawfile/boot.html` | boot 页标题 |
| `packages/branding-ohos/` | Web 品牌位（205，不在本模块实现） |
