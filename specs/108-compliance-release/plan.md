# 技术方案：合规与发布（108-compliance-release）
> 工程：`dsh-desktop-ark`
> 状态：标识/版本/形态/单实例/权限声明/签名注入/构建模式 **implemented**；双发行线、包体与版本门禁、路径无关构建、ACL 与 AI 合规材料 **planned**
> 对应规格：`specs/108-compliance-release/spec.md`（FR-108-001…026）
> 依据：`docs/000-工程规划.md` §12.1–§12.4、§7.5、§11.1（P4）、§14（D3/D4/D10）；`specs/overall-plan.md` §6；`specs/TECH.md` §1、§5

---
## 1. 技术上下文
| 项 | 值 |
|---|---|
| 构建系统 | hvigor 6.1.1.280（CLT）+ ohpm；`buildModeSet` 为 `debug` / `release` |
| SDK | `compatibleSdkVersion 5.0.5(17)`、`targetSdkVersion 6.1.1(24)`；`minAPIVersion 17`、`targetAPIVersion 24` |
| 应用标识 | `org.fellow99.dsh.DshDesktopArk`，版本名 `0.1.0`，版本号 `100`（= 0×10000 + 1×100 + 0） |
| 形态 | `deviceTypes: ["2in1","tablet"]`；`launchType: singleton`；`backgroundModes: ["taskKeeping"]` |
| 原生库 | `compressNativeLibs: true` + `extractNativeLibs: true`（module 级，写进 build-profile 会被 schema 拒绝） |
| 签名 | `signingConfigs: []`（入库为空）+ `hvigorfile.ts` 运行时注入；无材料则产出未签名包 |
| 发行线 | 规划两条（standard / jitless）；当前只有单一 product `default` |
| 产物 | `entry/build/default/outputs/default/*.hap`（调试签名或未签名） |

---
## 2. 宪法合规
| 原则 | 结论 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 构建只读上游产物；不改上游源码 |
| C2 平台真相不隐藏 | ⚠️ | 无签名材料时"未签名包"有明确告警（`hvigorfile.ts:107-112`）；但权限清单里存在未使用项，等于对外宣称了不存在的能力面（见 F6） |
| C3 证据优先 | ⚠️ | TC-108-001…005 未执行；`docs/010-P0门禁报告.md` 与 `logs/` 证据缺失 |
| C4 单进程/单实例/随机端口 | ✅ | `module.json5:32` `launchType: "singleton"`；端口策略属 `101` |
| C5 谁写谁读 | ✅ | 不涉及解包；原生库由 `extractNativeLibs` 在安装期解开 |
| C6 绝对路径 | ✅ | 构建产物路径固定；脚本内路径由工程根派生（但存在盘符默认值，见 F9） |
| C7 垫片可审计 | ✅ | 不涉及垫片；垫片白名单在 `102` |
| C8 异常兜底 | ✅ | 不涉及运行时异常；构建期错误直接失败 |
| C9 鉴权只在 Host | ✅ | 不涉及鉴权；构建不注入凭据 |
| C10 权限最小化 | ❌（当前） | 14 项申请 + 2 项自定义声明，其中 `RUNNING_LOCK`、`KEEP_BACKGROUND_RUNNING`、`LOCK_WINDOW_CURSOR` 全仓无使用点（仅出现在 `module.json5`），命中"C10 违反症状" |
| C11 秘密不入库 | ✅ | `.gitignore` 覆盖 `signing.*.local.json`、`*.p12`、`*.cer`、`*.pem`、`*.keystore`；仓库内无密钥文件 |
| C12 编号即契约 | ⚠️ | `specs/108-*` 已建；`SPECS_CHECKLIST.md` 仍不存在，C12 的检查点无法执行 |
| C13 可复现 | ⚠️ | 二进制已 gitignore（`libs/*.har`、`entry/libs/`、`resfile/dsh-payload/`）；但 `build-hap.sh` 依赖 `cygpath`/`cmd //c` 与硬编码 CLT 路径（`:11`、`:47`、`:49-50`），跨机复现不成立 |
| C14 状态标注 | ⚠️ | `overall-plan.md` §6 描述"双发行线：同一 HAP 结构，构建参数与 `NodeRuntimeOptions.jitless` 不同"，但实现只有单一 product 且 `DshRuntime.ets:103` 硬编码 `jitless: false` —— 文档描述超前于实现 |

