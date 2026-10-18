# `@dsh-ohos/attachment-image`

**`sharp` 的 S4 替身**（模块级替换），同时导出供插件层直接使用的辅助函数。

## 与 S4 垫片的关系（重要）

- `payload/shims/sharp.js` 是探针：它在运行根下查 `node_modules/sharp/package.json`，标记 `DSH_OHOS_SHIM sharp`；**物化阶段必须把 `sharp` 这个名字指向本包**（否则探针只报告“replacement package not materialized”，附件功能会在需要时失败）。
- 上游加载方式是 `createLazyRequire<typeof sharp>('sharp', import.meta.url)`（`packages/attachment/attachment-local/src/sharp.ts:7`），即 `require('sharp')`。本包因此用 Node ≥22.12 的 `require(esm)` 互操作导出：`export { sharp as 'module.exports' }`，使 `require('sharp')` 直接得到**可调用**的工厂。
- 上游**没有注入点**（无 `ctx.images`，无 config 化 sharp 路径，报告 B.7:411-424），所以本包不是 cordis 插件，不占 bundle 行（`attachment-image-ohos` 行以 `disabled: true` 登记）。

## 兼容面

| sharp 调用点 | 本包 |
|---|---|
| `sharp(data,{failOn:'error',limitInputPixels:false}).metadata()` | 纯 JS 头解析：PNG / JPEG / GIF / WebP；返回 `format/width/height/space/channels/depth/hasAlpha/orientation/pages/hasProfile/icc/...`；截断或未知格式抛 `ImageHeaderError`（`code:'SHARP_METADATA_FAILED'`） |
| `.rotate()` | 记录 EXIF 自动定向；`rotate(角度)` 非 0 抛错（不支持任意旋转） |
| `.toColourspace('srgb')` | 只接受 `srgb`，其它抛错 |
| `.resize({width,height,fit:'inside',withoutEnlargement:true})` | 只接受 `fit:'inside'`；尺寸校验；其它 fit 抛错 |
| `.webp({quality,effort})` / `.jpeg({quality})` | 记录编码参数（quality 1..100） |
| `.toBuffer({resolveWithObject:true})` | 调宿主桥 `image.normalize`，返回 `{data:Buffer, info:{format,width,height,channels,depth,space,size}}` |
| `.clone()` | 深拷贝管线状态（上游按质量阶梯 clone） |

`metadata()` 的 orientation 5–8 会让 `orientedSize()` 交换宽高（归一化验收要求）。

## 桥协议

`invoke('image.normalize', { data:<base64>, format, quality, effort?, rotate, colourspace, width?, height?, fit, withoutEnlargement, sourceFormat })`

期望 ArkTS 返回 `{ok:true, data:<base64>, width?, height?, format?, channels?}`。当前 `image.normalize` 还是**占位**（`HostCapabilities.ets:118` 返回 `not-implemented`）⇒ 本包会抛带 `code:'host-rejected'`、`hostError:'not-implemented'` 与 `hint` 的错误；桥目录缺失则 `host-unavailable`。**任何情况都不降级为“原样返回输入”**。

## 已知限制

- 不能解码像素：ICC/EXIF 色彩转换、任意格式（TIFF/AVIF/HEIC）、任意旋转、`fit:'cover'` 等均明确报错。
- GIF 动图 `pages` 通过结构性遍历计数；WebP 动图按 `ANMF` 块计数；其余格式 `pages:1`。
- `metadata().width/height` 是**原始**（未定向）尺寸；需要定向后尺寸用 `orientedSize()`。
- 编码产物必须过上游 `normalization.ts:51-71` 的验收（单帧、8-bit、sRGB、无残留 metadata）；这依赖 ArkTS `image.normalize` 的真实实现，需真机验证。
