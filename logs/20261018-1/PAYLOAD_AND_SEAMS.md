# 真实载荷装配 + 8 个 seam 插件 —— 实施与验证记录

> 日期：2026-10-18 ｜ 对应需求：`000-scaffold` 的后续（102 装配阶段 + 105 seam 插件包）
> 环境：Windows 宿主机 ｜ Node **v24.14.1**（宿主）／载荷运行时 **v24.2.0** ｜ pnpm **11.28.5** ｜ DevEco CLT **6.1.1.280**（SDK API 24）
> 上游：`deepseek-harness` tag **`dsh-v0.2.1-rc.2`**，工作区零改动（`node scripts/verify-upstream.mjs` 通过）

## 1. 做了什么

| 面 | 变更 |
|---|---|
| 装配 | `scripts/assemble-payload.mjs` 重写：`--deploy`（`pnpm deploy --legacy` → Junction 物化 → `@deepseek-ai` 补全 → 非 hoisted 摊平 → 删 `.pnpm` → 注入 web dist）、`--from`、剪裁、覆盖层注入、断言；`--apply` 才落盘 |
| 打包 | `scripts/package-payload.mjs`：归档已最新时快速跳过（`--force` 可重打）、`builtAt` 取载荷树最新 mtime（可复现）、编码失败以退出码 1 终止 |
| 运行期 | `payload/bootstrap.js`：profile 改由运行根载入、新增 `$DSH_HOME/user-patch.yml`；`payload/host.js`：`projectDir=<runRoot>/profiles/ohos`、`patchFiles=[user-patch]` |
| seam 插件 | `packages/*-ohos/` 下 10 个包（8 个 seam + `@dsh-ohos/bundle` 覆盖层 + `@dsh-ohos/host-bridge` 共享桥）；纯 ESM、无构建、无第三方依赖 |
| 覆盖层 | `packages/bundle-ohos/cordis.patch.yml`：新增 `pwsh-sandbox` / `permission` 禁用、`open-in-app-ohos` / `attachment-image-ohos` 插入；移除 `directory-picker-browse` 插入行（改由 workspace-picker 隔离自挂） |
| 冒烟 | 新增 `scripts/smoke-payload.mjs`（宿主 Node 上加载 profile 并断言行） |

## 2. 验证证据（命令 + 实际输出）

### 2.1 上游构建

```
corepack/pnpm run build:lib:host   → exit 0
pnpm run build:lib:client          → exit 0
pnpm run build:web                 → exit 0
产物：apps/cli/lib/bin.js、packages/core/agent/lib/index.js、apps/web/dist/index.html
```

### 2.2 装配（`node scripts/assemble-payload.mjs --deploy --apply`）

```
pnpm deploy --legacy → 物化链接 141 处 → 补全 @deepseek-ai 包 225 个 → 补全非 hoisted 依赖 251 个
剪裁：移除 26149 个文件 / 477.3 MiB
profile 已注入：profiles/ohos（3 个 bundle）
seam 插件已注入：10 个
✓ @deepseek-ai/dsh 存在   ✓ Web UI dist 存在   ✓ profiles/ohos 存在
✓ bundle 插入行可解析（8 行）   ✓ 无 symlink/hardlink
已落地：build/payload-stage/dsh（15192 文件 / 151.3 MiB）
```

剪裁前：41 331 文件 / 628.6 MiB（其中 `@deepseek-ai/libreoffice-kit-win32-x64` 单项 184 MB、`sherpa-onnx-win-x64` 23 MB、`node-pty` 27 MB、`*.map` 95 MB、`*.ts` 73 MB、`*.d.ts` 36 MB）。

### 2.3 打包（`node scripts/package-payload.mjs`）

```
[package-payload] 15192 files, 158669733 bytes -> resfile/dsh-payload/dsh.tar.gz (40444098 bytes gz)
[package-payload] sha256=db181e3b436438790d48cbe0da6b72092f0a8d58a545c34fbe6f6ea200a68f48 sha12=db181e3b4364
```

### 2.4 载荷树冒烟（`node scripts/smoke-payload.mjs`）

```
层数=3 行数=232
禁用行：… hmr, subprocess, sandbox, bash-sandbox, directory-picker, open-in-app …
@dsh-ohos 行：subprocess-ohos, sandbox-ohos, shell-ohos, workspace-picker, notify-ohos,
             facts-ohos, open-in-app-ohos, attachment-image-ohos
OK
```

### 2.5 端到端（宿主 Node，同一份 `resfile` 载荷）

