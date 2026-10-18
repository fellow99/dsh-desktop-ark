# 技术方案：上游适配层（105-upstream-adapter-bundle）

> 工程：`dsh-desktop-ark`
> 状态：YAML 装配层与契约断言 **implemented**；seam 插件包 **planned**
> 对应规格：`specs/105-upstream-adapter-bundle/spec.md`（FR-105-001…020）
> 依据：`docs/000-工程规划.md` §5.1–§5.5；`specs/overall-plan.md` §3；`specs/TECH.md` §5

---
## 1. 技术上下文

| 项 | 值 |
|---|---|
| 上游产品 | `deepseek-harness`，tag `dsh-v0.2.1-rc.2`（`git describe --tags` 实测一致） |
| 适配机制 | 上游 profile（`dsh.profile.bundles`）+ bundle patch（`dsh.bundle.patch`）+ seam 服务 |
| 覆盖语义 | patch 按行 id 覆盖，**整份 `config` 替换、不合并**（上游 base patch 头注释第 5–8 行） |
| 表达式 | 配置值支持 `!!js <expr>`，在 Loader 解析该行时求值（可读环境变量） |
| 设备环境 | 进程工作目录为 `/`；无内核沙箱、无 PTY、无 symlink/hardlink |
| 依赖布局 | `node-linker=hoisted` + `package-import-method=copy` + `ignore-scripts=true` |
| 校验方式 | Node ESM 脚本，git 与文件系统断言，失败以退出码 1 结束 |

---
## 2. 宪法合规

| 原则 | 结论 | 说明 |
|---|---|---|
| C1 上游唯一事实源 | ✅ | 全部适配在 `profiles/ohos/` 与 `packages/bundle-ohos/`；`scripts/verify-upstream.mjs` 断言上游 `status --porcelain` 为空（FR-105-017） |
| C2 平台真相不隐藏 | ⚠️ | `hmr`/`bash-sandbox` 显式禁用、`facts-ohos` 默认关闭；但 seam 包未实现，`open-in-app` 被禁用后无替代提供方，能力缺口必须继续标 `not-implemented`（FR-105-012） |
| C3 证据优先 | ⚠️ | 断言脚本可执行，但 TC-105-001…005 尚未执行，`logs/` 无证据（`overall-test-cases.md` §12 标记"待执行"） |
| C4 单进程/单实例/随机端口 | ✅ | 本模块不含进程/端口行为；不引入重启或固定端口 |
| C5 谁写谁读 | ⚠️ | profile 的 `node_modules` 物化责任在 `docs/000` §5.1（"安装时生成"）与 §7.2（载荷覆盖层）表述不一，需由 `102` 定案；本模块只读（FR-105-019） |
| C6 绝对路径 | ⚠️ | `sandbox-policy.workspaceRoot` 用环境变量注入（合规）；但 `workspace-picker.config.userRoot` 硬编码 `/storage/Users/currentUser`，与 `DSH_OHOS_USER_ROOT` 重复（见 §3-F6） |
| C7 垫片可审计 | ✅ | 垫片白名单与实现都在 `102`；本模块 YAML 不引入第 6 条垫片 |
| C8 异常兜底 | ✅ | 不涉及；异常兜底在 `102` 的载荷入口 |
| C9 鉴权只在 Host | ✅ | 未覆盖鉴权相关行（`connection`/`frontend-static` 保持上游） |
| C10 权限最小化 | ⚠️ | 本模块不声明权限；但 `open-in-app`、`notify`、`workspace-picker` 行启用后需要 `108` 的权限面配套，现为 `planned` |
| C11 秘密不入库 | ✅ | YAML 与脚本不含凭据；`DSH_OHOS_WORKSPACE` 等仅为路径 |
| C12 编号即契约 | ⚠️ | `specs/SPECS_CHECKLIST.md` 在仓库中不存在（`specs/` 仅有 overall-* 与 105–108 目录），C12 的检查点当前无法执行 |
| C13 可复现 | ✅ | 文本配置 + 幂等断言；无二进制产物（FR-105-020） |
| C14 状态标注 | ✅ | 本模块 spec 的"状态分解"表逐项标注 implemented/planned |

---
## 3. 研究结论

