# ACL 与权限配置（`org.fellow99.dsh.DshDesktopArk`）

> **落点**：`entry/src/main/module.json5`（单模块应用，声明面集中在 entry）。
> **口径**：判定规则与 `dsh-desktop-hos/docs/ACL申请清单-v2.md` §2 一致（同一台设备、同一套 SDK 权限目录）。
> **权威数据**：本机 SDK 的权限目录 `sdk/default/openharmony/toolchains/lib/PermissionDefinitions.json`（第一手）；
> 设备侧副本 `/system/etc/access_token/permission_definitions.json`（实测读取，见 §5.2）。
> **零 ACL 方案评估**：见 [`ACL-无ACL评估.md`](ACL-无ACL评估.md)。**真机调试记录**：见 [`010-真机调试记录.md`](010-真机调试记录.md)。
> **2026-10-20 二次修订（需求 109-jitless）**：默认运行形态改为 **compat（`--jitless`，零 ACL 声明）**；
> JIT ACL 只属于 `jit` 变体（`node scripts/set-node-mode.mjs jit`）。详见 §10 与
> [`../specs/109-jitless/spec.md`](../specs/109-jitless/spec.md)。
>
> **2026-10-20 修订**：按姊妹工程 `pi-desktop-ark` 最新三份文档（`001-能力复刻评估.md` REV-8/9/10/11、
> `ACL配置.md` §5、`ACL-无ACL评估.md` §10）重新评估，并补上本工程自己的两条新实测：
> **① 运行期授权为何会「没有任何应答」**（§5）；**② `checkAccessTokenSync` 的已知假阴性**（§6）。

## 1. 声明面（代码事实）

> **2026-10-21 R4（声明面全量对齐，用户决定）**：`requestPermissions` 与参考工程 `pi-desktop-ark`
> **逐项对齐**（20 项；唯一例外是 JIT ACL —— 它只属于 `jit` 变体，见 §10，否则零 ACL Profile 装不上）。
> 20 项**全部是 `availableLevel: normal`**（3 项 `user_grant`，其余 `system_grant`）⇒ **不需要 ACL**；
> 零 ACL Profile 下装机、启动、授权面均已实测（§4.1、§10）。
> 对齐动机：本工程是同一套桌面壳的能力复刻，声明面缺项会让「截屏 / 设备方向 / 文件和文件夹」这类
> 参考工程已具备的能力在本工程里**连申请入口都没有**（未声明的权限运行期申请必被拒，见 §5）。

| 项 | 内容 |
|---|---|
| `requestPermissions` | **compat 20 项 / jit 21 项**（本工程 `module.json5` 显式列全 20 项；`GET_NETWORK_INFO` 与 HAR 同名合并、HAP 产物中无重复；JIT 权限仅 `jit` 变体声明） |
| 其中带 `reason` + `usedScene` | **7 项**（`EntryAbility` / `inuse`）：`PREPARE_APP_TERMINATE`、`INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`、`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY`、`CUSTOM_SCREEN_CAPTURE`（文案在 `base/element/string.json`） |
| `definePermissions` | **compat：`LOCK_WINDOW_CURSOR` 1 项 / jit：再 + `kernel.ALLOW_WRITABLE_CODE_MEMORY`**（`LOCK_WINDOW_CURSOR` 实为 normal 级、**不需要 ACL**，与参考工程同样写在 define 面；`atm dump` 里 `grantStatus=0` 可证） |
| Ability 后台模式 | `EntryAbility.backgroundModes = ["taskKeeping"]` |

20 项逐项判定（属性取自本机 SDK `toolchains/lib/PermissionDefinitions.json`，第一手）：