```
2026-10-18T15:29:00 bootstrap: start
2026-10-18T15:29:00 DSH_OHOS_SHIM fs.link installed / fs.symlink installed
2026-10-18T15:29:00 DSH_OHOS_SHIM node:sqlite: available=true fts5=true (ok)
2026-10-18T15:29:13 tar-extract: 15192 files -> <payload>/db181e3b4364.staging   （13.2 s）
2026-10-18T15:29:13 payload: extracted 15192 files
2026-10-18T15:29:13 DSH_OHOS_SHIM flock installed / sharp installed
2026-10-18T15:29:15 host: ready at http://127.0.0.1:1134
phase=ready
GET token-url -> 200（36 988 B，<title>DSH Local Build</title>）
「did not activate」条目：0
```

### 2.6 HAP（`bash scripts/build-hap.sh`）

```
provision: libnode.so / libc++_shared.so 已是最新（SHA-256 命中）
[package-payload] 归档已是最新（15192 files, sha12=db181e3b4364）→ 跳过
> hvigor BUILD SUCCESSFUL in 9 s 511 ms
entry-default-unsigned.hap  86 409 616 B（86 MB）
  内含 libs/arm64-v8a/{libnode.so 126 809 264 B, libc++_shared.so, libnode_bridge.so, libnode_host_client.so}
       resources/resfile/dsh-payload/{bootstrap.js, dsh.tar.gz 40 444 098 B, dsh.version, …}（11 项）
```

### 2.7 插件自测（fixer 交付并复核）

`node --check` 31 个 JS 文件全通过；9 个 `test/smoke.mjs` 共 91 项断言全绿；12 个入口 ESM import 成功。

## 3. 本轮修掉的真实缺陷（都有现场证据）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | 8 个 seam 插件全部 `ERR_MODULE_NOT_FOUND` | profile 被复制到 `$DSH_HOME/profiles/ohos`，ESM 从那里向上找不到 `<runRoot>/node_modules` | profile 留在运行根，用户 patch 单列 `$DSH_HOME/user-patch.yml` |
| 2 | 13 条 profile 行未激活 | 同 #1（9 条）+ 下列 3 条 | 修后 **0 条** |
| 3 | `pwsh-sandbox` 与我们的 shell 重复注册 `ctx.shell` | 上游另有 pwsh 提供方未禁用 | 覆盖层禁用 `pwsh-sandbox` |
| 4 | `permission` 拒绝挂载：执行器无 `sandboxMode` | 鸿蒙无内核隔离，我们的 shell 如实不声明；permission-presets 视其为误配置 | 明确禁用该行（不伪造 `sandboxMode`），并在 yml 注释说明 |
| 5 | `open-in-app-ohos` 报 "cannot get property connection without inject" | 插件文件末尾多写了 `export default apply`，loader 取 default（纯函数）从而丢掉 `inject` | 删除 `default` 导出（`facts`/`notify` 同类问题一并删除） |
| 6 | `directory-picker-browse` 与 `workspace-picker` 重复注册 `ctx.directoryPicker` | 两行同层插入 | 移除 browse 插入行，由 workspace-picker 在隔离作用域自挂 |
| 7 | 归档 191 MB（超 HAP 预算） | deploy 树带着 Windows 预编译包与源码 | 装配期剪裁（见 2.2），gz 降至 40.4 MB |

## 4. 仍未完成 / 需真机确认

- **真机（HarmonyOS 6.1.0.135 / API 24）**：ArkWeb → `127.0.0.1` 放行（G1）、`sh` 哨兵协议（G3）、JIT ACL（G4）、首启解包耗时与内存。
- **能力面占位**：`fs.pickFolder` / `fs.pickFiles` / `fs.saveFile` / `notify.show` / `clipboard.*` / `image.normalize` / `power.keepAwake` 在 ArkTS 侧仍返回 `not-implemented` ⇒ 依赖它们的 seam（workspace-picker 的选择动作、notify、attachment-image 的像素转换）只能显式失败。
- **审批预设**：因无可隔离执行器而禁用（见 §3 #4）。
- **无 PTY**：`subprocess.spawnTerminal` 诚实抛 `not-supported`。
- **S3/S4/S5**：`flock`/`sharp` 仍是"替身包存在性 + 模块级替换"，`node:sqlite` 重定向未做（当前靠运行时内建 FTS5，实测 `fts5=true`）。
- **旧版本载荷清理**（保留最近 1 份）仍未实现。
