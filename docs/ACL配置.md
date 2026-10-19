# ACL 与权限配置（`org.fellow99.dsh.DshDesktopArk`）

> **落点**：`entry/src/main/module.json5`（单模块应用，声明面集中在 entry）。
> **口径**：判定规则与 `dsh-desktop-hos/docs/ACL申请清单-v2.md` §2 一致（同一台设备、同一套 SDK 权限目录）。
> **权威数据**：本机 SDK 的权限目录 `sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json`（第一手）。
> **零 ACL 方案评估**：见 [`ACL-无ACL评估.md`](ACL-无ACL评估.md)。**真机调试记录**：见 [`010-真机调试记录.md`](010-真机调试记录.md)。

## 1. 声明面（代码事实）

| 项 | 内容 |
|---|---|
| `requestPermissions` | **9 项**（HAP 内实测：8 项本工程声明 + `GET_NETWORK_INFO` 由 `@fellow99/node-bridge` HAR 随依赖合并进来） |
| 其中带 `reason` + `usedScene` | **5 项**（`EntryAbility` / `inuse`）：`PREPARE_APP_TERMINATE`、`INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY`（文案在 `base/element/string.json`） |
| `definePermissions` | `kernel.ALLOW_WRITABLE_CODE_MEMORY`（受限权限两处成对出现） |
| Ability 后台模式 | `EntryAbility.backgroundModes = ["taskKeeping"]` |

本工程自有的 8 项：

| # | 权限 | availableLevel | grantMode | provisionEnable | 需 ACL？ | 用途 |
|---|---|---|---|---|---|---|
| 1 | `INTERNET` | normal | system_grant | true | ❌ | ArkWeb 访问 loopback 服务；Node 访问模型 API |
| 2 | `PREPARE_APP_TERMINATE` | normal | system_grant | true | ❌ | `onPrepareToTerminate` 里先停内置 Node |
| 3 | `KEEP_BACKGROUND_RUNNING` | normal | system_grant | true | ❌ | `taskKeeping` 长时任务 |
| 4 | `INHERIT_PARENT_PERMISSION` | normal | system_grant | **false** | ❌ | 内置 Node 运行时与宿主同权限（名字带 `kernel.` 但属**开放权限**） |
| 5 | `kernel.IGNORE_LIBRARY_VALIDATION` | normal | system_grant | **false** | ❌ | 加载随包 `libnode.so` / `libnode_bridge.so` 时跳过库校验（同上，开放权限） |
| 6 | `READ_WRITE_DOCUMENTS_DIRECTORY` | normal | **user_grant** | true | ❌ | 工作区选择器「文档」Tab（运行期授权） |
| 7 | `READ_WRITE_DOWNLOAD_DIRECTORY` | normal | **user_grant** | true | ❌ | 工作区选择器「下载」Tab（运行期授权） |
| 8 | `kernel.ALLOW_WRITABLE_CODE_MEMORY` | **system_basic** | system_grant | true | ✅ **需 ACL** | 进程内 Node/V8 的 JIT（无它不带 `--jitless` 即 SIGTRAP） |

依赖合并进来的 1 项：`GET_NETWORK_INFO`（normal / system_grant，来自 `ohos-node-bridge/library/src/main/module.json5`，不随本工程声明面维护）。

## 2. 判定规则（先说规则，再逐项判）

> **受限开放权限（需 ACL）** ⟺ `provisionEnable == true` **且** `availableLevel ∈ {system_basic, system_core}`。
>
> `provisionEnable == false` 的一律是**开放权限**：写进 `requestPermissions` 即可，安装时授予（`user_grant` 的还需运行期弹窗）。
> `grantMode: system_grant` **不等于**「不用申请」——受限权限多数也是 `system_grant`（安装即授予，**前提是 Profile 里有它**）。

两个易错点（本工程都踩过名实不符的坑）：

1. `kernel.INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 名字带 `kernel.`，但 `availableLevel: normal` + `provisionEnable: false` ⇒ **开放权限，不需要 ACL**，提交 ACL 是浪费配额。
2. 「加一个更宽的开放权限替代受限权限」**不成立**：`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 无法替代 `kernel.ALLOW_WRITABLE_CODE_MEMORY`（`ohos-node-bridge/docs/000-工程规划.md` §D.8 探针实测：开放权限下 V8 走 JIT 仍 SIGTRAP）。

## 3. 现役 ACL：**1 项**