| # | 权限 | availableLevel | grantMode | provisionEnable | 需 ACL？ | 用途 |
|---|---|---|---|---|---|---|
| 1 | `INTERNET` | normal | system_grant | true | ❌ | ArkWeb 访问 loopback 服务；Node 访问模型 API |
| 2 | `GET_NETWORK_INFO` | normal | system_grant | true | ❌ | 网络状态；与 `@fellow99/node-bridge` HAR 同名合并（显式声明后仍只有 1 条） |
| 3 | `ACCESS_CERT_MANAGER` | normal | system_grant | **false** | ❌ | 证书管理（对齐参考工程；本工程 0 处调用） |
| 4 | `RUNNING_LOCK` | normal | system_grant | true | ❌ | 运行时锁（对齐；0 处调用） |
| 5 | `PRINT` | normal | system_grant | true | ❌ | 打印（对齐；0 处调用） |
| 6 | `PREPARE_APP_TERMINATE` | normal | system_grant | true | ❌ | `onPrepareToTerminate` 里先停内置 Node |
| 7 | `ACCESS_BIOMETRIC` | normal | system_grant | true | ❌ | 生物识别（对齐；0 处调用） |
| 8 | `PRIVACY_WINDOW` | normal | system_grant | true | ❌ | 隐私窗口（对齐；0 处调用） |
| 9 | `WINDOW_TOPMOST` | normal | system_grant | true | ❌ | 窗口置顶（对齐；0 处调用） |
| 10 | `KEEP_BACKGROUND_RUNNING` | normal | system_grant | true | ❌ | `taskKeeping` 长时任务 |
| 11 | `INHERIT_PARENT_PERMISSION` | normal | system_grant | **false** | ❌ | 内置 Node 运行时与宿主同权限（名字带 `kernel.` 但属**开放权限**） |
| 12 | `kernel.IGNORE_LIBRARY_VALIDATION` | normal | system_grant | **false** | ❌ | 加载随包 `libnode.so` / `libnode_bridge.so` 时跳过库校验（同上，开放权限） |
| 13 | `kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` | normal | system_grant | **false** | ❌ | 随包运行时申请匿名可执行内存（**不能**替代 JIT ACL，见 §2 易错点 2） |
| 14 | `GYROSCOPE` | normal | system_grant | true | ❌ | 「应用获取设备方向」（对齐；0 处调用） |
| 15 | `ACCELEROMETER` | normal | system_grant | true | ❌ | 加速度计（同上） |
| 16 | `GET_FILE_ICON` | normal | system_grant | true | ❌ | 文件图标（对齐；0 处调用） |
| 17 | `LOCK_WINDOW_CURSOR` | normal | system_grant | true | ❌ | 锁定窗口光标（对齐；0 处调用；同在 `definePermissions`） |
| 18 | `READ_WRITE_DOCUMENTS_DIRECTORY` | normal | **user_grant** | true | ❌ | 「文件和文件夹 ⇒ 文档」：选择器「文档」Tab（运行期授权，§5） |
| 19 | `READ_WRITE_DOWNLOAD_DIRECTORY` | normal | **user_grant** | true | ❌ | 「文件和文件夹 ⇒ 下载」：选择器「下载」Tab（运行期授权，§5） |
| 20 | `CUSTOM_SCREEN_CAPTURE` | normal | **user_grant** | true | ❌ | 「截屏」：截取屏幕内容粘贴进会话（运行期授权；本工程 UI 侧 0 处调用） |

`jit` 变体额外声明的 1 项（**唯一的 ACL**）：

| # | 权限 | availableLevel | grantMode | provisionEnable | 需 ACL？ | 用途 |
|---|---|---|---|---|---|---|
| 21 | `kernel.ALLOW_WRITABLE_CODE_MEMORY` | **system_basic** | system_grant | true | ✅ **需 ACL** | 进程内 Node/V8 的 JIT（无它不带 `--jitless` 即 SIGTRAP）。**仅 `jit` 变体声明**；默认 compat 不声明 |

> 「声明面 ≠ 使用面」：第 3/4/5/7/8/9/14/15/16/17/20 项目前**只对齐声明、工程内 0 处调用**。
> 这样做的取舍是用户明确选择的（全量对齐参考工程）；代价是审计时要区分「已声明未使用」与「已使用」，
> 上表「用途」列已逐项标注。要收窄时按行删除即可，**不影响** ACL 与装机。

