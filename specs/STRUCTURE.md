# 目录结构（STRUCTURE.md）

> 工程：`dsh-desktop-ark`
> 采集时间：2026-10-18（`000-scaffold`）
> 说明：`*` 标记为**生成物/不入库**；其余为源码与文档。树中不含 `oh_modules/`、`entry/build/`、`.hvigor/` 的展开。

---

## 1. 顶层

```
dsh-desktop-ark/
├── AppScope/                     # 应用级标识与资源（bundleName / versionCode / icon）
├── entry/                        # 唯一 HAP 模块（ArkTS 外壳 + 资源）
├── payload/                      # Node 侧源码（bootstrap / host / shims / tar-extract / selfcheck）
├── profiles/ohos/                # dsh profile 模板（package.json + 用户 patch + .npmrc）
├── packages/bundle-ohos/         # @dsh-ohos/bundle（YAML patch 层）
├── scripts/                      # 构建/装配/打包/契约校验
├── specs/                        # 规范文档（本目录）
├── docs/                         # 工程规划（000-工程规划.md）
├── build/                        # * 装配暂存与本地自检目录（gitignored）

├── build-profile.json5           # 产品/模块/SDK 目标
├── hvigorfile.ts                 # 签名材料注入（环境变量或 signing.<mode>.local.json）
├── hvigor/hvigor-config.json5    # hvigor 版本与执行配置
├── oh-package.json5              # 中心仓依赖（@fellow99/node-bridge + @fellow99/node-runtime）

├── .gitignore
├── README.md
└── LICENSE
```

---

## 2. `entry/`（HAP 模块）

```
entry/
├── build-profile.json5           # apiType: stageMode；nativeLib.collectAllLibs
├── hvigorfile.ts                 # hapTasks
├── oh-package.json5              # name=entry, version=1.0.0
├── build/                        # * 产物（entry-default-signed.hap 等；libnode.so 由 @fellow99/node-runtime 包合入）

└── src/main/
    ├── module.json5              # deviceTypes 2in1/tablet；singleton；权限与 ACL 声明
    ├── ets/
    │   ├── entryability/EntryAbility.ets     # 生命周期；onPrepareToTerminate 不拦截
    │   ├── pages/Index.ets                   # ArkWeb + 加载/错误覆盖层 + 重启按钮
    │   ├── app/
    │   │   ├── DshRuntime.ets                # 启动编排状态机（idle→…→running）
    │   │   └── Probe.ets                     # HEAD 探活（20×500ms）
    │   ├── common/Constants.ets              # 路径/超时/能力名的单一事实源
    │   └── host/HostCapabilities.ets         # 14 项能力面（JSON 进出、永不抛）
    └── resources/
        ├── base/element/{string,color}.json  # 文案与启动背景色
        ├── base/media/{icon,startIcon}.png   # 应用图标
        ├── base/profile/main_pages.json      # pages/Index
        ├── rawfile/boot.html                 # 首帧加载页
        └── resfile/dsh-payload/              # * 载荷脚本 + dsh.version（sync-payload 生成）
```

---

## 3. `payload/`（Node 侧）

```
payload/
├── bootstrap.js                  # node::Start 入口：目录/异常兜底/垫片/解包/host
├── host.js                       # 载入 profile → runProfile → authenticatedUrl → ready.json
├── selfcheck.js                  # L0 自检（垫片/目录/ready schema）
├── lib/tar-extract.js            # 最小 ustar+gzip 解包（拒绝穿越/链接）
└── shims/
    ├── fs-link.js                # S1：fs.link EACCES → rename
    ├── fs-symlink.js             # S2：fs.symlink EACCES → copy
    ├── flock.js                  # S3：探测 flock 替身包（不隐式 patch 解析）
    ├── sharp.js                  # S4：探测 sharp 替身包
    └── sqlite.js                 # S5：探测 node:sqlite + FTS5
```

---

## 4. `profiles/` 与 `packages/`

```
profiles/ohos/
├── package.json                  # dsh.profile.bundles = base → web-app → @dsh-ohos/bundle
├── cordis.patch.yml              # 用户级 patch（空数组；设备可改、升级不覆盖）
└── .npmrc                        # node-linker=hoisted / package-import-method=copy / ignore-scripts

packages/bundle-ohos/
├── package.json                  # dsh.bundle.patch = ["./cordis.patch.yml"]
└── cordis.patch.yml              # 禁用 hmr/subprocess/sandbox/bash-sandbox/directory-picker/open-in-app；插入 @dsh-ohos/*
```

