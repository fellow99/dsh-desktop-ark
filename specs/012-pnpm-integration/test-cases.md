# 012-pnpm-integration 测试用例

| ID | 前置 | 步骤 | 通过判据 |
|---|---|---|---|
| TC-012-01 | 构建机 | `node scripts/assemble-payload.mjs --deploy --apply` | 日志出现 `pnpm 引擎已物化 (pnpm@10.34.6)`；`<stage>/node_modules/dsh-market-pnpm/bin/pnpm.cjs` 非空 |
| TC-012-02 | 构建机 | 改动 `PNPM_VERSION` 或删产物 `package.json` 后重跑 | 断言失败、退出码 1（不产出残缺 stage） |
| TC-012-03 | 构建机 | `node --test packages/market-ohos/test/*.test.mjs` | 全绿 |
| TC-012-04 | Host 启动 | 读 `<profileDir>/pnpm-workspace.yaml` | 含 `nodeLinker: hoisted`、`autoInstallPeers: false`、`packageImportMethod: copy`、`ignoreScripts: true`、`storeDir` 为绝对路径且存在 |
| TC-012-05 | Host 启动 | `grep '\[dsh-ohos\]' app.log` | 出现 `desktopProfiles/desktopPnpm provided (… engineOk=true worker=ok)` |
| TC-012-06 | 应用运行 | 市场安装一个纯 npm 插件 | profile `node_modules/<pkg>/package.json` 出现；安装期间 `ps -ef` 无新增 pnpm/node 子进程 |
| TC-012-07 | 应用运行 | 安装中取消 | `done` 非零；stderr 含「已取消」；无残留 worker |
| TC-012-08 | 应用运行 | 连续触发两次安装 | 第二次同步抛 `another desktop pnpm operation is already running`，市场显示 busy |
| TC-012-09 | 应用运行 | 设 `DSH_PNPM_ENGINE=/nonexistent` 后安装 | 127 + stderr 点名期望路径；应用不崩 |
| TC-012-10 | 真机 jitless | 安装一个含依赖的插件，观察日志 | 无 `WebAssembly is not defined`；安装成功 |