## 2. 判定规则（先说规则，再逐项判）

> **受限开放权限（需 ACL）** ⟺ `provisionEnable == true` **且** `availableLevel ∈ {system_basic, system_core}`。
>
> `provisionEnable == false` 的一律是**开放权限**：写进 `requestPermissions` 即可，安装时授予（`user_grant` 的还需运行期弹窗）。
> `grantMode: system_grant` **不等于**「不用申请」——受限权限多数也是 `system_grant`（安装即授予，**前提是 Profile 里有它**）。

两个易错点（本工程都踩过名实不符的坑）：

1. `kernel.INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 名字带 `kernel.`，但 `availableLevel: normal` + `provisionEnable: false` ⇒ **开放权限，不需要 ACL**，提交 ACL 是浪费配额。
2. 「加一个更宽的开放权限替代受限权限」**不成立**：`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 无法替代 `kernel.ALLOW_WRITABLE_CODE_MEMORY`（`ohos-node-bridge/docs/000-工程规划.md` §D.8 探针实测：开放权限下 V8 走 JIT 仍 SIGTRAP）。

**第三个易错点（2026-10-20 新增）**：`normal + user_grant` 的两项目录权限**不需要 ACL，但也不该被塞进 Profile 的 ACL 面** ——
本工程的调试 Profile 里它们确实在 `acls.allowed-acls` 中（见 §4.1），这与 §5 的「安装后 `grantFlag=2`」高度相关，
是下次重签时要收敛的项。姊妹工程的 Profile 只有 JIT 一项，`permissions: []`。

## 3. 现役 ACL：**compat 0 项 / jit 1 项**

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

**2026-10-21 R4：撤销 R2 的二次收敛，声明面回到「全量对齐参考工程」**。R2 曾把
`READ_WRITE_{DOCUMENTS,DOWNLOAD}_DIRECTORY` 从声明面删除；R4 按用户决定**重新声明**，
并一并补齐 `CUSTOM_SCREEN_CAPTURE`、`GYROSCOPE`、`ACCELEROMETER` 等其余缺项（逐项见 §1）。
口径与后果：

- 两项目录权限是 `normal` + `user_grant` ⇒ **不需要 ACL**，声明后装完仍是「未授予」，
  由用户在选择器对话框点「请求权限」触发系统授权弹窗（§5）；**装完打不开属正常现象**。
- 「截屏」（`CUSTOM_SCREEN_CAPTURE`）同为 `user_grant`：声明后才有弹窗入口，但本工程 UI 侧**尚无调用点**
  （只对齐声明面，不代表功能已实现）。
- 这些项**都不进**签名 Profile 的 `acls.allowed-acls`；零 ACL Profile 装机实测见 §10。
- R2 的取证结论仍有效且更要记住：**未声明的权限，运行期申请必被平台拒绝（`authResult=2`）** ——
  这正是 R4 要把声明面补齐的原因。

## 4. 装机与授权：实测记录

### 4.1 Profile 是授权面，声明面不等于授权面

DevEco 自动签名为 `org.fellow99.dsh.DshDesktopArk` 生成的调试 Profile（`~/.ohos/config/default_dsh-desktop-ark_*.p7b`）
解出来的形状（`openssl smime -verify -inform DER -in … -noverify`）：

**2026-10-21 重签后（当前，零 ACL）**：

```json
{ "type": "debug", "permissions": {}, "acls": { "allowed-acls": [] } }
```

装机实测（**R3，声明面 6 项**）：`hdc install -r` → `install bundle successfully`；启动 `phase=ready`、compat 自检 7/7；
`atm dump` 中 `DOCUMENTS / DOWNLOAD / WRITABLE` 均为 0 条。⇒ **零 ACL 发行线打通**（compat 不需要任何 ACL；
`jit` 变体在零 ACL Profile 上会装机失败，这是预期）。

