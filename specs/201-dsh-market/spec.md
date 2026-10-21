# 201-dsh-market 插件市场 功能规格

> 模块：`201-dsh-market` · 工程 `dsh-desktop-ark` · 版本 0.2.1
> 状态：**implemented**（本迭代）
> 关联：设计 [`docs/pnpm+dsh-market.md`](../docs/pnpm+dsh-market.md) ｜ 契约实现 [`012-pnpm-integration`](../012-pnpm-integration/spec.md)

---

## 1. 模块概述

### 1.1 目的

把 `dsh-market`（npm 包 `dshmarket`，固定版本 **`1.66.42`**）内置进本工程的 dsh 环境：设置页出现「插件市场」，用户可浏览目录并**安装 / 卸载**插件。安装通道由 `012-pnpm-integration` 提供（进程内 pnpm），本模块负责市场产物的物化、profile 声明与运行期接线。

### 1.2 范围

**包含**：`dshmarket` 构建期物化（含运行时依赖闭包）、profile bundle 声明、启动期接线（`DSH_PNPM_ENGINE`、pnpm 配置生成）、市场行挂载顺序、文档与诊断。

**不包含**：市场自身 UI/目录/备份（由市场提供）；进程内 pnpm 引擎与契约实现（属 012）；修改市场或上游源码。

---

## 2. 用户故事

- 作为**设备用户**，打开设置就能看到「插件市场」，无需自装 Node/pnpm。
- 作为**设备用户**，点「安装」后插件真的装上并可用；点「卸载」后真的移除，重启不复活。
- 作为**打包者**，市场产物随构建自动物化；缺产物或版本不符时构建明确失败，而不是产出「入口消失」的包。

---

## 3. 功能需求

### 3.1 构建期物化

- **FR-201-001**：收集阶段 MUST 把 `dshmarket` 的 `package.json`、`cordis.patch.yml`、`lib/`、`client/` 物化到 `<stage>/node_modules/dshmarket/`（排除 `src/`、`tests/`、`scripts/`、`site/`、`locale/`、`assets/`、`tsconfig*`）。
- **FR-201-002**：市场工程（`../dsh-market`）缺失或未构建（缺 `lib/index.js` / `client/client.js`）时 MUST 硬失败，并给出 `npm i && npm run build` 的下一步命令。
- **FR-201-003**：系统 MUST 递归复制市场的运行时依赖闭包到 `dshmarket/node_modules`；**`@deepseek-ai/*` MUST NOT 复制**（从载荷宿主闭包解析）。
- **FR-201-004**：断言 MUST 覆盖：版本 === `DSH_MARKET_VERSION`；三个入口文件存在且非空；依赖闭包中每个名字可解析（`@deepseek-ai/*` 除外）；目录内不出现 `@deepseek-ai`。
- **FR-201-005**：物化 MUST 幂等。

### 3.2 profile 声明

- **FR-201-006**：`profiles/ohos/package.json` 的 `dsh.profile.bundles` MUST 追加 `dshmarket`，且 MUST 位于 `@dsh-ohos/bundle` **之后**。
- **FR-201-007**：profile MUST NOT 声明 `dependencies.dshmarket`（pnpm 每次 `add` 会重解析全部直接依赖，见设计 §3.2）。
- **FR-201-008**：市场行 MUST NOT 注入 `config.profile`（会把市场推进官方 Electron 分支并 spawn）。

### 3.3 运行期接线

- **FR-201-010**：`payload/host.js` 在 `runProfile()` 之前 MUST 设置 `process.env.DSH_PNPM_ENGINE = <runRoot>/node_modules/dsh-market-pnpm/bin/pnpm.cjs`。
- **FR-201-011**：`payload/host.js` MUST 在 `<profileDir>/pnpm-workspace.yaml` 缺失时生成该文件（内容见 012 FR-012-006），并建立 `.pnpm-store` / `.pnpm-cache` 目录。
- **FR-201-012**：`payload/bootstrap.js` MUST 设置 `DSH_OHOS_JITLESS_ENTRY`（兼容层入口绝对路径），供 worker 新 realm 安装。
- **FR-201-013**：上述接线 MUST 幂等，且失败时 MUST NOT 阻塞 Host 启动（记日志）。
- **FR-201-014**：市场 mount 后 MUST 通过 `ctx.get('desktopProfiles')` 命中 012 提供的契约；系统 MUST 记录一行「契约已提供 / 未提供」的日志。