---

## 5. `scripts/`

| 脚本 | 职责 | 产物 |
|---|---|---|
| `sync-payload.mjs` | `payload/` → `resfile/dsh-payload/`，生成 `dsh.version` | resfile |

| `package-payload.mjs` | `build/payload-stage/dsh` → 确定性 `dsh.tar.gz` + `dsh.version` | resfile |
| `assemble-payload.mjs` | 装配载荷（dry-run 默认；`--from` 复制运行树） | `build/payload-stage/dsh` |
| `verify-upstream.mjs` | 校验上游 tag、零补丁、patch id、profile/bundle 可解析 | 退出码 |
| `build-hap.sh` | HAR → 运行时 → 载荷 → ohpm install → `hvigorw assembleHap` | HAP |

---

## 6. `specs/`（本目录，26 个文件）

```
specs/
├── README.md                     # 文档索引（最后生成）
├── SPECS_CHECKLIST.md            # 完成度追踪
├── STRUCTURE.md                  # 本文件
├── TECH.md                       # 技术选型
├── ARCHITECTURE.md               # 整体架构
├── constitution.md               # 宪法原则（C1–C14）
├── overall-spec.md               # 整体规格（FR-*）
├── overall-plan.md               # 整体技术方案
├── overall-data-model.md         # 数据模型
├── overall-test-cases.md         # 测试用例索引（TC-*）
├── 101-runtime-launch-orchestration/{spec,plan}.md
├── 102-payload-pipeline/{spec,plan}.md
├── 103-arkweb-shell/{spec,plan}.md
├── 104-host-capability-bridge/{spec,plan}.md
├── 105-upstream-adapter-bundle/{spec,plan}.md
├── 106-workspace-picker/{spec,plan}.md
├── 107-diagnostics-observability/{spec,plan}.md
└── 108-compliance-release/{spec,plan}.md
```

---

## 7. 模块 ↔ 代码映射

| 模块 | 主要代码 | 状态 |
|---|---|---|
| `101` | `entry/src/main/ets/app/{DshRuntime,Probe}.ets`、`common/Constants.ets` | implemented |
| `102` | `payload/**`、`scripts/{sync,package,assemble}-payload*` | implemented（无真实载荷时降级 `payload-missing`） |
| `103` | `entry/src/main/ets/pages/Index.ets`、`rawfile/boot.html` | implemented |
| `104` | `entry/src/main/ets/host/HostCapabilities.ets` | 部分 implemented（8 项占位） |
| `105` | `profiles/ohos/**`、`packages/bundle-ohos/**`、`scripts/verify-upstream.mjs` | YAML implemented；seam 插件 planned |
| `106` | 无（设计在 `docs/000-工程规划.md` §5.2） | planned |
| `107` | `payload/selfcheck.js`、`app.log`/`ready.json` 通道 | 部分 implemented（`/_ohos/facts` planned） |
| `108` | `module.json5`、`build-profile.json5`、`hvigorfile.ts`、`scripts/build-hap.sh` | 部分 implemented（双发行 planned） |

---

## 8. 生成物与忽略规则

| 路径 | 归属 | 是否入库 |
|---|---|---|
| `oh_modules/**`（含 `@fellow99/node-runtime` 的 `libnode.so`） | `ohpm install` | 否 |
| `entry/src/main/resources/resfile/dsh-payload/**` | `sync-payload.mjs` / `package-payload.mjs` | 否 |

| `entry/build/**`、`oh_modules/**`、`.hvigor/**`、`build/**` | 构建 | 否 |
| `signing.*.local.json`、`*.p12/*.cer/*.pem` | 本地签名 | 否 |
| `docs/**`、`specs/**`、`payload/**`、`scripts/**`、`profiles/**`、`packages/**` | 人写 | 是 |

---

## 9. 命名纪律

- 模块目录编号与 `specs/NNN-` 一致（`101`–`108`）；新增模块必须同步 `SPECS_CHECKLIST.md`。
- `payload/` 是脚本与垫片的**唯一事实源**；`resfile/` 是可重建产物。
- 所有运行期路径由 `context.filesDir` / `context.resourceDir` 派生（`common/Constants.ets`）。