装机实测（**R4，声明面 20 项 —— 当前**）：同一份零 ACL Profile，`hdc install -r` 仍 `install bundle successfully`；
启动 `phase=ready`、自检 7/7；`atm dump -t` **20 项在册**，其中 17 项 `grantStatus=0`，
3 项 `user_grant` 为 `-1`（`CUSTOM_SCREEN_CAPTURE`、`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY`），
`ALLOW_WRITABLE_CODE_MEMORY` 不存在。⇒ **「20 项全部不需要 ACL」由装机事实证实**（详见 §10）。

**2026-10-20 重签前（历史形状，保留取证）**：

```json
{
  "type": "debug",
  "permissions": {},                                     // ← 空
  "acls": { "allowed-acls": [
    "ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY",  // ← 现役唯一真 ACL
    "ohos.permission.READ_WRITE_DESKTOP_DIRECTORY",       // ← 2026-10-20 已撤销声明
    "ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY",     // ← normal+user_grant，本不该在 ACL 面
    "ohos.permission.READ_PASTEBOARD",                    // ← 2026-10-20 已撤销声明
    "ohos.permission.FILE_ACCESS_PERSIST",                // ← 2026-10-20 已撤销声明
    "ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY"       // ← normal+user_grant，本不该在 ACL 面
  ] }
}
```

历史形状的结论（保留）：

1. **`acls.allowed-acls` 里留着已撤销的声明项是无害的**（装机不再受它们约束；`atm dump` 里它们已 ABSENT）。
2. **但把 `normal + user_grant` 放进 ACL 面会有副作用**：安装期平台会给这两个权限打上 `grantFlag = 2`
   （`PERMISSION_SYSTEM_GRANT_FLAG`），而 `grantStatus` 仍是 `-1`。这个**自相矛盾的状态**正是 §5 里
   「点『请求权限』什么也没发生」的直接原因。姊妹工程同设备、同 API、同声明写法，Profile 里只有 JIT 一项 ⇒ 没有这个问题。
   ⇒ **下次重签时把这两项从 `allowed-acls` 移除**（它们本来就不需要 ACL）。

对照：姊妹工程 `pi-desktop-ark` 的反向实证（`docs/ACL配置.md` §2.1，2026-10-16 / HAD-W24）—— Profile **不含** ACL 时
装机直接被拒：`code:9568289 install failed due to grant request permissions failed, PermissionName: ohos.permission.READ_PASTEBOARD`。
本工程本轮未复现该失败（Profile 一开始就带齐），结论一致：**留着受限声明而 Profile 里没有它，就装不上**。

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

## 5. 运行期授权：点「请求权限」为什么可能**什么也没发生**

这是本工程 2026-10-20 定位到的问题，也是选择器「卡在加载中 / 一直显示未授权」的根因。

### 5.1 现象

点「请求权限」后日志出现（设备 `hilog`，ATM 域，**本应用进程内**）：

```
I accesstoken_service/ATM: [GetSelfPermissionsState]Bundle com.huawei.hmos.security.privacycenter,
                             uiExAbility PermissionGrantAbility, serExAbility PermissionServiceGrantAbility, callerPid 7156.
I accesstoken_service/ATM: [GetSelfPermissionState]ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY: status: -1, flag: 2
I org.fellow99.dsh.DshDesktopArk/ATM: [IsDynamicRequest]Permission: ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY: state: -1, errorReason: 0
I org.fellow99.dsh.DshDesktopArk/ATM: [RequestPermissionsFromUserExecute]It does not need to request permission
```

⇒ `requestPermissionsFromUser()` 立即返回，`authResults: []`、`permissions: []`。**没有弹窗，也没有授予。**

判读：`flag: 2` 是 `PERMISSION_SYSTEM_GRANT_FLAG`，`status: -1` 是「未授予」。平台看到「系统级已授予」的旗标
就不再走动态申请路径（`It does not need to request permission`），但实际并未授予 ——
**这个矛盾态就是「既不弹窗也不生效」**。源头是 §4.1 第 2 条（Profile 把这两项写进了 ACL 面）。


