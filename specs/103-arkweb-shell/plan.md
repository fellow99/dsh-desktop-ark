# 103 ArkWeb 外壳 —— 技术方案（plan）

> 模块：`103-arkweb-shell`｜状态：**部分 implemented（4 项 planned，1 项 not-implemented）**｜最后更新：2026-10-18
> 对应 spec：`specs/103-arkweb-shell/spec.md`

## 1. 技术上下文

| 项 | 值 |
|---|---|
| UI 栈 | ArkTS Stage 模型、ArkUI 声明式组件（`@Entry`/`@Component`/`@State`） |
| 渲染容器 | ArkWeb（系统 Chromium），`@kit.ArkWeb` 的 `Web` + `WebviewController` |
| SDK | `compatibleSdkVersion 5.0.5(17)`、`targetSdkVersion 6.1.1(24)` |
| 起始页 | 随包 `rawfile/boot.html`（31 行静态 HTML，无脚本） |
| 目标地址 | `http://127.0.0.1:<port>/?token=…`（端口随机，凭据一次性） |
| 窗口 | `windowStage.loadContent('pages/Index')`，无自定义标题栏/全屏控制 |
| 模块清单 | `entry/src/main/module.json5`（96 行）：2in1/tablet、singleton、taskKeeping（FR-103-002） |
| 签名 / 打包 | `compressNativeLibs: true` + `extractNativeLibs: true`（module 级） |

## 2. 宪法合规检查（C1–C14）

| 原则 | 状态 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 不修改上游前端、不注入 preload、不做原生聊天界面 |
| C2 平台真相不隐藏 | ⚠️ | 启动失败可见；但「导航围栏」「加载错误覆盖层」在整体文档中写作已实现，实际缺失 |
| C3 证据优先 | ⚠️ | 验收证据形态已定义（截图 + 页面断言），无真机记录（L1–L4 pending） |
| C4 单进程/单实例/随机端口 | ✅ | `launchType: singleton`；单 Web 容器；端口来自服务侧 |
| C5 谁写谁读 | ✅ | 启动页走只读 `rawfile`；外壳不写任何 Node 读取的树 |
| C6 绝对路径 | ⚠️ | 本模块无运行期文件路径；`loadContent('pages/Index')` 是逻辑路由；C6 检查命令会命中 ES import 字面量 |
| C7 垫片可审计 | ✅ | 外壳不安装垫片、不篡改页面脚本 |
| C8 异常兜底 | ⚠️ | `loadUrl` 异常被捕获并显示；无页面级错误回调与全局兜底 |
| C9 鉴权只在 Host | ✅ | 不解析 token、不写 cookie、不改 Host/Origin；只透传入口地址 |
| C10 权限最小化 | ❌ | `module.json5` 声明 14 项权限，其中 8 项无代码路径（见 §3.10），直接命中「声明了代码从未使用的权限」 |
| C11 秘密不入库/不进日志 | ⚠️ | 凭据只在内存 `pendingUrl`；但 `loadUrl` 失败消息可能把含 token 的 URL 拼进可复制的 `detail` |
| C12 编号即契约 | ✅ | `103-arkweb-shell/` 对应 `pages/` + `entryability/` + `module.json5` |
| C13 可复现 | ✅ | 无二进制、无生成物 |
| C14 文档描述现状 | ⚠️ | 本文件纠正「导航围栏已实现」「`rawfile/{boot.html,error.html}`」等既有表述 |

## 3. 研究结论