---
## 3. 研究结论
- **F1 标识与版本一致**：`AppScope/app.json5:2-8` 的 `bundleName`/`vendor`/`versionCode: 100`/`versionName: "0.1.0"` 与 `major*10000+minor*100+patch` 公式一致；`minAPIVersion 17`、`targetAPIVersion 24` 与 `build-profile.json5:9-12` 的 SDK 值一致（FR-108-001/004）。
- **F2 形态与实例**：`module.json5:7-10` 为 `["2in1","tablet"]`，未声明 phone（FR-108-002）；`:32` 为 `singleton`（FR-108-003）；`:28-30` 声明长时任务 `taskKeeping`。
- **F3 原生库策略**：`module.json5:14-17` 的 `compressNativeLibs`/`extractNativeLibs` 必须写在 module 级（注释已说明写入 build-profile 会被 schema 拒绝）；`build-profile.json5:13-21` 与 `entry/build-profile.json5` 均开 `collectAllLibs`（FR-108-023 的可达性前提）。
- **F4 权限实际清单（14 项）**：`module.json5:42-89` 依次为 `INTERNET`、`GET_NETWORK_INFO`、`RUNNING_LOCK`、`FILE_ACCESS_PERSIST`、`PREPARE_APP_TERMINATE`、`KEEP_BACKGROUND_RUNNING`、`kernel.ALLOW_WRITABLE_CODE_MEMORY`、`INHERIT_PARENT_PERMISSION`、`kernel.IGNORE_LIBRARY_VALIDATION`、`kernel.EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`、`READ_PASTEBOARD`、`READ_WRITE_DESKTOP_DIRECTORY`、`READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY`；`definePermissions`（`:91-94`）另有 `LOCK_WINDOW_CURSOR` 与 `kernel.ALLOW_WRITABLE_CODE_MEMORY`。
- **F5 与权限基线的偏差**：`docs/000` §12.1 只登记 7 项（JIT、剪贴板读、三个用户目录、持久化授权、联网、网络状态）。F4 中 `RUNNING_LOCK`、`PREPARE_APP_TERMINATE`、`KEEP_BACKGROUND_RUNNING`、`INHERIT_PARENT_PERMISSION`、`IGNORE_LIBRARY_VALIDATION`、`EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY`、`LOCK_WINDOW_CURSOR` 共 **7 项未登记**。结论：TC-108-001 按原文无法通过——要么补基线，要么收敛清单（FR-108-007）。
- **F6 未使用权限（C10 违反）**：全仓检索 `RUNNING_LOCK`/`KEEP_BACKGROUND_RUNNING`/`LOCK_WINDOW_CURSOR` 只命中 `module.json5`；没有 `backgroundTaskManager` 调用，也没有光标控制代码，且 `power.keepAwake` 能力仍是 `not-implemented`（`HostCapabilities.ets:112`）。`PREPARE_APP_TERMINATE` 由 `EntryAbility.ets:30` 的 `onPrepareToTerminate` 使用（保留合理）；`INHERIT_PARENT_PERMISSION`/`IGNORE_LIBRARY_VALIDATION`/`EXEMPT_ANONYMOUS_EXECUTABLE_MEMORY` 是加载随包 `libnode.so` 的前提（保留但必须写入基线理由）。
- **F7 签名注入契约**：`build-profile.json5:5` 的 `signingConfigs` 为空；`hvigorfile.ts:95-136` 在 `afterNodeEvaluate` 中注入——优先环境变量（`CERTPATH`/`STORE_FILE`/`STORE_PASSWORD`/`KEY_PASSWORD`，可选 `PROFILE`/`KEY_ALIAS`/`SIGN_ALG`，`:77-87`），其次 `signing.<mode>.local.json`（`:88-92`），都没有则告警并产出未签名包（`:107-112`）；`SIGN_MODE` 非法直接 `fail`（`:41-46`）；必填字段 `certpath`/`storeFile`/`keyPassword`/`storePassword`（`:29`）。与 FR-108-014…018 一致。
- **F8 双发行线未实现**：`build-profile.json5:24-27` 只有 `debug`/`release` 两种 buildMode、`products` 只有 `default`；`DshRuntime.ets:103` 硬编码 `jitless: false`；`scripts/build-hap.sh:15-21` 只接受 `--debug`/`--release`，无 `--jitless`、无 flavor、不读写版本号。FR-108-004/005/021/022 均为 planned。
- **F9 构建脚本平台绑定**：`scripts/build-hap.sh:13` 默认 CLT 为 `D:/oh-workspace/command-line-tools-6`；`:51`/`:56` 用 `cmd //c`，`:55` 用 `cygpath -w`；末行 `ls -l entry/build/default/outputs/default/`（`:59`）依赖固定产品名。脚本没有 `assemble-app`、没有包体统计、没有版本号校验（FR-108-019/023 planned）。
- **F10 二进制与密钥隔离**：`.gitignore` 已覆盖 `libs/*.har`、`entry/libs/`、`entry/src/main/resources/resfile/dsh-payload/`、`signing.*.local.json`、`*.p12`、`*.cer`、`*.pem`、`*.keystore`、`*.log`（C11/C13/FR-108-020 支撑）。
- **F11 体积未度量**：`libnode.so` 约 126.8 MB（TECH §3），HAP ≤ 200 MB 的余量取决于压缩率与载荷体积；当前无任何脚本或门禁统计（FR-108-023 planned）。
- **F12 合规材料缺失**：`docs/` 只有 `000-工程规划.md`；`docs/010-P0门禁报告.md`、`docs/020-ACL配置.md` 均不存在，AI 合规（§12.2）无落点文件（FR-108-024 planned）。