### 5.2 更普遍的形态：**就算弹窗了，`authResults` 也是空的**（2026-10-20 补测）

复位成 `flag 0 / status -1` 后弹窗正常出现，但**用户点「允许」和点「不允许」两种结果，`authResults` 都是 `[]`**：

| 输入 | 弹窗 | 返回 | `atm` 结果 |
|---|---|---|---|
| 点「允许」 | ✅ 出现 | `authResults: []` | `status 0 / flag 2`（**真的授予了**） |
| 点「不允许」 | ✅ 出现 | `authResults: []` | `status -1 / flag 2`（**真的没授予**） |

⇒ 在这台设备上，**`requestPermissionsFromUser` 的返回值不可作为判定依据**（授权与否都不告诉你），
唯一可信的事实是「目录现在能不能读」。这正是 §6 把判定基准换成文件系统的直接原因；
客户端的 `unknown` 文案也据此写成「平台没有给出授权结果……可能是你点了不允许，也可能是平台不受理」。

另有一处时序坑：**授权生效会滞后几百毫秒** —— 刚点完「允许」，紧接着的一次 `readdir` 仍是 `EACCES`，
约 0.5 s 后才通过。所以 `requestPermission()` 的收尾探测要**短轮询**（8 次 × 350 ms），
否则界面会误报「授权没生效」（首版实测踩到，用户必须手点一次「刷新」才看到列表）。

### 5.3 真机 UI 全流程（2026-10-20，干净起点 `status -1 / flag 0`）

| 场景 | 结果 |
|---|---|
| 打开选择器 → 点「文档」 | ✅ 显示授权门（「未获得该目录的访问权限」+ 请求权限 / 刷新），**未列目录、`atm` 未变**（点 Tab 不申请） |
| 点「请求权限」 | ✅ 系统弹窗「允许"DSH Desktop"访问你的"文档"文件夹？」，含 不允许 / 允许 |
| 点「允许」 | ✅ **自动列出** `DevEcoStudioProjects` / `JianyingPro` / `pi203-documents`（无需再点刷新）；`atm` → `status 0` |
| 点「下载」→ 请求权限 → 允许 | ✅ 弹窗「…访问你的"下载"文件夹？」，允许后**自动列出 7 项**；`atm` → `status 0` |
| 点「不允许」 | ✅ 停留在授权门，显示「平台没有给出授权结果…」，`atm` 保持 `-1`（不再弹窗的规则同姊妹工程） |

截图与原始 dump 在 `logs/20261020-1/`（本地留存，已 gitignore）：`31-documents-gate` / `32-documents-dialog` /
`33-documents-auto-listed` / `34-download-auto-listed` / `35-documents-denied`。
### 5.4 复位：让矛盾态回到「可申请」状态（已实测）

```bash
# 1) 看当前状态（status=-1 / flag=2 就是矛盾态）
hdc shell "atm dump -t -b org.fellow99.dsh.DshDesktopArk" | grep -A2 DOCUMENTS_DIRECTORY

# 2) 复位该应用的 user_grant 状态（flag 回到 0）
hdc shell "atm perm -r -b org.fellow99.dsh.DshDesktopArk"      # → Success

# 3) 再点「请求权限」（或经路由 POST /_ohos/picker/permission/request）
#    ⇒ 系统授权对话框真的出现：「允许"DSH Desktop"访问你的"文档"文件夹？」
hdc shell "uitest dumpLayout -p /data/local/tmp/layout.json"   # 读到 不允许 / 允许
hdc shell "uitest uiInput click 1742 1116"                     # 点「允许」

# 4) 复验
hdc shell "atm dump -t -b org.fellow99.dsh.DshDesktopArk" | grep -A2 DOCUMENTS_DIRECTORY  # grantStatus: 0
```

之后 `browse`/`list` 立刻能列出真实目录（`DevEcoStudioProjects` / `JianyingPro` / `pi203-documents`）。

