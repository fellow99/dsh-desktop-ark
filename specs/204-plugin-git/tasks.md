# 任务分解：插件·GIT 操作（204-plugin-git）

> 工程：`dsh-desktop-ark`　需求：`204-plugin-git`
> 依据：`spec.md`（WHAT）、`plan.md`（HOW）
> 图例：`⬜ 待办` / `🟡 进行中` / `✅ 完成` / `⛔ 阻塞`。任务完成后必须留下**可核对**的产物或证据。

---

## 阶段 0：准备

| # | 任务 | 产物 / 证据 | 状态 |
|---|---|---|---|
| T-204-000 | 确认同源实现与文档已读：`204-插件-GIT.md` §1–§22、`鸿蒙环境能力清单` §A/§C；确认本工程装配链（`assemble-payload` / `bundle-ohos` / `profiles/ohos`） | 本目录 `spec.md` §7 差异表 | ✅ |
| T-204-001 | 确认基线：`git branch --show-current` = `main`、工作树干净、设备在线（`hdc list targets`） | 会话记录 | ✅ |
| T-204-002 | 确认依赖可用：`pnpm add isomorphic-git@1.44.2` 在 staging 可完成（55 包 / ≈8.4 MiB）、`exports` 含 `./http/node` | staging 目录统计 | ✅ |

## 阶段 1：规格

| # | 任务 | 产物 | 状态 |
|---|---|---|---|
| T-204-010 | 写 `spec.md`（范围 / 用户故事 / FR-204-* / AC-204-* / 已知限制 / 与同源差异） | `specs/204-plugin-git/spec.md` | ✅ |
| T-204-011 | 写 `plan.md`（方案主轴 / 组件 / 挂载面 / 物化 / 围栏 / 凭据 / 工具面 / 数据流 / 错误处理 / 宪法 / 落点 / 验证 / 风险） | `specs/204-plugin-git/plan.md` | ✅ |
| T-204-012 | 写 `tasks.md` + `test-cases.md`（含脱敏纪律） | 同目录 | ✅ |
| T-204-013 | 工程索引登记：`specs/README.md`、`SPECS_CHECKLIST.md` | 两处 204 行 | ✅ |

## 阶段 2：开发（宿主面）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| T-204-020 | 建包骨架：`package.json`（`@dsh-ohos/git`、exports、`dsh.client`、peerDeps） | `packages/git-ohos/package.json` | `name` 与目录一致；`node --test` 可跑 |
| T-204-021 | 移植 `lib/config.js`（schemastery 四配置项，默认占位身份） | `lib/config.js` | 与同源逐字一致（除注释中的包名） |
| T-204-022 | 移植 `lib/runtime.js`（isomorphic-git 惰性装载 + 版本断言 / jsdiff 宿主闭包 major 断言） | `lib/runtime.js` | pin 常量与装配脚本一致 |
| T-204-023 | 移植 `lib/fs-adapter.js`（全 async、词法 + realpath 双检、`rm`） | `lib/fs-adapter.js` | 单测：每个方法 `AsyncFunction`、逃逸拒绝 |
| T-204-024 | 移植 `lib/fence.js`（仓库根解析、提权、错误映射） | `lib/fence.js` | 越界抛 `FS_SANDBOX_DENIED` |
| T-204-025 | 移植 `lib/auth.js` + `lib/git-credentials.js` + `lib/url.js` | 三文件 | 单测：9 例通过 |
| T-204-026 | 移植 `lib/diff.js` + `lib/report.js` | 两文件 | 纯函数可 import |
| T-204-027 | 移植 21 个 `lib/tools/*.js` | `lib/tools/` | 全部经 `defineTool` 注册 |
| T-204-028 | 移植 `lib/index.js`（命名导出、`inject=['tools','fs']`、自报一行日志） | `lib/index.js` | 日志前缀 `[dsh-ohos]` |
| T-204-029 | 移植 `lib/client.js`（`settings.section` + locale 命名空间） | `lib/client.js` | 只在浏览器半边执行 |

## 阶段 3：开发（装配面）

| # | 任务 | 文件 | 验收 |
|---|---|---|---|
| T-204-030 | `collectGitRuntime(stage)`：pnpm 物化 → 嵌套复制 → 断言（版本 / 入口 / 包数 / 不含 diff / 顶层 diff 仍是宿主） | `scripts/assemble-payload.mjs` | AC-204-11/12 |
| T-204-031 | bundle 行：`- id: git / name: '@dsh-ohos/git'` | `packages/bundle-ohos/cordis.patch.yml` | `assertInsertedRowsResolve` 通过 |
| T-204-032 | 调试通道：`BuildConfig.INSPECT_PORT` + `DshRuntime` 拼 `--inspect=127.0.0.1:<port>` | 两个 `.ets` | debug 构建 inspector 可达；`0` 即关闭 |
| T-204-033 | 包文档：`README.md` / `README_zh.md`（配置项、凭据规则、围栏、已知限制、物化步） | 两文件 | 无凭据/真实地址 |

## 阶段 4：本机验证

