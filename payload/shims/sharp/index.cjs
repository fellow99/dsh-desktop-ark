'use strict';
/*
 * OHOS 垫片 S4 的**同名包入口**：把上游 `require('sharp')` 指到纯 JS 替身
 * `@dsh-ohos/attachment-image`（该包只做头解析，像素操作走宿主桥 `image.normalize`）。
 *
 * 为什么需要这一层：上游 `attachment-local` 用 `require('sharp')` 懒加载，没有注入点；
 * 唯一可行的替换就是让 `node_modules/sharp` 这个**名字**指向我们的包。
 *
 * Node ≥22.12 支持 `require()` 一个 ESM 包（同步、无 TLA）；返回的是命名空间对象，
 * 而上游要的是**可调用**的工厂 ⇒ 这里取出 default 并挂回命名导出。
 *
 * 标记：DSH_OHOS_SHIM sharp（`payload/shims/sharp.js` 用 package.json 的 dshOhosShim 判定）
 */
const impl = require('@dsh-ohos/attachment-image');
const sharp = typeof impl === 'function'
  ? impl
  : (typeof impl.default === 'function' ? impl.default : impl.sharp);

if (typeof sharp !== 'function') {
  throw new Error('OHOS sharp shim: @dsh-ohos/attachment-image 没有导出可调用的 sharp 工厂');
}

module.exports = sharp;
module.exports.default = sharp;
module.exports.sharp = sharp;
module.exports.SharpPipeline = impl.SharpPipeline;
module.exports.SHIM_MARKER = impl.SHIM_MARKER;
module.exports.BRIDGE_CAPABILITY = impl.BRIDGE_CAPABILITY;
