# REVIEW_REPORT — 000-scaffold

> 工程：`dsh-desktop-ark`
> 评审方式：`requesting-code-review`（独立评审员）+ `receiving-code-review`（逐条验证与修复）
> 基线：scaffold 首次可编译版本（`BUILD SUCCESSFUL`，818 KB 未签名 HAP）
> 日期：2026-10-18

---

## 1. 结论

**评审前不可进入下一阶段**：1 个 Critical（就绪判定错误，冷启动必然失败）阻断 L1 与 G1。
**修复后**：Critical 与 Important 全部处理；`hvigorw assembleHap` 重新通过；`selfcheck` 7/7。

---

## 2. Critical（已修）

| # | 位置 | 问题 | 违反 | 修复 |
|---|---|---|---|---|
| 1 | `DshRuntime.ets` | `waitUntilRunning` 以原生 `isRunning` 为判据（`node::Start` 前置真），随后只读一次 `ready.json`；冷启动读不到（`preparing` 都还没写）→ 必然 `FAILED`；也可能读到上一轮残留 | FR-101-007、`overall-data-model` §2/§3、G1 | 新增 `waitReady()`：20×500 ms 有界重试 + `at >= launchedAt` 新鲜度 + `schema===1` + `phase` 终态 + `token` 非空校验；`payload-missing`/`failed` 直接展示其 `diagnostic` |

## 3. Important（已修）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 2 | `DshRuntime.ets` | `startMailbox` 返回值被丢弃；信箱不可用时能力面整体不可用却仍进入 RUNNING | 判 `startsWith('started:')`，否则 `fail()` 并给出 transport 串 |
| 3 | `.gitignore` | `libs/*.har` 不匹配 `libs/@fellow99/…`，HAR 会入库 | 改为 `libs/**/*.har` |
| 4 | `scripts/sync-payload.mjs` | 同步会删掉 `dsh.tar.gz` 并把 `dsh.version` 改成脚本聚合 hash → `bootstrap` 判 sha 不符 | 先保存归档与版本、同步后原样恢复；无归档才写聚合 hash |
| 5 | `payload/host.js` | `authenticatedUrl` 无 token 时仍写 `phase:'ready'` | token 为空 → `phase:'failed'` + 诊断，不把无凭据 URL 交给页面 |
| 6 | `entry/src/main/ets/pages/Index.ets` | 缺导航围栏与页面错误回调 | 新增 `onLoadIntercept`（只放行 `127.0.0.1` / `about:blank` / `data:`，https 外链交 `openLink`）与 `onErrorReceive`（切错误覆盖层） |
| 7 | `scripts/package-payload.mjs` | ustar 条目名 >100 B 被静默截断 | 新增 `splitName()`：按 `/` 拆 `prefix(155)+name(≤100)`；无法拆分即抛错退出 |
| 8 | `entry/src/main/ets/host/HostCapabilities.ets` | `exists()` 只判 `path.length>0`，`userDirs[].available` 恒真 | 改为 `fs.accessSync`（失败即 false），与数据模型 §5 一致 |

## 4. Minor（已修，成本低且消除误导）

| # | 位置 | 修复 |
|---|---|---|
| 9 | `HostCapabilities.openExternal` | 非 https 仍返回 `not-implemented`（错误码语义待 P2 统一）——**未改**，登记为技术债 |
| 10 | `DshRuntime.readReady` | 已并入 #1（schema/token 校验） |
| 12 | `payload/bootstrap.js` | `writeReady` 改为 `open(wx) → write → fsync → rename` |
| 13 | `app/Probe.ets` | 同步抛出时 `destroy()`；最后一次失败不再多睡一个间隔 |
| 14 | `Index.ets` | `clearHistory()` 只执行一次（`historyCleared`），不再打断前端回退栈 |
| 15 | `entry/src/main/module.json5` | 删除未使用的 `RUNNING_LOCK` 与 `LOCK_WINDOW_CURSOR` 声明（C10） |
| 16 | `payload/selfcheck.js` | 增加 S3/S4 垫片标记断言（7/7） |
| 17 | `packages/bundle-ohos/cordis.patch.yml` | `sandbox-policy.mode` 跟随 `DSH_PERMISSION_MODE`，避免"策略 workspace-write + 审批 never" |
| 18 | 文档 | 新增 `specs/README.md`；`STRUCTURE.md` 文件数改为 26；`SPECS_CHECKLIST` 状态与证据同步 |

## 5. 明确未做（登记为后续）

| 项 | 原因 |
|---|---|
| `onWindowNew` / `onShowFileSelector` / `onDownloadStart` | 需真机确认 ArkWeb 行为；`onLoadIntercept` 已覆盖主风险 |
| `rawfile/error.html` | 当前用 ArkTS 覆盖层即可表达错误态；补静态页无额外信息 |
| `payload/shims` 的 S3/S4 实际替身包 | 属载荷物化阶段（`004-payload`），本轮只保证可审计 |
| `/_ohos/facts` | 模块 107 的 planned 范围 |
| 双发行线（`--jitless`） | 模块 108 的 planned 范围；需 `product` flavor |
| 真实载荷装配（pnpm deploy + 裁剪） | 需先锁定上游构建产物；`assemble-payload.mjs` 已是显式 dry-run |
| 用户目录权限基线 | 已按 D7 写入 `docs/000` §12.1（documents/download/persist/prepare/keep） |

## 6. 复验

| 检查 | 结果 |
|---|---|
| `hvigorw assembleHap`（修复后） | ✅ BUILD SUCCESSFUL |
| `payload/selfcheck.js` | ✅ 7/7（`ok: true`） |
| `scripts/verify-upstream.mjs` | ✅ ok（tag / clean / patch ids / profile / bundle） |
| HAP 内容 | ✅ 含 `resources/resfile/dsh-payload/**`（10 项）与 HAR 原生库；不含 `libnode.so`（未投放） |

## 7. Assessment

- **Critical 已清零**；Important 已全部修复；Minor 除 #9 外已修。
- 可进入下一阶段（真机 L1 取证），但必须先投放 `libnode.so` 并装配真实载荷。
- 下一需求建议：`001-adapters`（`@dsh-ohos/*` seam 插件 + `workspace-picker`）。