设备侧权限定义（`/system/etc/access_token/permission_definitions.json`）确认这两项是
`grantMode: user_grant`、`availableLevel: normal`、`availableType: NORMAL`、`provisionEnable: true`、`since: 11`
—— **声明/级别完全没问题**，问题只在授权面的矛盾态。

### 5.5 交互约定（本工程定稿）

- **点 Tab 不申请权限**：只查状态。未授权时对话框**不显示列表**，改为「请求权限」「刷新」两个按钮；
- **「刷新」**：只重新探测状态，不申请；
- **「请求权限」**：用户点击后才 `perm.request`（弹系统授权窗）；
- Host 侧任何路径（`list` / `createDirectory`）都**不会**隐式申请权限；失败时把 `permissionRequired` 透传，由客户端决定渲染。

实现落点：Host `packages/workspace-picker-ohos/lib/{index.js,routes.js}`，Client `packages/workspace-picker-client-ohos/lib/client.js`。

## 6. `checkAccessTokenSync` 的已知假阴性 ⇒ 判定以「目录可读」为准

真机实测（2026-10-20，同一时刻）：

| 观测 | 结果 |
|---|---|
| `atm dump -t -b …` | `READ_WRITE_DOCUMENTS_DIRECTORY: grantStatus 0 / grantFlag 2`（**已授予**） |
| 真实列目录 | ✅ 200 + `DevEcoStudioProjects` / `JianyingPro` / `pi203-documents`（**确实能读**） |
| `perm.check`（`manager.checkAccessTokenSync`） | ❌ `granted:false`（**假阴性**） |

姊妹工程早就登记过这条（`pi-desktop-ark/entry/…/HostCapabilities.ets` 的 `perm.check` hint：
「真机已知假阴性：授予后仍可能报 false；判断能不能用请看真实读写结果」）。

于是本工程把**判定基准换成文件系统**（`packages/workspace-picker-ohos/lib/index.js`）：

| 方法 | 语义 |
|---|---|
| `probeAccess(root)` | `readdir` 探一次 ⇒ `readable` / `denied`(EACCES·EPERM) / `missing`(ENOENT·ENOTDIR) / `unknown` |
| `permission(rootId)` | 顺序：目录缺失 ⇒ 无需权限 ⇒ **可读（即已授权）** ⇒ 才问 `perm.check`；`perm.check` 只用于归因，不用于判「已授权」 |
| `probeAccessSettled(root)` | 同上，但**短轮询**（8 次 × 350 ms）：授权生效滞后几百毫秒，探一次会误判 |
| `requestPermission(rootId)` | **可读就不弹窗**；否则申请，**申请后短轮询探测**，以「现在能不能读」收尾；`authResults` 的 `0/-1/2/空` 四种分别上报，但**不决定**授权与否 |

对应结果码（路由/客户端共用）：`granted`、`not-granted`、`granted-unreadable`（API 说已授予但读不出）、
`denied`、`invalid`、`unknown`（平台没有应答，即 §5 的矛盾态）、`missing`、`unavailable`（宿主桥不可用）、`unknown-root`。

## 7. 设备与形态矩阵

本工程实测（`3QC0226526001227` = HAD-W32 / 2in1 / HarmonyOS 7.0.0.107 / API 26）：

| 场景 | `atm` 状态 | 真机结果 |
|---|---|---|
| 装完未授权 | `status -1 / flag 0` | `browse`/`list` ⇒ `EACCES`（正常，`user_grant` 本就要授权）；点 Tab 只显示授权门 |
| 点「请求权限」（`flag 0`） | 弹窗出现 | 点「允许」→ `status 0`、**自动列出**；点「不允许」→ `status -1`、留在授权门。两种情况 `authResults` 都是 `[]`（§5.2） |
| 已授权再申请 | `status 0` | ✅ 不发系统请求（可读即返回，不重复打扰） |
| `flag 2 / status -1` 矛盾态（§5.1） | **弹窗都不出现**，`authResults: []` | 界面只能停在授权门 ⇒ 必须 `atm perm -r -b` 复位，或重签 Profile（§4.1 / §8） |
| 撤销/拒绝后 | `-1` | 平台**不再弹窗**（姊妹工程四机一致）；只能去系统设置开启 |