| # | 权限 | 用途 | 缺失后果（实测） |
|---|---|---|---|
| 1 | `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | 进程内 Node/V8 的 JIT | 不带 `--jitless` 时 V8 一申请可执行页即 **SIGTRAP**（应用级失败，只能重启应用） |

**2026-10-20 撤销四项**（本工程定稿）：

| 权限 | 等级 | 撤销依据 |
|---|---|---|
| `READ_PASTEBOARD` | system_basic + user_grant ⇒ 需 ACL | 页面粘贴由 **ArkWeb 自己**读剪贴板；`entry/src/main/ets` 全仓 **0 处** `@ohos.pasteboard` 调用（`grep pasteboard` 只命中两条 `not-implemented` 提示文案） |
| `READ_WRITE_DESKTOP_DIRECTORY` | system_basic + user_grant ⇒ 需 ACL | 工作区选择器**删除「桌面」Tab**（需求变更）：桌面不是工作区的真实用途，撤销后选择器只剩沙箱/文档/下载 |
| `FILE_ACCESS_PERSIST` | normal + system_grant（不需 ACL，但**无使用点**） | 选择器是**路径**模型（不返回 URI），全仓 0 处 `fileShare.persistPermission`；保留只会误导审计 |
| `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` | normal + system_grant（不需 ACL，但**无使用点/不能替代 JIT**） | 见 §2 第 2 点：它不能替代 `ALLOW_WRITABLE_CODE_MEMORY`；JIT 已由 ACL 满足，留着属于「声明面 ≠ 使用面」 |

**保留但降级为「运行时授权」的两项**：`READ_WRITE_{DOCUMENTS,DOWNLOAD}_DIRECTORY` —— 都是 `normal` + `user_grant`，**不需要 ACL**，
装即可声明，真正的授权动作由用户在对话框里点「请求权限」触发（见 §5）。

## 4. 装机与授权：实测记录

### 4.1 Profile 是授权面，声明面不等于授权面

DevEco 自动签名为 `org.fellow99.dsh.DshDesktopArk` 生成的调试 Profile（`~/.ohos/config/default_dsh-desktop-ark_*.p7b`）
**逐项列出了本工程当时声明的受限/用户授权权限**（6 项）：

```
ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY   ← JIT（现役唯一 ACL）
ohos.permission.READ_PASTEBOARD                     ← 2026-10-20 撤销
ohos.permission.READ_WRITE_DESKTOP_DIRECTORY        ← 2026-10-20 撤销
ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY      ← 保留（运行期授权）
ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY       ← 保留（运行期授权）
ohos.permission.FILE_ACCESS_PERSIST                 ← 2026-10-20 撤销（无使用点）
```

> 姊妹工程 `pi-desktop-ark` 的反向实证（`docs/ACL配置.md` §2.1，2026-10-16 / HAD-W24）：Profile **不含** ACL 时
> 装机直接被拒 —— `code:9568289 install failed due to grant request permissions failed, PermissionName: ohos.permission.READ_PASTEBOARD`。
> 本工程本轮未复现该失败（Profile 一开始就带齐），但结论一致：**留着受限声明而 Profile 里没有它，就装不上**。

### 4.2 本工程真机实测（2026-10-19，HAD-W32 / HarmonyOS 7.0.0.107 / API 26）

| 判据 | 结果 |
|---|---|
| `hdc install -r entry-default-signed.hap` | ✅ `install bundle successfully.`（Profile 含上述 6 项） |
| 启动（**不带** `--jitless`） | ✅ 无 `Cpp Crash`；进程内 Node 正常起服务 |
| JIT 生效 | ✅ `ready.json` `phase=ready`；`node.log` 有 `argv[1]=--no-verify-heap`、`argv[2]=--expose-internals`，进程稳定 |
| `node:sqlite` + FTS5 | ✅ `app.log`：`available=true fts5=true` |
| HAP 内声明面 | ✅ 9 项（含 HAR 合并的 `GET_NETWORK_INFO`）；`definePermissions` 1 项 |

### 4.3 复验步骤（Profile 变更后必做）

1. DevEco → `File → Project Structure → Signing Configs` 重新生成签名材料（或沿用现有材料；Profile 变更才需要重生成）；
2. 把材料写进 gitignored 的 `signing.debug.local.json`（字段见该文件名旁的 `hvigorfile.ts` 注释），**不要**把绝对路径/口令提交进 `build-profile.json5`；
3. `bash scripts/build-hap.sh` → `hdc install -r entry/build/default/outputs/default/entry-default-signed.hap`；
   **能装上**即说明 Profile 授权面覆盖了声明面（撤销的 4 项若仍留在 Profile 里，属于多余授权，不影响装机）；
4. `hdc shell aa start -a EntryAbility -b org.fellow99.dsh.DshDesktopArk`；
5. `hdc shell cat .../files/payload/ready.json` 看 `phase`，`hdc shell cat .../files/payload/app.log` 看垫片与权限日志；
6. 若出现 SIGTRAP（`Cpp Crash` + 崩溃栈含 `libnode_bridge.so`）⇒ JIT ACL 丢了：核对 Profile 里是否仍有 `ALLOW_WRITABLE_CODE_MEMORY`。

## 5. 运行期授权交互（工作区选择器）

撤销 ACL 之后，「文档 / 下载」只剩 `user_grant`，因此必须决定**什么时候弹窗**。本工程的约定：

- **点 Tab 不申请权限**：只查状态（`perm.check`）。未授权时对话框**不显示列表**，改为两个按钮；
- **「请求权限」**：用户点击后才 `perm.request`（弹系统授权窗）；
- **「刷新」**：重新查一次状态；已授权则渲染列表，仍未授权则保持按钮态；
- Host 侧任何路径（`list` / `createDirectory`）都**不会**隐式申请权限；失败时把 `permissionRequired` 透传给客户端，由客户端决定渲染。

实现落点：
- Host：`packages/workspace-picker-ohos/lib/index.js`（`permission()` / `requestPermission()`，以及 `list()` 不再 `retryPermission`）、`lib/routes.js`（`/_ohos/picker/{roots,list,create,permission,permission/request}`）；
- Client：`packages/workspace-picker-client-ohos/lib/client.js`（三 Tab + 授权门）。

## 6. 与运行时投放的关系

ACL 只决定**内存权限**，不影响原生库与载荷：`libnode.so`（120.9 MiB）由 `scripts/provision-runtime.sh`
（委托 `ohos-node-bridge/tools/provision.mjs`，七项 ELF 门禁 + SHA-256 对账）投放进 `entry/libs/arm64-v8a/`；
`libnode_bridge.so` 随 `@fellow99/node-bridge` HAR 打包；载荷 `dsh.tar.gz` 由 `scripts/assemble-payload.mjs` 生成、
`resfile` 随包分发，运行时由 `payload/bootstrap.js` 自解包（垫片 S1–S6）。
