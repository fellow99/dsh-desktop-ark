# 109-jitless —— 任务分解（tasks）

> 依赖顺序执行；每项完成即以「证据」列的文件/命令核对。状态：`TODO` / `DOING` / `DONE`

| # | 任务 | 落点 | 证据 | 状态 |
|---|---|---|---|---|
| T-109-01 | 编译期形态常量 + 判定模块（fail-safe compat） | `entry/src/main/ets/common/{BuildConfig,NodeMode}.ets` | 代码 + `--node-mode` 脚本校验 | DONE |
| T-109-02 | 启动编排接入形态（`jitless` + 依据日志） | `entry/src/main/ets/app/DshRuntime.ets` | 真机 `hilog` / `node.log` | DONE |
| T-109-03 | 声明面：compat 默认移除 JIT 权限（两处） | `entry/src/main/module.json5` | HAP 内 `module.json` | DONE |
| T-109-04 | 形态切换脚本（幂等、可校验） | `scripts/set-node-mode.mjs` | 连续两次执行无 diff | DONE |
| T-109-05 | 构建脚本支持 `--node-mode` | `scripts/build-hap.sh` | 两次构建产物对比 | DONE |
| T-109-06 | 兼容层：http 惰性 getter 封印 + fetch 垫片（复用 + 标注） | `payload/jitless/**` | 本机 selftest | DONE |
| T-109-07 | 设备内回环自检 | `payload/jitless/selfcheck.js` | `ready.json#compat.selfcheck` | DONE |
| T-109-08 | bootstrap 接线 + host 上报 `compat` 事实 | `payload/{bootstrap,host}.js` | `app.log` / `ready.json` | DONE |
| T-109-09 | 本机双形态自检（compat 目标臂 + jit 对照臂） | `payload/jitless/selftest.mjs` | 两份日志 | DONE |
| T-109-10 | 文档更新（ACL 两份 + 规格索引） | `docs/ACL*.md`、`specs/README.md` | 文档 diff | DONE |
| T-109-11 | 代码评审（requesting → receiving）并修复 | `logs/20261020-*/REVIEW_REPORT.md` | 报告 | DONE |
| T-109-12 | 真机：compat 安装/启动/取证；jit 回归 | `logs/20261020-*/TEST_REPORT.md` | `hdc` 输出 + 截图 | DONE |
