# DEV_CHECKLIST — 000-scaffold

> 工程：`dsh-desktop-ark`
> 日期：2026-10-18
> 需求：`000-scaffold`（工程搭建）

---

## 1. 环境

| 项 | 值 | 检查 |
|---|---|---|
| CLT | `D:/oh-workspace/command-line-tools-6`（6.1.1.280） | ✅ |
| SDK | API 24 / 6.1.1.125 | ✅ |
| Node（构建机） | v24.14.1 | ✅ |
| 设备 | 未连接 | ⬜ |

## 2. 任务

| # | 任务 | 状态 | 证据 |
|---|---|---|---|
| 1 | `ohos-node-bridge` HAR 构建 | ✅ | `library.har` 502,291 B |
| 2 | 根/模块配置（build-profile / hvigorfile / oh-package） | ✅ | `entry-default-unsigned.hap` |
| 3 | ArkTS 外壳（EntryAbility / Index / DshRuntime / Probe / Constants / HostCapabilities） | ✅ | 编译通过 |
| 4 | Node 载荷（bootstrap / host / tar-extract / 5 垫片 / selfcheck） | ✅ | selfcheck 7/7 |
| 5 | `ohos` profile + `@dsh-ohos/bundle` | ✅ | `verify-upstream.mjs` 通过 |
| 6 | 构建脚本（HAR / 运行时 / 同步 / 打包 / 装配 / 契约 / HAP） | ✅ | 脚本齐全 |
| 7 | 规范文档（10 根 + 8 模块 ×2） | ✅ | 26 文件 |
| 8 | 代码评审与修复 | ✅ | `REVIEW_REPORT.md` |
| 9 | 真机安装与 L1–L4 | ⬜ | 缺设备（运行时已投放） |

## 3. 本轮命令记录（可复现）

```bash
# HAR
cd ohos-node-bridge && hvigorw --mode module -p module=library@default assembleHar --no-daemon

# 契约
cd dsh-desktop-ark && node scripts/verify-upstream.mjs        # ok

# 载荷
node scripts/sync-payload.mjs                                 # 9 files / 26,074 B
NODE_BRIDGE_PAYLOAD_ROOT=$PWD/build/selfcheck node payload/selfcheck.js   # ok: true, 7/7

# 构建
DEVECO_SDK_HOME=<sdk> hvigorw --mode module -p product=default -p buildMode=debug assembleHap --no-daemon
# BUILD SUCCESSFUL → entry-default-unsigned.hap (44 MB，含 libnode.so)
```

## 4. 已知未完成

- `libnode.so` 已投放（126.8 MB，HAP 44 MB）；L1 仍缺设备。
- 真实 dsh 载荷未装配（`payload-missing` 为预期状态）。
- `@dsh-ohos/*` seam 插件、`workspace-picker`、`/_ohos/facts`、双发行线均为 `planned`。
- `ohos-node-runtime` 已迁入 `ohos-node-bridge/runtime/`（`runtime/README.md` 为其说明入口）。
