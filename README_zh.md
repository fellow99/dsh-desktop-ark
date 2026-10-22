[English](./README.md) | 中文

# DSH Desktop · 鸿蒙版

> **官方 DeepSeek Harness（dsh）Web UI，原样未改**，运行在鸿蒙 2in1 / 平板上的**系统 ArkWeb** 里 —— 而 dsh Host 跑在**同一进程内嵌的真实 Node.js 运行时**上。没有 Electron、不自带浏览器内核、不重写 ArkUI。

<p align="center">
  <img src="https://img.shields.io/badge/release-0.2.1-4D6BFE" alt="版本">
  <img src="https://img.shields.io/badge/dsh-dsh--v0.2.1--rc.2-7C5CFF" alt="dsh 版本">
  <img src="https://img.shields.io/badge/HarmonyOS-API%2024-0A59F7" alt="HarmonyOS API 24">
  <img src="https://img.shields.io/badge/Node-v24.2.0-5FA04E" alt="Node 24.2.0">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F" alt="MIT">
</p>

## 你能得到什么

- **还是那个 dsh** —— 会话、工具、插件、设置、主题全都在，前端是上游原样；智能体宿主跑在本机，没有中转、没有 CORS、没有账号门槛。
- **不需要自带渲染器** —— 界面由系统 WebView 绘制，所以包里只有智能体运行时（载荷约 42 MB），不背浏览器内核。HAP 约 88 MB。
- **安装不需要受限权限** —— 默认构建是无 JIT 的 `compat` 形态，侧载不需要任何 ACL 绑定权限；另有 `jit` 形态供已获可写代码内存权限的设备使用。
- **上游零改动** —— 鸿蒙差异集中在一个 `ohos` profile、一层 bundle、若干 seam 插件和 6 个带标记的垫片里。升级 dsh 是重跑管线，不是重做补丁。
- **以本产品身份呈现** —— 自己的图标、名称与窗口标题；上游的"预览版说明"和 DeepSeek 首次配置不再自动弹出（两者在设置里仍可手动打开）。

## 鸿蒙上的两个版本

鸿蒙有**两个独立版本**，壳架构、未改动的 Web UI、数据面完全相同，差别只在**由谁提供 Node**：

| | **鸿蒙版**（本仓库） | **Electron on HarmonyOS 版**（[`dsh-desktop-hos`](../dsh-desktop-hos)） |
|---|---|---|
| 渲染 | 系统 **ArkWeb** —— 不随包带内核 | Electron 37 内置 Chromium |
| Node.js | 应用进程内 `libnode.so`（v24.2.0） | Electron 运行时内置（Node 22.17） |
| 运行时管线 | [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge) + [`@fellow99/node-runtime`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime)（ohpm 中心仓包） | [`harmonypc-electron`](../harmonypc-electron) |
| 上游 dsh 补丁 | **0** —— profile + bundle 层 + 已审计垫片 | 13 个源码补丁 |
| 安装要求 | 无（默认无 JIT） | 需 JIT 受限权限（ACL） |
| 包体 | 约 88 MB | Electron 体量（数百 MB） |
| 成熟度 | 0.2.1 —— 已在 HarmonyOS 6.1.0.135（API 24）真机验证 | 0.2.1 —— 已真机验证（0.2.0 基线） |

两者不互相替代：Electron 版用自带 Chromium 与 JIT 换来最接近桌面的保真度；本版用较小的包体与免权限安装换来"平台差异由垫片层兜住"。

## 能力一览

| 方面 | 状态 |
|---|---|
| dsh Web UI、会话、工具、技能、子 agent | ✅ 与上游一致 |
| 文件读 / 写 / 编辑、图片附件 | ✅ |
| 工作区选择（文档 / 下载：授权后可读写） | ✅ |
| Git（21 个工具，纯 JS，设备无需 `git` 二进制） | ✅ |
| profile 内的本地插件、本产品品牌位 | ✅ |
| 命令执行（`bash`） | ⚠️ 执行器已交付，路径解析修复待落地 |
| 内容搜索（`grep` / `glob`） | ⚠️ 需要纯 JS 后端（arm64 上没有 `ripgrep` 二进制） |
| 删除 / 移动 / 复制 / chmod | ⚠️ 上游 `ctx.fs` 尚无这些原语 |
| 插件市场、托盘图标、窗口状态记忆 | — 本版不提供 |

完整矩阵（每项能力、两个版本并列、含根因）见 [`docs/鸿蒙环境能力清单-0.2.1.md`](docs/鸿蒙环境能力清单-0.2.1.md)。

## 状态

`0.2.1`（`versionCode` 201）—— **可在真机运行**。已在 HarmonyOS 6.1.0.135（API 24，2in1）验证：零 ACL 装机、载荷自解包并 `ready`、垫片全部安装、`node:sqlite`/FTS5 可用、文本与图片对话、三根目录工作区选择、git 克隆（公开与内网）、品牌位（经 WebView 调试器核对）。已知缺口与修复点见上面的能力清单。

## 构建

前置：DevEco **Command Line Tools**（SDK API 24）与同级子模块 `../deepseek-harness`。Node 运行时来自 OpenHarmony 三方库中心仓：[`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge)（API + NAPI 引导件）与 [`@fellow99/node-runtime@24.2.0`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime)（`libnode.so` 引擎，SHA-256 由随包 `runtime.lock.json` 锁定），`ohpm install` 自动拉取。

```bash
node scripts/assemble-payload.mjs --deploy --apply   # ① 物化 dsh 运行树
bash scripts/build-hap.sh           # ② ohpm install → 载荷归档 + HAP 构建/签名
hdc app install -r entry/build/default/outputs/default/entry-default-signed.hap
```

`OHOS_CLT` 可覆盖 Command Line Tools 根目录；`node scripts/verify-upstream.mjs` 校验上游锁定未被破坏（tag、工作树干净、patch id、品牌与引导门禁）。

## 文档

| 文档 | 回答什么 |
|---|---|
| [能力清单 0.2.1](docs/鸿蒙环境能力清单-0.2.1.md) | 能做什么、不能做什么，与 Electron 版如何对标 |
| [工程规划](docs/000-工程规划.md) | 为什么是这个架构、否决了什么、垫片白名单 |
| [真机调试记录](docs/010-真机调试记录.md) | 真机上踩了什么坑、怎么定位的 |
| [JIT 与 ACL](docs/ACL配置.md) · [无 JIT 决策](docs/109-jitless-方案决策.md) | 两种运行时形态各自的代价 |
| [规格文档](specs/README.md) | 11 个规格模块（101–109、204、205）与门禁 |

## 相关工程

- [`dsh-desktop`](../dsh-desktop) —— Windows / Linux / macOS 的 Electron 桌面壳
- [`dsh-desktop-hos`](../dsh-desktop-hos) —— Electron on HarmonyOS 版
- [`@fellow99/node-bridge`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-bridge) / [`@fellow99/node-runtime`](https://ohpm.openharmony.cn/#/cn/detail/@fellow99%2Fnode-runtime) —— 以 ohpm 包形态在应用进程内嵌 Node（`node::Start`）
- [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) —— 被封装的上游智能体宿主

## 许可证

[MIT](./LICENSE)