姊妹工程四机对照（`pi-desktop-ark/docs/ACL配置.md` §5，同一套 API 家族）：

| 设备 | `deviceType` | 装完 `browse` | 运行时请求 | 授权后 |
|---|---|---|---|---|
| 2in1 `HAD-W32`（API 26） | `2in1` | 403 `EACCES` | ✅ `authResult:0`（静默授予，无弹窗） | ✅ 200（文档 3 项 / 下载 7 项） |
| 平板 `MRDI-W00`（API 24） | `tablet` | 403 `EACCES` | ✅ `authResult:0` | ✅ 200（文档 0 项 / 下载 4 项） |
| 手机 `JUY-AL80`（API 26） | `phone` | 403 `EACCES` | ❌ **`authResult:2`（请求无效）**，无弹窗 | ❌ 仍 403 |
| TV（非标准 OH，不列为验收对象） | `default` | 403 `EACCES` | ⚠️ `authResult:0` | ❌ 仍 403（该机**没有用户主目录**） |

`authResult` 语义（本地 SDK `security/PermissionRequestResult.d.ts`）：`0` 已授予、`-1` 未授予（用户拒绝）、`2` 请求无效。
本工程另加一种**非 SDK 值**：**空数组** = 平台根本没应答（§5）。

⚠️ 本工程 `deviceTypes` 只有 `["2in1","tablet"]`，手机（`7XNYD26515001370`）装不上（`code:9568413`），
所以手机侧结论只能沿用姊妹工程，且**不要**据此改代码。

## 8. 后续路线（均**未**实施）

1. **重签 Profile 时收敛 ACL 面**：`acls.allowed-acls` 只保留 `jit` 变体真正需要的那一项
   （`kernel.ALLOW_WRITABLE_CODE_MEMORY`）。R4 之后 20 项声明**全部是 normal 级**，一个都不需要进 ACL；
   若 Profile 里出现 `READ_WRITE_{DOCUMENTS,DOWNLOAD}_DIRECTORY` / `CUSTOM_SCREEN_CAPTURE`，属**多余授权**（会造出 §5.1 的 `flag 2 / status -1` 矛盾态），重签时删掉。
2. **改走系统选择器**（可选）：`DocumentViewPicker` 取一次性授权 URI，无需任何目录权限。
   现状：ArkTS 侧未实现 `picker.DocumentViewPicker`（本工程只有 `perm.openAppInfo` 与 `shell.openExternal`）。
3. **如实呈现**：`ENOENT`（设备没有该目录）与 `EACCES`（没授权）已分开（`result: 'missing'` vs `'not-granted'`），
   UI 分别给「只刷新」与「请求权限 + 刷新」。

## 9. 与运行时投放的关系

ACL 只决定**内存权限**，不影响原生库与载荷：`libnode.so`（120.9 MiB）由 `scripts/provision-runtime.sh`
（委托 `ohos-node-bridge/tools/provision.mjs`，七项 ELF 门禁 + SHA-256 对账）投放进 `entry/libs/arm64-v8a/`；
`libnode_bridge.so` 随 `@fellow99/node-bridge` HAR 打包；载荷 `dsh.tar.gz` 由 `scripts/assemble-payload.mjs` 生成、
`resfile` 随包分发，运行时由 `payload/bootstrap.js` 自解包（垫片 S1–S6）。

## 10. 109-jitless：默认 compat（零 ACL 声明）