---
## 4. 数据模型
```jsonc
// AppIdentity（AppScope/app.json5）
{ "bundleName": "org.fellow99.dsh.DshDesktopArk", "vendor": "fellow99",
  "versionCode": 100, "versionName": "0.1.0", "minAPIVersion": 17, "targetAPIVersion": 24 }

// PermissionEntry（module.json5 → 归一化视图）
{ "name": "ohos.permission.READ_WRITE_DESKTOP_DIRECTORY", "class": "acl|normal|user_grant",
  "reason": "…", "usedScene": { "abilities": ["EntryAbility"], "when": "inuse" },
  "pairedInDefinePermissions": false, "usedInCode": true }

// SigningMaterial（不落库，仅构建期内存态）
{ "certpath": "/abs/x.cer", "storeFile": "/abs/x.p12", "profile": "/abs/x.p7b",
  "keyAlias": "debugKey", "keyPassword": "…", "storePassword": "…", "signAlg": "SHA256withECDSA" }

// ReleaseChannel（planned）
{ "name": "standard|jitless", "versionCode": 100, "jitless": false, "wasm": true, "notes": "…" }

// ArtifactManifest（planned）
{ "path": "entry/build/default/outputs/default/entry-default-unsigned.hap",
  "channel": "standard", "versionCode": 100, "payloadSha12": "ab12cd34ef56", "bytes": 0 }
```

规则：`versionCode` 由公式计算，不接受手填；`SigningMaterial` MUST NOT 持久化到仓库或日志；`ArtifactManifest` 的 `channel` 与 `jitless` 必须自洽。

---
## 5. 接口契约
### Provided（本模块对外）
| 契约 | 形态 | 消费者 |
|---|---|---|
| 应用标识与版本 | `AppScope/app.json5` 的包名/版本号/版本名 | 应用市场、装机脚本、`104` 的 `runtime.facts` |
| 权限清单 | `module.json5` 的 `requestPermissions` / `definePermissions` | 系统装机校验、`104`/`106` 的权限调用 |
| 签名注入 | 环境变量优先级 + `signing.<mode>.local.json` + 无材料降级 | 构建机、发布流程 |
| 构建入口 | `scripts/build-hap.sh --debug|--release` | 维护者、CI |
| 产物 | 签名/未签名 HAP | 装机、上架 |

### Consumed（本模块依赖）
| 契约 | 来源 | 备注 |
|---|---|---|
| hvigor / ohpm / CLT 与 SDK | 外部命令行工具 | 版本见 `TECH.md` |
| HAR 与原生库 | `scripts/build-bridge-har.sh`、`scripts/provision-runtime.sh` | 缺失时 `build-hap.sh` 先构建或报错 |
| 载荷 | `scripts/sync-payload.mjs`、`scripts/package-payload.mjs` | 幂等键写入 `dsh.version` |
| 权限使用方 | `104`（剪贴板/外部打开）、`106`（三个用户目录） | 决定哪些权限可保留 |
| 发行线开关 | `101` 的 `NodeRuntimeOptions.jitless`（当前硬编码 false） | FR-108-021/022 的落地前置 |