- **F1 组合顺序已落地**：`profiles/ohos/package.json:8-12` 的 `bundles` 为 base → web-app → `@dsh-ohos/bundle`；`packages/bundle-ohos/package.json:10-15` 声明 `dsh.bundle.patch`（FR-105-001/002）。
- **F2 行级语义确认**：上游 patch 的行结构为 `id / disabled / config / insert`，`config` 整份替换。本工程覆盖 `sandbox-policy` 时只写 `mode` 与 `workspaceRoot`，恰好等于该行自有键，故 FR-105-003 当前满足；任何新增键必须重述。
- **F3 上游没有 `shell` 行，也没有 `bash-local` 行**：`docs/000-工程规划.md` §5.2 表第 2 行写"原 `bash-local` 位置"与上游实际结构不符。实现上以插入 `shell-ohos` 行（`packages/bundle-ohos/cordis.patch.yml:44-49`）等价达成，但文档表述需修正。
- **F4 `mode` 与 `approval` 不同源（真实缺陷）**：本工程把 `sandbox-policy.config.mode` 硬编码为 `workspace-write`，而上游 `approval` 行仍按 `DSH_PERMISSION_MODE` 派生。若环境设为 `danger-full-access`，会出现"沙箱策略 workspace-write + 审批 never"，与 FR-105-003/009 冲突。修复方向：`mode` 改回 `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，或同时钉住 `approval`。
- **F5 `open-in-app` 缺口**：YAML 只 `disabled: true`，插入段没有 `@dsh-ohos/open-in-app`（对比 §5.1 表要求的"覆盖为 @dsh-ohos/open-in-app"）。后果：会话头的 Open-In 按钮丢失且无替代，属 FR-105-012 未完成。
- **F6 用户目录双份硬编码**：`workspace-picker.config.userRoot` 写死 `/storage/Users/currentUser`，而 `entry/src/main/ets/app/DshRuntime.ets:110` 注入 `DSH_OHOS_USER_ROOT`、`common/Constants.ets:33` 持有同一常量。应改为 `!!js process.env.DSH_OHOS_USER_ROOT`，否则改路径要动三处（违反单一事实源）。
- **F7 断言覆盖不足**：`scripts/verify-upstream.mjs:55-59` 只断言 6+2 个行 id 存在与清单可解析；不检查插入 id 唯一性、不检查 `workspaceRoot` 是否为 `/`、不检查 `!!js` 变量是否设置。因此 TC-105-004 目前**没有**自动判据。
- **F8 断言口径正确**：tag 用 `git describe --tags` 精确比较；实测上游为 `dsh-v0.2.1-rc.2`，与本工程锁定值一致。
- **F9 安装参数一致**：`profiles/ohos/.npmrc:1-6` 与 `docs/000` §7.3 的四行完全一致（FR-105-019）。
- **F10 `facts-ohos` 常闭**：`enabled: false` 与 FR-105-013 一致；"debug 构建可开启"需要构建期改写，未实现（planned，见 `107`）。

---
## 4. 数据模型

```jsonc
// ProfileManifest（profiles/ohos/package.json）
{ "name": "dsh-ohos-profile", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-ohos/bundle"] } } }

// BundlePatch（packages/bundle-ohos/cordis.patch.yml，有序）
[ { "id": "hmr", "disabled": true },
  { "id": "sandbox-policy", "config": { "mode": "workspace-write", "workspaceRoot": "!!js …" } },
  { "insert": [ { "id": "shell-ohos", "name": "@dsh-ohos/shell", "config": { "timeoutMs": 120000 } } ] } ]

// ContractAssertion（脚本输出）
{ "name": "patchId:base:hmr", "ok": true, "detail": "…" }
```

规则：`bundles` 顺序即覆盖顺序；`insert[].id` 必须全库唯一；`config` 值若为 `!!js` 表达式，环境缺失时该行 MUST 显式失败（不得落回 `process.cwd()`）。

---
## 5. 接口契约

### Provided（本模块对外）

| 契约 | 形态 | 消费者 |
|---|---|---|
| profile 清单 | `dsh.profile.bundles`（有序 3 项） | 上游 `loadProfileDirectory`（经 `payload/host.js`） |
| 覆盖层 | `dsh.bundle.patch` 指向的 YAML | 上游 Loader |
| 用户层 | 空 patch（设备可改、升级不覆盖） | 用户 / 后续 profile 编辑 UI |
| 安装参数 | `.npmrc` 四行 | 内置 pnpm（`102`/`110`） |
| 门禁 | `scripts/verify-upstream.mjs`：成功 exit 0，失败 exit 1 且逐条打印 `✗` | CI / 维护者 |

### Consumed（本模块依赖）

| 契约 | 来源 | 备注 |
|---|---|---|
| 行 id 集合与覆盖语义 | 上游两个 bundle patch | 改名即门禁失败（FR-105-005/018） |
| `!!js` 求值时机 | 上游 Loader | 只依赖"环境变量 → 配置值" |
| `DSH_OHOS_WORKSPACE` / `DSH_OHOS_USER_ROOT` | `101` 的启动选项注入 | 缺失时本模块不为默认值兜底 |
| `@dsh-ohos/*` seam 包 | `102` 载荷物化 | 未物化则该行加载失败 |
| 宿主能力名 | `104` | `shell.openExternal` / `notify.show` 等 |

---
## 6. 实现策略（含错误处理）

| FR | 落地 | 状态 |
|---|---|---|
| FR-105-001 | profile `bundles` 固定 3 项顺序 | implemented |
| FR-105-002/003 | bundle patch 三类操作；`sandbox-policy` 只写自有键 | implemented |
| FR-105-004 | 插入 id 前缀化（`*-ohos`）；与上游 id 不重名 | implemented |
| FR-105-005/018 | 断言缺失 id → stderr 打印 → `process.exit(1)` | implemented |
| FR-105-006 | 用户层 patch 仅含注释与空数组 | implemented |
| FR-105-007/010/014 | `hmr`/`bash-sandbox` 禁用；`session-query-sqlite` 不动 | implemented |
| FR-105-008 | `subprocess`/`sandbox` 禁用后插入 `*-ohos` 行 | YAML implemented；包 planned |
| FR-105-009 | `sandbox-policy` 保留并覆盖 `workspaceRoot` | implemented（`mode` 待按 F4 修正） |
| FR-105-011 | 禁 `directory-picker`，插 `directory-picker-browse` + `workspace-picker` | YAML implemented；插件 planned（`106`） |
| FR-105-012 | `open-in-app` 已禁用，替代行缺失 | **未完成** |
| FR-105-013 | `notify-ohos` / `facts-ohos(enabled:false)` 插入 | YAML implemented；端点 planned（`107`） |
| FR-105-015 | 降级登记在 `docs/000` §5.4 | implemented（需随实现更新） |
| FR-105-016/017 | tag 与工作区状态断言 | implemented |
| FR-105-019/020 | `.npmrc`；无二进制 | implemented |

**错误处理**

- 上游不可读（无 git / 目录缺失）：脚本捕获异常并转成 `problems[]`，仍然 exit 1，不静默通过。
- 表达式求值得到 `undefined`：不自行兜底；由上游 Loader 报错，`payload/host.js` 的 `runProfile` 捕获后写 `ready.json` 的 `phase:'failed'` 与 `diagnostic`。
- seam 包未物化：行加载失败 → 同上路径 → 错误页展示阶段与诊断，符合 C2。
- 版本不一致：`verify-upstream` 先失败，禁止带着错 tag 出包（C13）。

---
## 7. 测试考虑

| 用例 | 层 | 现状 | 判据 |
|---|---|---|---|
| TC-105-001 清单可解析 | L0 | 待执行 | 脚本 exit 0 + `profile bundles` 输出 |
| TC-105-002 行 id 存在 | L0 | 待执行 | 缺失时 `✗` 行即失败样本 |
| TC-105-003 hmr 禁用 / subprocess 指向 | L0 | 待执行 | 解析后的配置树快照 |
| TC-105-004 `workspaceRoot` 不是 `/` | L0 | **无自动断言** | 需新增断言后才有判据 |
| TC-105-005 上游零补丁 | L0 | 待执行 | `git status --porcelain` 为空 |

**建议新增**：`mode` 与 `approval` 同源断言（F4）；`userRoot` 与 `DSH_OHOS_USER_ROOT` 一致性断言（F6）；插入 id 唯一性断言（F5）。测试只做静态解析，不需要真机。

---
## 8. 文件清单

| 路径 | 状态 | 说明 |
|---|---|---|
| `profiles/ohos/package.json` | implemented | 三包有序组合 |
| `profiles/ohos/cordis.patch.yml` | implemented | 用户层空 patch |
| `profiles/ohos/.npmrc` | implemented | 安装参数四行 |
| `packages/bundle-ohos/package.json` | implemented | `dsh.bundle.patch` 声明 |
| `packages/bundle-ohos/cordis.patch.yml` | implemented | 覆盖层（含 F4/F5/F6 待修正点） |
| `scripts/verify-upstream.mjs` | implemented | 上游契约断言 |
| `packages/subprocess-ohos/` | planned | `@dsh-ohos/subprocess` |
| `packages/sandbox-ohos/` | planned | `@dsh-ohos/sandbox` |
| `packages/shell-ohos/` | planned | `@dsh-ohos/shell`（非 PTY + 哨兵协议） |
| `packages/workspace-picker-ohos/` | planned | `@dsh-ohos/workspace-picker`（见 `106`） |
| `packages/open-in-app-ohos/` | planned | `@dsh-ohos/open-in-app`（F5 缺口） |
| `packages/notify-ohos/` | planned | `@dsh-ohos/notify` |
| `packages/attachment-image-ohos/` | planned | `sharp` 替身 + 图像桥 |
| `packages/sqlite-ohos/` | planned | 仅 G2 未过时启用 |
| `packages/sharp-stub/` | planned | 包名必须为 `sharp` |