1. **容器配置（as-built）**：`javaScriptAccess(true)`、`domStorageAccess(true)`、`databaseAccess(true)`、`fileAccess(false)`；未设置 `mixedMode`、`userAgent`、缩放/字体策略。
2. **加载时序**：`onControllerAttached` 置 `attached=true` 并尝试 `loadPending()`；快照到达 `url` 非空时置 `pendingUrl` 并关闭覆盖层。两个条件都满足才 `loadUrl`，避免控制器未挂载时调用。
3. **导航围栏不存在**：`Index.ets` 没有 `onLoadIntercept`、`onWindowNew`、`onShowFileSelector`、`onDownloadStart`、`onErrorReceive`、`onHttpErrorReceive`。FR-103-008/009/010/011 全部为 **planned**；`overall-plan.md` §3 的「导航围栏」表述与代码不符。
4. **历史清理过度**：`onPageEnd` 无条件 `clearHistory()`，不只清启动页，也会清掉前端自身的导航历史；需求只要求清启动页（FR-103-007），实现范围更大。
5. **失败态可能无操作入口**：`loadUrl` 抛错时置 `detail` 并显示覆盖层，但阶段仍为 `RUNNING`，而「重启应用」按钮只在 `FAILED` 时渲染 → 用户看到错误但没有按钮。
6. **按钮语义**：「重启应用」实际执行 `terminateSelf()`，不自动拉起新实例；与「一键重启」的直觉不一致（进程内运行时无法重启，退出是唯一诚实做法，但标签应更准确）。
7. **启动页无深浅色**：`boot.html` 固定白底（`#ffffff`）、无 `prefers-color-scheme`；深色模式下首帧刺眼。FR-103-014 planned。
8. **资源缺口**：`entry/src/main/resources/rawfile/` 只有 `boot.html`，没有规划 §6.1 列出的 `error.html`；错误视图完全由 ArkUI 覆盖层承担。
9. **模块清单事实**：`deviceTypes: ["2in1","tablet"]`；`launchType: "singleton"`；`backgroundModes: ["taskKeeping"]`；`requestPermissions` 14 项；`definePermissions` 为 `LOCK_WINDOW_CURSOR` + `kernel.ALLOW_WRITABLE_CODE_MEMORY`。
10. **未使用权限（C10 违反项）**：`ohos.permission.GET_NETWORK_INFO`、`RUNNING_LOCK`、`READ_PASTEBOARD`、`FILE_ACCESS_PERSIST`、`READ_WRITE_{DESKTOP,DOCUMENTS,DOWNLOAD}_DIRECTORY`、`LOCK_WINDOW_CURSOR` 共 8 项在 `entry/src/main/ets` 中零引用（目录权限属模块 106 planned；其余无对应实现）。
11. **生命周期最小**：`EntryAbility` 只实现 `onCreate`/`onWindowStageCreate`/`onPrepareToTerminate`/`onDestroy`；无窗口尺寸约束、无标题栏、无全屏快捷键、无 `onBackPressed`、无 cookie 清理入口。
12. **无诊断入口**：规划 §6.6/§6.7 的「长按标题进入诊断」「标题追加 HOST-OK/FAIL · port」均未实现。

## 4. 数据模型（真实字段）

| 实体 | 字段 |
|---|---|
| 页面状态 | `phase:string`、`statusText:string`、`detail:string`、`showOverlay:boolean`、`attached:boolean`、`pendingUrl:string` |
| Web 配置 | `javaScriptAccess=true`、`domStorageAccess=true`、`databaseAccess=true`、`fileAccess=false` |
| 模块清单 | `name:'entry'`、`type:'entry'`、`mainElement:'EntryAbility'`、`deviceTypes:['2in1','tablet']`、`launchType:'singleton'`、`backgroundModes:['taskKeeping']`、`compressNativeLibs:true`、`extractNativeLibs:true` |
| 权限 | `requestPermissions` 14 项 + `definePermissions` 2 项（`LOCK_WINDOW_CURSOR`、`kernel.ALLOW_WRITABLE_CODE_MEMORY`） |
| 页面路由 | `resources/base/profile/main_pages.json` = `["pages/Index"]` |

**状态迁移（视图）**：`showOverlay=true`（初值）→ 收到非空 `url` → `=false` → `loadUrl` 失败 → `=true` 且 `detail` 非空；`FAILED` 时额外渲染退出按钮。

## 5. 接口契约

### 5.1 Provided

| 契约 | 形式 | 说明 |
|---|---|---|
| 页面入口 | `pages/Index`（`@Entry`） | 窗口唯一内容 |
| 启动页资源 | `rawfile/boot.html` | 静态、无脚本、无网络 |
| 模块清单 | `module.json5` | 设备形态、单实例、权限、原生库打包策略 |
| 窗口装配 | `windowStage.loadContent('pages/Index')` | 无自定义 chrome |

### 5.2 Consumed