---
## 6. 实现策略（含错误处理）
| FR | 落地 | 状态 |
|---|---|---|
| FR-108-001/002/003 | 标识固定；形态 2in1/tablet；`singleton` | implemented |
| FR-108-004/005 | 版本号公式；两条线各自递增 | 公式 implemented；门禁 planned |
| FR-108-006 | 产物清单写入版本、模式、载荷幂等键 | planned |
| FR-108-007…013 | 基线双向对齐；删未使用权限；补理由与场景；装机失败码登记 | 声明 implemented；对齐与登记 planned |
| FR-108-014/015/016/017/018 | 密钥不入库；env 优先于本地文件；无材料降级；非法配置 fail；debug/release 分离 | implemented |
| FR-108-019 | 去 `cygpath`/`cmd //c` 与盘符默认值，改为 POSIX 分支或纯 hvigor 调用 | **planned** |
| FR-108-020 | 二进制 gitignore + 缺失即可执行提示 | implemented |
| FR-108-021/022 | 新增 `standard`/`jitless` 两个 product；`jitless` 作为构建期常量注入到 `NodeRuntimeOptions.jitless`（门禁 G4） | **planned** |
| FR-108-023 | 产物大小统计 + 200 MB 门禁；超限按"市场预置 → 文档资源"裁剪（门禁 G8） | **planned** |
| FR-108-024/026 | ACL 与 AI 合规材料、上架清单 | **planned** |
| FR-108-025 | 无静默上报；导出仅用户主动 | implemented（`107`） |

**错误处理**

- `SIGN_MODE` 非 `debug`/`release`：`hvigorfile.ts:41-46` 直接抛错终止构建（不猜默认值）。
- 本地签名文件缺必填字段或非 JSON 对象：`fail()` 带文件名与缺失字段（`:48-73`）。
- 无任何材料：只告警，产出未签名包（`:107-112`），保证编译验证不被密钥阻塞。
- 授权面缺受限权限：装机失败（已知错误码 `9568289`，见 `docs/000` §12.1），必须在 `docs/020-ACL配置.md` 登记（planned）。
- HAP 超预算：构建门禁失败并打印组成明细（planned）；不得以"删文档"以外的临场手段绕过。
- 版本号回退：门禁失败（planned），不允许两条线互相覆盖。

---
## 7. 测试考虑
| 用例 | 覆盖 FR | 层 | 判据 |
|---|---|---|---|
| TC-108-001 权限清单与基线一致 | FR-108-007/008/009 | L0 | 清单比对（当前**会失败**，见 F5/F6） |
| TC-108-002 无密钥可产出 | FR-108-014/016 | L0 | 构建日志 + 未签名产物存在 |
| TC-108-003 双线可区分且版本递增 | FR-108-004/021 | L0/L4 | 两条产物清单 |
| TC-108-004 包体 ≤ 200 MB | FR-108-023 | L3 | 产物大小 |
| TC-108-005 仓库无签名材料 | FR-108-014 | L4 | `git ls-files` 过滤为空 |

**建议新增**：权限使用审计脚本（每个 `requestPermissions` 项必须有代码引用，否则失败）；`jitless` 线装机 + 一次会话跑通；跨平台构建冒烟（Linux/macOS 或至少去掉 `cygpath` 后重跑）；版本号单调性检查（读取上一产物清单）。

---
## 8. 文件清单
| 路径 | 状态 | 说明 |
|---|---|---|
| `AppScope/app.json5` | implemented | 标识、版本号 100、版本名 0.1.0、API 17/24 |
| `entry/src/main/module.json5` | implemented（需收敛） | 形态、单实例、长时任务、14 项权限 + 2 项自定义声明 |
| `build-profile.json5` | implemented（需扩展） | 单 product `default`；`signingConfigs: []`；SDK 17/24 |
| `entry/build-profile.json5` | implemented | `collectAllLibs`；无 C++ 编译 |
| `hvigorfile.ts` | implemented | 签名注入（env → 本地文件 → 未签名包） |
| `scripts/build-hap.sh` | implemented（需去平台绑定） | `--debug`/`--release` |
| `scripts/build-bridge-har.sh` | implemented | 构建 HAR（产物 gitignored） |
| `scripts/provision-runtime.sh` | implemented | 投放 `libnode.so`/`libc++_shared.so` |
| `scripts/sync-payload.mjs` / `package-payload.mjs` | implemented | 载荷同步与确定性归档 |
| `.gitignore` | implemented | 二进制、载荷、密钥隔离 |
| `docs/020-ACL配置.md` | planned | 授权面材料与装机失败码 |
| `docs/010-P0门禁报告.md` | planned | G1–G10 取证 |
| `scripts/verify-release.mjs` | planned | 版本单调、权限审计、包体门禁 |
| `build-profile.json5` 的 `standard`/`jitless` products | planned | 双发行线剖面 |
