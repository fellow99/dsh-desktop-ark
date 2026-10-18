# `@dsh-ohos/facts`

诊断端点 `GET /_ohos/facts`，**默认关闭**，正式构建**不可开启**（FR-105-013）。

## 形态

```js
export const name = 'facts-ohos'
export const inject = ['webServer', 'connection']
export function apply(ctx, config) { … }
```

- `config.enabled !== true` ⇒ 只打一行日志、**不注册任何路由**；bundle 行里是 `enabled: false`。
- 启用后：`ctx.effect(() => ctx.webServer.register({ kind:'exact', path:'/_ohos/facts', handler }), label)`（上游标准写法，`packages/host/open-in-app/src/index.ts:193-204`）。
- 每个请求先 `ctx.connection.requestRejection(req)`：Host/Origin 栅栏 + 浏览器认证 cookie，未通过回 401/403；非 GET 回 405。

## 返回内容

| 字段 | 说明 |
|---|---|
| `node` | `process.version`、`process.versions.modules`、platform、arch |
| `profile` | `DSH_PROFILE` / `DSH_OHOS_PROFILE`（未设置为 `null`） |
| `webServer` | 端口与 origin |
| `bundleRows` | 从 `ctx.get('loader').store` 读到的 `{id,name,disabled}`；loader 不存在时 `[]` |
| `env` | 仅 **非敏感** 的 `DSH_OHOS_*` 值 |
| `redactedEnv` | 被过滤掉的敏感 `DSH_OHOS_*` 名字（只列名字） |
| `shims` | 垫片标记：`DSH_OHOS_SHIMS`（逗号分隔）或 `globalThis.__DSH_OHOS_SHIMS__`；两者都没有时 `markers: []` + `source:'unavailable'` + 说明 |
| `capabilities` | `sandbox:'none'`、`pty:false`、`kernelIsolation:false`、附件能力、宿主桥能力清单（前 6 项 implemented / 后 8 项 placeholder） |
| `honesty` | 明确写出“绝不输出 token”和“诊断用途、发布默认关闭” |

**绝不输出 token**：只读 `DSH_OHOS_*` 前缀，且匹配 `TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL|SESSION` 的名字只出现在 `redactedEnv` 名单里，值不读取、不输出。

## 为什么垫片清单可能是空

`payload/shims/*.js` 目前只 `log('[shim] <marker> installed')`（例如 `payload/shims/sharp.js:26`），没有把标记集合发布到环境或全局。本端点按上述两个通道收集；都拿不到时如实返回 `[]` 并说明原因，不伪造清单。

## 已知限制

- `profile` 依赖环境变量；dsh 目前没有把 profile 名导出成环境变量时会是 `null`（不猜）。
- `bundleRows` 依赖 loader 的内部 `store` 结构（与 `directory-picker-auto/src/index.ts:97` 同样的读取方式）；上游改结构时会退化为 `[]`，不会崩。
- 端点本身没有额外开关（如 per-request token）；安全性完全依赖 `ctx.connection` 的认证栅栏，因此 `connection` 是硬依赖。