| 来源 | 契约 |
|---|---|
| 模块 101 | `DshRuntime.get()`、`launch(context, listener)`、`snapshot()`、`shutdown(reason)`、`LaunchPhase`、`LaunchSnapshot` |
| ArkWeb | `WebviewController.loadUrl(url)`、`clearHistory()`；`Web({src:$rawfile(...),controller})` 及属性链 |
| ArkUI / Ability | `getContext(this)`、`context.terminateSelf()`、`windowStage.loadContent` |
| 平台 | `BusinessError`（`loadContent`/`terminateSelf` 的 catch） |

### 5.3 事件协议

- **消费事件**：启动快照回调（模块 101，同步）；`onControllerAttached`（容器挂载）；`onPageEnd`（页面加载结束）。
- **缺失事件（planned）**：`onLoadIntercept`（导航围栏）、`onWindowNew`、`onShowFileSelector`、`onDownloadStart`、`onErrorReceive`/`onHttpErrorReceive`（错误覆盖层）、`onBackPressed`（历史/退出策略）。
- **跨进程**：无；页面与 Host 的通信全部发生在 Web 容器内部（同源 HTTP/WS）。

## 6. 实现策略

**架构模式**：单页 + `Stack` 叠加覆盖层；Web 容器始终存在，覆盖层只控制可见性，避免重建容器导致白屏（FR-103-001、FR-103-016）。

**关键算法**

1. `aboutToAppear` 取 UIAbility 上下文并订阅启动快照（FR-103-004、FR-103-006）。
2. 快照回调：写 `phase`/`statusText`/`detail`；`url` 非空 → `pendingUrl=url`、`showOverlay=false`、尝试加载；`FAILED` → 覆盖层可见。
3. `loadPending()`：`attached && pendingUrl !== ''` 才 `loadUrl`；异常写入 `detail` 并重新显示覆盖层。
4. `onPageEnd`：`clearHistory()` 包 `try/catch`（页面尚无历史时忽略）。
5. 退出：`shutdown('user-exit')` → `terminateSelf()`。

**错误处理**：`loadContent` 失败只记 hilog；`loadUrl` 失败展示文本；`terminateSelf` 失败把消息写入 `detail`；无页面级错误回调（FR-103-010、FR-103-012，均为 planned）。

**性能**：启动页为本地 rawfile，无需网络；容器单实例；覆盖层为轻量 ArkUI 组件；无 `loadData`/`data:` 页面（FR-103-013）。

**安全**：`fileAccess(false)`；无 JS 注入、无 `javaScriptProxy`；凭据不经壳处理（FR-103-012）。

## 7. 测试考虑

| 用例 | 覆盖 FR | 层 | 现状 |
|---|---|---|---|
| TC-103-001 | FR-103-003/004/006 | L2 | pending（需 G1 + 真机） |
| TC-103-002 | FR-103-005 | L2 | pending（页面 JS 断言需设备） |
| TC-103-003 | FR-103-007 | L2 | pending；实现会清全部历史，需确认是否影响前端回退 |
| TC-103-004 | FR-103-008 | L2 | **blocked**：无 `onLoadIntercept` |
| TC-103-005 | FR-103-009 | L2 | **blocked**：无 `onWindowNew`/外链接线 |
| TC-103-006 | FR-103-011 | L2 | **blocked**：无 `onErrorReceive`/`onHttpErrorReceive` |
| TC-103-007 | FR-103-015 | L0 | 可离线 grep；当前 8 项权限零引用 |

- 仓库无 UI 测试工程（无 `entry/src/ohosTest`）；L0 仅由 `hvigorw assembleHap` 覆盖编译与清单校验。
- 「重启应用」路径只能在真机验证：`terminateSelf` 后需手动重开，自动化脚本应以 `aa start` 模拟第二次启动。
- 覆盖层与 `loadUrl` 的竞态（控制器挂载 vs 快照到达）建议用两个方向的时序各测一次；当前无脚本。

## 8. 文件清单

| 路径 | 行数 | 职责 |
|---|---|---|
| `entry/src/main/ets/pages/Index.ets` | 129 | 单页外壳、Web 配置、启动/失败覆盖层、加载与退出 |
| `entry/src/main/resources/rawfile/boot.html` | 31 | 静态启动页（品牌 + 动画 + 提示） |
| `entry/src/main/ets/entryability/EntryAbility.ets` | 39 | UIAbility 生命周期、加载页面、退出放行 |
| `entry/src/main/module.json5` | 96 | 设备形态、单实例、后台模式、权限与原生库打包 |