| 项 | 内容 |
|---|---|
| 形态开关 | `entry/src/main/ets/common/BuildConfig.ets` 的 `NODE_MODE`（编译期常量，默认 `compat`） |
| 切换命令 | `node scripts/set-node-mode.mjs jit|compat`（同时改常量与 `module.json5` 的 JIT 声明面，幂等） |
| `compat` | 不声明 `ALLOW_WRITABLE_CODE_MEMORY`；库注入 `--jitless`；载荷装纯 JS `fetch` 兼容层 |
| `jit` | 成对声明该权限；不带 `--jitless`；兼容层零动作 |

**Profile 面（重签时收敛）**：`acls.allowed-acls` 只应保留 `jit` 变体真正需要的那一项。

- R4 之后 compat 的 20 项声明**全部是 `normal` 级**（§1），**一个都不需要 ACL**；Profile 里若出现
  `READ_WRITE_{DOCUMENTS,DOWNLOAD}_DIRECTORY` / `CUSTOM_SCREEN_CAPTURE` 等项目，属**多余授权**，
  会在运行期造出 `grantFlag=2 / grantStatus=-1` 的矛盾态（§5.1），重签时一并删除。
- 现役零 ACL Profile（`permissions: {}`、`acls.allowed-acls: []`）即可装 compat HAP；
  真正的零 ACL 验收以 §10 末尾的真机记录为准。

**复验（重签后必做）**：

```bash
# 1) HAP 声明面：compat 变体必须没有 JIT 权限，且总条数为 20
unzip -p entry/build/default/outputs/default/entry-default-signed.hap module.json | grep -c ALLOW_WRITABLE_CODE_MEMORY   # → 0
unzip -p entry/build/default/outputs/default/entry-default-signed.hap module.json | grep -c '"name": "ohos.permission'   # → 20
# 2) 设备授权面：三项用户授权项在册但未授予（grantStatus=-1），JIT 整项不存在
hdc shell "atm dump -t -b org.fellow99.dsh.DshDesktopArk" | grep -A1 -E "WRITABLE|DOCUMENTS|DOWNLOAD|SCREEN_CAPTURE"
# 3) 运行形态事实
hdc shell cat /data/app/el2/100/base/org.fellow99.dsh.DshDesktopArk/haps/entry/files/payload/ready.json
#    → compat.active=true, webAssembly=undefined, fetch=installed, selfcheck.status=ok
```

R3（声明面 6 项）与 **R4（声明面 20 项）**下 compat HAP **均安装成功**、`phase=ready`、自检 7/7；
R4 的 `atm dump -t` 为 **20 项在册、17 项 `grantStatus=0`**，未授予的恰好是 3 项 `user_grant`
（`CUSTOM_SCREEN_CAPTURE`、`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY`），
`ALLOW_WRITABLE_CODE_MEMORY` 整项不存在 —— 即「20 项声明全部不需要 ACL」被装机事实证实。
另：零 ACL Profile 下 `jit` 变体（声明 JIT 权限）**装不上**（预期，需带 ACL 的 Profile）。

**R4 附加观测（真机）**：声明补齐后，选择器「文档」目录**确实弹出了系统授权框**
（标题「允许"DSH Desktop"访问你的"文档"文件夹？」，正文取自 `$string:documents_dir`）——
这是 R3 做不到的（那时平台直接拒绝，`authResult=2`）。
**授权结果（用户手动复验，2026-10-21 通过）**：点「允许」后目录可正常列出，`atm dump` 随之变为
`READ_WRITE_DOCUMENTS_DIRECTORY` / `READ_WRITE_DOWNLOAD_DIRECTORY` 均 `grantStatus=0`、`grantFlag=2`
（与 §5.2 的「授予后 flag 变 2」一致）；`CUSTOM_SCREEN_CAPTURE` 未申请，仍为 `-1`。
注：此前用 `uitest uiInput click` 程序化点「允许」未生效（弹框关闭但状态未变），故该步以人工点按为准。

**既有实测（2026-10-20，本机）**：`node --jitless` 下兼容层自检 7/7 通过（GET、POST JSON、SSE 分块、
Abort、FormData、惰性 getter 封印、`fetch` 可用），耗时 ≈195 ms；jit 对照臂 `active=false`（零动作）。