| # | 任务 | 命令 | 验收 |
|---|---|---|---|
| T-204-040 | 单测：适配器契约 + 凭据文件 | `node --test packages/git-ohos/test/*.test.mjs` | 全绿 |
| T-204-041 | 装配 dry-run：确认 insert 行可解析、物化断言通过 | `node scripts/assemble-payload.mjs --deploy`（不 `--apply`） | 退出码 0 |
| T-204-042 | 真实装配：物化 + 嵌套落位核对 | `node scripts/assemble-payload.mjs --deploy --apply` | `<stage>/node_modules/@dsh-ohos/git/node_modules/isomorphic-git` 在位 |
| T-204-043 | 载荷打包 | `node scripts/package-payload.mjs && node scripts/sync-payload.mjs` | `dsh.tar.gz` 更新 |

## 阶段 5：代码评审

| # | 任务 | 产物 | 验收 |
|---|---|---|---|
| T-204-050 | `requesting-code-review`：按 Critical / Important / Minor 出评审 | `logs/<日期>-N/REVIEW_REPORT.md` | 三级分类齐全 |
| T-204-051 | `receiving-code-review`：逐条核对再修（含拒绝项与理由） | 同上（处置列） | Critical 归零才可进测试 |
| T-204-052 | 复审（若有 Critical 修复） | 同上 | 无新增 Critical |

## 阶段 6：真机部署与测试

| # | 任务 | 命令 | 验收 |
|---|---|---|---|
| T-204-060 | 构 HAP（debug） | `bash scripts/build-hap.sh --debug` | `BUILD SUCCESSFUL` |
| T-204-061 | 装机 | `hdc install -r <hap>`（带 `-t <目标>`） | Success |
| T-204-062 | **清设备 `payload` 解压 marker**（否则继续跑旧产物）→ 启动 | `aa start -a EntryAbility -b org.fellow99.dsh.DshDesktopArk` | `ready.json` `phase=ready` |
| T-204-063 | 基础功能：设置 API Key → 创建工作区 → 一次对话 | 见 `test-cases.md` TC-204-D1…D3 | 三项通过 |
| T-204-064 | 无账号仓库全链 | TC-204-A1…A8 | 逐项结论（含预期失败项） |
| T-204-065 | 带账号仓库读写链 | TC-204-C1…C5 | 逐项结论；只推测试分支 |
| T-204-066 | 设置页与 `.git-credentials` | TC-204-S1…S3 | 页面 + 进程内取证 |
| T-204-067 | 密钥卫生检索 | TC-204-S4 | 四处无明文 |

## 阶段 7：测试报告与回归

| # | 任务 | 产物 | 验收 |
|---|---|---|---|
| T-204-070 | 写 `TEST_REPORT.md`（脱敏：只留 key 名与占位符） | `logs/<日期>-N/TEST_REPORT.md` | 每项有结论 + 证据关键词 |
| T-204-071 | 失败项修复与复测 | 同上（追加） | 失败项有归因或修复证据 |
| T-204-072 | 回归：既有插件（picker/notify/facts/open-in-app）与会话创建不受影响 | 同上 | 无新增失败 |

## 阶段 8：提交

| # | 任务 | 命令 | 验收 |
|---|---|---|---|
| T-204-080 | 提交规格 | `specification: 新增 204-plugin-git 规格（Ark 版 git 插件）` | 只含 specs/docs |
| T-204-081 | 提交实现 | `feat(204-plugin-git): …` | 只含代码/装配 |
| T-204-082 | 提交测试与文档 | `test(204-plugin-git): …` / `docs(204-plugin-git): …` | 报告已脱敏 |

> 提交前缀遵循 `git-commit` 技能（Conventional Commits：`type(scope): subject`），**不加 AI 署名**。

---

## 执行记录（2026-10-21，`logs/20261021-1/`）

| 阶段 | 结果 | 证据 |
|---|---|---|
| 阶段 0–3（准备 / 规格 / 开发） | ✅ | 本目录四件套 + `logs/20261021-1/DEV_CHECKLIST.md` §1 的 18 个落点 |
| 阶段 4（本机验证） | ✅ | 单测 **19 例：18 通过 / 1 跳过 / 0 失败**（`node --test packages/git-ohos/test/*.test.mjs`，含新增 `merge.worktree.test.mjs` 4 例）；装配 + 打包 + HAP 构建全绿 |
| 阶段 5（代码评审） | ✅ | `requesting-code-review` 派评审 → 2 Critical / 2 Important / 7 Minor；按 `receiving-code-review` 逐条核验后全部处置（见 `logs/20261021-1/REVIEW_REPORT.md`） |
| 阶段 6（真机部署与测试） | ✅ | 全部 `TC-204-*` 有结论；真机暴露并修复 2 个缺陷（`git_merge` 工作区/输出 schema、打包链删闭包） |
| 阶段 7（报告与回归） | ✅ | `logs/20261021-1/TEST_REPORT.md`；既有功能（picker / 设置页 / 会话 / 审批面板）无新增失败 |
| 阶段 8（提交） | 见提交记录 | Conventional Commits 前缀，无 AI 署名 |