### 3.4 能力与限制披露

- **FR-201-020**：文档 MUST 披露：`git:` 源插件、需 lifecycle 构建脚本的插件不可安装；市场的「放行构建脚本并重试」在本宿主无效。
- **FR-201-021**：文档 MUST 披露：profile 位于载荷内，换包（新 sha12 目录）后已安装插件不保留。

---

## 4. 关键实体

| 实体 | 描述 | 关键属性 |
|---|---|---|
| `dshmarket` 产物 | 内置市场包 | `lib/`（host half）、`client/client.js`（web half）、`cordis.patch.yml`（插入 `dsh-market` 行） |
| 运行时依赖闭包 | 市场自身依赖 | `js-yaml`、`undici` 及其传递依赖；不含 `@deepseek-ai/*` |
| profile 声明 | 加载市场的入口 | `dsh.profile.bundles` 含 `dshmarket`（无 `dependencies`） |
| 市场行 id | 市场自己声明的行 | `dsh-market`（`name: dshmarket`） |
| pnpm 配置 | profile 引擎配置 | 运行期生成，绝对 `storeDir` |

---

## 5. 验收场景

- **构建后市场就位**：Given `../dsh-market` 已构建；When 执行装配；Then `<stage>/node_modules/dshmarket/{package.json,cordis.patch.yml,lib/index.js,client/client.js}` 存在，`node_modules/js-yaml` 与 `node_modules/undici` 可解析，无 `@deepseek-ai`。
- **未构建即硬失败**：Given 缺 `lib/index.js`；When 装配；Then 退出码 1 + 下一步命令。
- **启动即接线**：Given 载荷解包完成；When Host 启动；Then `DSH_PNPM_ENGINE` 指向真实引擎；`<profileDir>/pnpm-workspace.yaml` 存在且含绝对 `storeDir`；日志出现「契约已提供」。
- **设置页出现市场**：Given 应用就绪；When 打开设置；Then 有「插件市场」入口并能拉取目录（或如实记录网络不可达）。
- **安装第一个插件**：When 点安装；Then `<profileDir>/node_modules/<pkg>/package.json` 出现，市场 UI 显示已安装，无 pnpm 子进程。
- **使用第一个插件**：When 按插件类型触发（工具或客户端面）；Then 功能可用（有证据）。
- **卸载第一个插件**：When 点卸载；Then 目录消失、`dsh.profile.bundles` 对应行移除、重启后不复活。

---

## 6. 非功能需求

- **幂等**：物化、配置生成、启动接线可重复执行。
- **健壮性**：构建期缺产物硬失败；运行期失败不阻塞启动。
- **体积**：市场 + 依赖 ≈ 2 MiB。
- **安全**：市场只在同源 loopback 暴露路由；安装通道 `ignoreScripts`；`allowRestart` 由市场在 desktop 分支固定为 false。

---

## 7. 假设与约束

- `dsh-market` 为同级源码（`../dsh-market`），版本以 `DSH_MARKET_VERSION` 固定并断言。
- 市场的 `desktopProfiles` 分支存在于 1.66.42（`src/index.ts:335-374`）。
- bundle 解析第一锚点是 `installAnchor`（`profile.ts:714-725`），因此产物放 `<runRoot>/node_modules` 即可被加载；client 扫描按 row 的模块位置定位 `package.json`。
- 设备网络可达 `registry.npmjs.org` 与 `awesome-dsh-plugin.com` 是市场可用的前提；不可达时如实记录。

---

## 8. 依赖

**上游**：`dsh-market` 1.66.42（只读）；`deepseek-harness` 的 bundle/profile/client 机制（只读）。

**工程内**：`012-pnpm-integration`（安装通道）、`102-payload-pipeline`（物化）、`105-upstream-adapter-bundle`（`@dsh-ohos/bundle` 插入行）。
