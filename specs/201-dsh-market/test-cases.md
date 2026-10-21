# 201-dsh-market 测试用例

| ID | 前置 | 步骤 | 通过判据 |
|---|---|---|---|
| TC-201-01 | 构建机 | `node scripts/assemble-payload.mjs --apply` | 日志含「dshmarket 已物化」；`<stage>/node_modules/dshmarket/{package.json,cordis.patch.yml,lib/index.js,client/client.js}` 存在；`node_modules/{js-yaml,undici}` 可解析；无 `@deepseek-ai` |
| TC-201-02 | 构建机 | 临时重命名 `../dsh-market/lib` 后重跑 | 断言失败、退出码 1，提示 `npm run build` |
| TC-201-03 | 构建机 | 检查 `profiles/ohos/package.json` | bundles 末位为 `dshmarket`；无 `dependencies` 字段 |
| TC-201-04 | 应用启动 | 读 `app.log` | 出现 market `desktopProfiles/desktopPnpm provided`；`loadProfileDirectory` 未把 `dshmarket` 列入 skipped |
| TC-201-05 | 应用运行 | 设置 → 插件市场 | 入口存在；目录可拉取（或如实记录网络不可达） |
| TC-201-06 | 应用运行 | 安装第一个插件 | `node_modules/<pkg>/package.json` 出现；`.dsh-market/log.ndjson` 的 `event:install` 记录 `detail` 含 `exit=0`；UI 显示已安装 |
| TC-201-07 | 应用运行 | 使用该插件 | 插件声明的工具/设置卡在 hot mount 后可用（对话里调用成功或设置页出现其配置卡） |
| TC-201-08 | 应用运行 | 卸载该插件 | `node_modules/<pkg>` 消失；profile `dependencies` 行移除；重启应用后不复活 |
| TC-201-09 | 回归 | 设置 API Key → 选 `deepseek-flash` → 建工作区 → 对话 | 对话成功返回；无因市场接入导致的启动失败 |
