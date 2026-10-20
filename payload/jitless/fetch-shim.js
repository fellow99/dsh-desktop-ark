/*
 * 来源：pi-desktop-ark/payload/jitless/fetch-shim.js（需求 108-jitless，已量产）
 * 本工程（109-jitless）复用该实现；仅保留「纯 JS fetch」能力面，未做行为改动。
 * 归属与维护：两工程同源；改动请同时回写两侧，避免分叉。
 */

/*
 * jitless 下的 fetch 垫片（需求 108-jitless）
 *
 * 【为什么必须自己垫】`--jitless`（OHOS 不允许 W^X 的 JIT 页）在 V8 里连带关掉了 WASM，
 * 于是 `WebAssembly === undefined`。Node 自带 undici 的 HTTP 解析器是 **WASM 版 llhttp**，
 * 所以原生 `fetch` 一连接就抛 `WebAssembly is not defined`（实测：本机 Node v24.7.0，
 * `node --jitless` 下 `fetch` 对本地 http 服务也是 `TypeError: fetch failed /
 * cause: WebAssembly is not defined`）。不垫它，宿主连模型都调不动，那不算"跑通"。
 *
 * 【为什么垫在 node:http/node:https 上】这两个模块用的是**原生** llhttp（C++），与 WASM 无关；
 * `ReadableStream` 取自 `node:stream/web`（纯 JS）；`AbortSignal`/`URL`/`TextEncoder` 都是原生。
 * 所以整条链路可以在 jitless 下工作。本文件**只**依赖这三样，绝不 import/require `undici`，
 * 也绝不触碰 `WebAssembly` 本体（除了 `typeof` 判定）。
 *
 * 【覆盖范围】POST JSON + 自定义 headers + `signal` 中止、`response.ok/status/statusText/
 * headers.get/text()/json()/body`（`body` 是**标准 ReadableStream**，SSE 要 `getReader()` 逐块读，
 * 不能整体缓冲）。另外自带 `Headers`/`Request`/`Response`/`FormData`/`Blob`/`File` 的最小实现——
 * 它们在**旧版** Node 里来自 undici、jitless 下不存在；而附件上传要用 FormData。
 *
 * 【Node 24 里这六个全局**存在**，且与 undici/WASM 无关】实测（nod 24.7.0，`--jitless`）
 * `Headers`/`Request`/`Response`/`FormData`/`Blob`/`File` 启动即可用、**不碰 WASM**，
 * 因此 `installFetchShim()` 只在 `undefined`（或读取抛错）时补 ⇒ 实际等于**一个都不补**，
 * `globalThis.FormData` 保持原生。既然如此，编码侧就**不能**只认自家的 `ShimFormData`：
 * 调用方传进来的通常是原生 FormData，只认 `instanceof` 会让体退化成
 * `Buffer.from(String(body))` = 字面量 `"[object FormData]"`（17 字节）。
 * 处置：按**能力**识别外来 FormData（`isForeignFormData`）与外来 Blob（`isBlobLike`）。
 * 同一族取舍见 `isBlobLike` 的注释（"不能只用 instanceof"）。
 *
 * 【已知取舍】① 只跟随最多 5 次重定向，且只对 303 改写成 GET（307/308 尽量重放内存体，
 * 流式体无法重放）；② 请求体支持 string/Buffer/TypedArray/FormData/Blob/ReadableStream；
 * ③ 不实现 `Response.redirect()` 之外的标准静态方法、不实现 `duplex` 校验；
 * ④ 响应体不做背压（`res` 一有数据就 enqueue，与参考实现一致），大响应体会占内存。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const { ReadableStream } = require('node:stream/web');

const LOG_PREFIX = '[jitless]';

/** 诊断输出：只走 stderr，不落盘（落盘由入口脚本负责）。 */
function warn(line) {
  try {
    console.error(`${LOG_PREFIX} ${line}`);
  } catch {
    /* 诊断本身失败绝不能影响主流程 */
  }
}

// ── Headers ────────────────────────────────────────────────────────────────
class ShimHeaders {
  constructor(init) {
    this._map = new Map();
    if (init === undefined || init === null) return;
    if (init instanceof ShimHeaders) {
      init.forEach((value, name) => this.append(name, value));
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        if (Array.isArray(pair) && pair.length >= 2) this.append(pair[0], pair[1]);
      }
    } else if (typeof init.forEach === 'function' && typeof init.entries === 'function') {
      /*
       * 原生 Headers / Map：**数据不在自有可枚举属性上**，必须按迭代器取。
       *
       * 【为什么必须单独开这一支（真机 401 AUTH 的根因）】早先只有
       * 「instanceof / Array.isArray / typeof === 'object'」三支，原生 Headers 落到最后那支
       * → `Object.keys(nativeHeaders)` 返回 **[]** → 一个请求头都不发 → 提供方回 401
       * （"缺 key"）。而同一把 key 用 curl 打同一 URL 是 200 —— 症状完全对得上
       * "桌面端能通、端侧全挂"。调用方（三家 SDK）传进来的正是**原生 Headers**。
       *
       * 【判据用能力而非类名】同时判断 forEach + entries，Map/Headers/URLSearchParams
       * 都覆盖到；不用 `instanceof Headers`——globalThis.Headers 可能已被替换，
       * 那样反而认不出原生那个。
       */
      for (const [name, value] of init.entries()) this.append(name, value);
      /*
       * 【原生 Headers 的 set-cookie 特例】标准 Headers.entries() 会把多个 set-cookie
       * 合并成一条，而 append(name, merged) 会把一个值当整体塞进去。对请求头无影响；
       * 响应侧我们另走 rawHeaders 逐条 append（见 onceFetch），所以这里不特殊处理。
       */
    } else if (typeof init === 'object') {
      for (const name of Object.keys(init)) {
        if (init[name] !== undefined) this.append(name, init[name]);
      }
    }
  }

  append(name, value) {
    const key = String(name).toLowerCase();
    const cur = this._map.get(key);
    if (cur === undefined) this._map.set(key, { name: String(name), values: [String(value)] });
    else cur.values.push(String(value));
  }

  set(name, value) {
    this._map.set(String(name).toLowerCase(), { name: String(name), values: [String(value)] });
  }

  get(name) {
    const cur = this._map.get(String(name).toLowerCase());
    return cur === undefined ? null : cur.values.join(', ');
  }

  has(name) { return this._map.has(String(name).toLowerCase()); }

  delete(name) { this._map.delete(String(name).toLowerCase()); }

  /** 逐条原值（不合并），重定向时要按原名剔除"体相关"的头。 */
  raw() { return Array.from(this._map.values()).map((cur) => [cur.name, cur.values.slice()]); }

  clone() {
    const out = new ShimHeaders();
    for (const [name, values] of this.raw()) for (const value of values) out.append(name, value);
    return out;
  }

  forEach(cb, thisArg) {
    for (const cur of this._map.values()) cb.call(thisArg, cur.values.join(', '), cur.name, this);
  }

  entries() { return Array.from(this._map.values()).map((c) => [c.name, c.values.join(', ')]); }
  keys() { return this.entries().map(([k]) => k); }
  values() { return this.entries().map(([, v]) => v); }
  [Symbol.iterator]() { return this.entries()[Symbol.iterator](); }
}

// ── Blob / File / FormData ────────────────────────────────────────────────
class ShimBlob {
  constructor(parts = [], options = {}) {
    this._parts = Array.isArray(parts) ? parts : [parts];
    this.type = options.type === undefined ? '' : String(options.type);
    let size = 0;
    for (const part of this._parts) {
      if (typeof part === 'string') size += Buffer.byteLength(part);
      else if (Buffer.isBuffer(part)) size += part.length;
      else if (part instanceof ArrayBuffer) size += part.byteLength;
      else if (ArrayBuffer.isView(part)) size += part.byteLength;
      else if (part instanceof ShimBlob) size += part.size;
      else size += Buffer.byteLength(String(part));
    }
    this.size = size;
  }

  _buffer() {
    const out = [];
    for (const part of this._parts) {
      if (typeof part === 'string') out.push(Buffer.from(part, 'utf8'));
      else if (Buffer.isBuffer(part)) out.push(part);
      else if (part instanceof ArrayBuffer) out.push(Buffer.from(part));
      else if (ArrayBuffer.isView(part)) out.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      else if (part instanceof ShimBlob) out.push(part._buffer());
      else out.push(Buffer.from(String(part), 'utf8'));
    }
    return Buffer.concat(out);
  }

  async arrayBuffer() {
    const b = this._buffer();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async text() { return this._buffer().toString('utf8'); }
  async bytes() { return new Uint8Array(this._buffer()); }
  slice(start, end, type) {
    return new ShimBlob([this._buffer().subarray(start, end)], { type: type === undefined ? this.type : type });
  }
}

class ShimFile extends ShimBlob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = String(name);
    this.lastModified = options.lastModified === undefined ? Date.now() : options.lastModified;
  }
}

/**
 * 生成一个 multipart/form-data 的 boundary。
 *
 * 【为什么要单独抽出来】响应方向必须**先**定 content-type、**后**编体：多部分边界就写在
 * content-type 里 ⇒ 边界只能由构造响应的一方生成、再传给编码器。请求方向仍自生成，行为不变。
 */
function makeMultipartBoundary() {
  return `----pijitless${Date.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}`;
}

class ShimFormData {
  constructor() { this._entries = []; }

  append(name, value, filename) { this._entries.push({ name: String(name), value, filename }); }

  set(name, value, filename) {
    this.delete(name);
    this._entries.push({ name: String(name), value, filename });
  }

  delete(name) { this._entries = this._entries.filter((e) => e.name !== String(name)); }
  get(name) { const e = this._entries.find((x) => x.name === String(name)); return e === undefined ? null : e.value; }
  // 【为什么单列注释】这里曾写成 `filter((e) => x.name === …)`：`x` 是上一行 get() 的箭头参数、
  // 不在本作用域 ⇒ 一旦垫片的 FormData 被真正接管，第一次 getAll 就 ReferenceError。
  // selftest 用的是原生 FormData，测不到这条；故改为直接取 e，并补了垫片 FormData 的用例。
  getAll(name) { return this._entries.filter((e) => e.name === String(name)).map((e) => e.value); }
  has(name) { return this._entries.some((e) => e.name === String(name)); }
  forEach(cb, thisArg) { for (const e of this._entries) cb.call(thisArg, e.value, e.name, this); }
  entries() { return this._entries.map((e) => [e.name, e.value]); }
  keys() { return this._entries.map((e) => e.name); }
  values() { return this._entries.map((e) => e.value); }
  [Symbol.iterator]() { return this.entries()[Symbol.iterator](); }

  /**
   * 编成 multipart/form-data 的字节流 + boundary（够附件上传用）。
   * 异步：原生 Blob 取字节只能异步（见 `blobBytes`）。
   * `boundary` 可由调用方给定（响应方向要求 content-type 先于体确定）。
   */
  async _encode(boundary = makeMultipartBoundary()) {
    const chunks = [];
    const crlf = Buffer.from('\r\n');
    for (const entry of this._entries) {
      const value = entry.value;
      const filename = entry.filename === undefined
        ? (value instanceof ShimFile ? value.name
          : (typeof value === 'object' && value !== null && typeof value.name === 'string' ? value.name : undefined))
        : entry.filename;
      const isFile = entry.filename !== undefined || isBlobLike(value);
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${entry.name}"`;
      if (isFile) head += `; filename="${filename === undefined ? 'blob' : filename}"`;
      head += '\r\n';
      if (isFile) {
        const type = typeof value === 'object' && value !== null && typeof value.type === 'string' && value.type !== ''
          ? value.type
          : 'application/octet-stream';
        head += `Content-Type: ${type}\r\n`;
      }
      chunks.push(Buffer.from(head, 'utf8'), crlf);
      chunks.push(isFile ? await blobBytes(value) : Buffer.from(String(value), 'utf8'));
      chunks.push(crlf);
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { data: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}`, stream: null };
  }
}

/**
 * 像 Blob 就行（**不能只用 instanceof**：Node 原生就有 `Blob`/`File`，来自 `node:buffer`，
 * 它们与 undici 无关，因此在"关掉原生 fetch"的配置下依然存在，调用方可能直接把原生 Blob
 * 传进来；在 Node 24 上更是**启动即存在**）。判据：`arrayBuffer()` + 数值 `size`。
 */
function isBlobLike(value) {
  return value !== null && typeof value === 'object'
    && typeof value.arrayBuffer === 'function' && typeof value.size === 'number';
}

/** 取 Blob 的字节：自家实现是同步的；原生 Blob 只能异步取。 */
async function blobBytes(value) {
  if (value instanceof ShimBlob) return value._buffer();
  return Buffer.from(await value.arrayBuffer());
}

/**
 * 是不是**外来的** FormData（Node 原生那个）。
 *
 * 【为什么必须按能力判、不能只靠 instanceof】Node 24 启动就自带 `FormData`，
 * `installFetchShim()` 不会（也不该）替换它 ⇒ 调用方传进来的 FormData **通常就是原生实例**。
 * 只认 `instanceof ShimFormData` ⇒ 整条 multipart 编码被跳过 ⇒ 体变成 `"[object FormData]"`。
 *
 * 【为什么还要 `Object.prototype.toString` 这一条】只判 `append`+`entries` 会把
 * `URLSearchParams` 也认成 FormData（它也有这两个，且 `String()` 是查询串）。用
 * `Symbol.toStringTag` 精确到 `[object FormData]`，既认原生 FormData，又不误收 URLSearchParams。
 */
function isForeignFormData(value) {
  return value !== null && typeof value === 'object'
    && !(value instanceof ShimFormData)
    && typeof value.append === 'function'
    && typeof value.entries === 'function'
    && Object.prototype.toString.call(value) === '[object FormData]';
}

/** 把外来 FormData 的条目搬进自家实现再编码——复用 `_encode()`，不复制一份 multipart 逻辑。 */
async function encodeForeignFormData(form, boundary) {
  const copy = new ShimFormData();
  for (const [name, value] of form.entries()) copy.append(name, value);
  return await copy._encode(boundary);
}

/**
 * 是不是 FormData——**自家的与原生的一并算**。
 *
 * 【为什么还要 `instanceof ShimFormData` 这一条】`isForeignFormData` 靠
 * `Object.prototype.toString.call(value) === '[object FormData]'` 精确识别原生实例；
 * 而 `ShimFormData` **没有** `Symbol.toStringTag`，它的 `Object.prototype.toString`
 * 是 `[object Object]` ⇒ 只认后者会把自家的漏掉。
 */
function isFormDataLike(value) {
  return value instanceof ShimFormData || isForeignFormData(value);
}

/** 把任意 FormData（自家 / 原生）编成 multipart 字节，**用调用方给定的 boundary**。 */
async function encodeFormDataBody(form, boundary) {
  return form instanceof ShimFormData
    ? await form._encode(boundary)
    : await encodeForeignFormData(form, boundary);
}

/**
 * 把一个**可能异步**的字节来源包成 ReadableStream。
 *
 * 【为什么不能同步取】原生 `Blob` 只能 `await arrayBuffer()`，而 ReadableStream 的 `start`
 * 可以是 async ⇒ 让流"等字节"，构造本身仍然是同步的（`new Response(...)` 就是同步签名）。
 */
function byteStreamFrom(load) {
  return new ReadableStream({
    async start(controller) {
      try {
        const data = await load();
        if (data.length > 0) controller.enqueue(new Uint8Array(data));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

// ── 请求体编码（异步：原生 Blob 的字节只能异步取）───────────────────────────
/**
 * 三类请求体的判据（与参考实现同一把尺子）：
 *   ① 已知字节数（string / Buffer / TypedArray / ArrayBuffer / FormData / Blob）⇒ `data`，
 *      调用方**必须**据此显式给 content-length（见 shimFetch 的注释：chunked POST 会被 WAF 412）；
 *   ② 流（有 `getReader`）⇒ `stream`，长度未知，只能 chunked；
 *   ③ 其它一律按 UTF-8 文本（保守，不静默丢体）。
 */
async function encodeRequestBody(body) {
  if (body === undefined || body === null) return { data: null, type: null, stream: null };
  if (typeof body === 'string') return { data: Buffer.from(body, 'utf8'), type: 'text/plain;charset=UTF-8', stream: null };
  if (Buffer.isBuffer(body)) return { data: body, type: null, stream: null };
  if (body instanceof ArrayBuffer) return { data: Buffer.from(body), type: null, stream: null };
  if (ArrayBuffer.isView(body)) return { data: Buffer.from(body.buffer, body.byteOffset, body.byteLength), type: null, stream: null };
  if (body instanceof ShimFormData) return await body._encode();
  /* 【原生 FormData 也要编】见 `isForeignFormData` 的注释。 */
  if (isForeignFormData(body)) return await encodeForeignFormData(body);
  if (isBlobLike(body)) return { data: await blobBytes(body), type: body.type === '' ? null : (body.type || null), stream: null };
  if (typeof body.getReader === 'function') return { data: null, type: null, stream: body };
  return { data: Buffer.from(String(body), 'utf8'), type: null, stream: null };
}

// ── Response ──────────────────────────────────────────────────────────────
class ShimResponse {
  constructor(body, init = {}) {
    /*
     * 【必须是标准 Fetch 签名 `new Response(body, init)`】上层代码到处这样构造响应
     * （`new Response("not found", { status: 404 })` 等）。写成非标准的 `(stream, init)`
     * 且 `headers = init.headers`（常为 undefined）时，调用方执行
     * `Object.fromEntries(response.headers.entries())` 会**抛 TypeError**，
     * 被 catch-all 兜成空体 400 —— 表现就是"任何请求都是 400 空体"。
     */
    this.status = init.status === undefined ? 200 : init.status;
    this.statusText = init.statusText === undefined ? '' : init.statusText;
    this.headers = init.headers instanceof ShimHeaders ? init.headers : new ShimHeaders(init.headers);
    this.url = init.url === undefined ? '' : init.url;
    this.ok = this.status >= 200 && this.status <= 299;
    this.bodyUsed = false;
    this.redirected = init.redirected === undefined ? false : init.redirected === true;
    this.type = 'default';

    if (body === undefined || body === null) {
      // 空体：`_buffer` 置为长度 0 的 Buffer（与"未缓冲、需读流"区分开）
      this._buffer = Buffer.alloc(0);
      this.body = null;
    } else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof ShimBlob) {
      this._buffer = typeof body === 'string' ? Buffer.from(body, 'utf8')
        : (Buffer.isBuffer(body) ? body : body._buffer());
      const bytes = this._buffer;
      this.body = new ReadableStream({
        start(controller) {
          if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    } else if (isFormDataLike(body)) {
      /*
       * 【体是 FormData 时也必须编成 multipart 字节流】
       *
       * 上层可能用 FormData 回二进制结果（`new Response(formData)`）。旧实现只认
       * string/Buffer/Blob/"已是 ReadableStream"，FormData 落到兜底分支 ⇒
       * `this.body = <FormData>` 且 headers 为空。随后服务端桥层 `for await (chunk of body)`
       * 拿到的是 `Symbol.iterator` 产出的 `["name", Blob]` **数组** ⇒ `res.write(数组)` 抛
       * `ERR_INVALID_ARG_TYPE` ⇒ 连接被 `destroy()`（一个字节都没 flush）⇒ 前端只看到
       * "Failed to fetch"。
       *
       * 标准语义：编成 multipart 字节流，并把带 boundary 的 content-type 一并给出
       * （客户端正是按它分流到 `response.formData()`）。
       */
      const boundary = makeMultipartBoundary();
      if (!this.headers.has('content-type')) {
        this.headers.set('content-type', `multipart/form-data; boundary=${boundary}`);
      }
      this._buffer = null;
      this.body = byteStreamFrom(async () => (await encodeFormDataBody(body, boundary)).data);
    } else if (isBlobLike(body)) {
      /* 同一族缺陷：`new Response(blob)` 旧实现也落到兜底 ⇒ 桥层 `res.write()` 炸。
       * 标准语义：体是 Blob 的字节，content-type 取 `blob.type`（为空则不带）。 */
      if (typeof body.type === 'string' && body.type !== '' && !this.headers.has('content-type')) {
        this.headers.set('content-type', body.type);
      }
      this._buffer = null;
      this.body = byteStreamFrom(() => blobBytes(body));
    } else if (typeof body.getReader === 'function') {
      // 已是 ReadableStream（我们自己的 fetch 走这条）
      this._buffer = null;
      this.body = body;
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      /*
       * 【BufferSource 体（ArrayBuffer / TypedArray / DataView）也要按**字节**走】
       * 请求方向早就认这两种，响应方向原先是兜底 ⇒ 被 `Buffer.from(String(body))` 变成
       * `"137,80,78,71,…"` 这种**十进制文本**：200 OK、体是错的（比连接被断更难查）。
       * 标准 Fetch 的语义就是"BufferSource 体 = 它的字节"。
       */
      this._buffer = body instanceof ArrayBuffer
        ? Buffer.from(body)
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      const bytes = this._buffer;
      this.body = new ReadableStream({
        start(controller) {
          if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    } else {
      /*
       * 【兜底：既不认形态、就**大声失败**，绝不悄悄换内容】
       * 把未识别的 body 原样交给 `this.body`，故障会被推迟到桥层（`res.write()` 抛
       * `ERR_INVALID_ARG_TYPE` ⇒ 连接被断、响应空体）；而"退化为 UTF-8 文本"会让
       * ArrayBuffer/TypedArray 静默变成十进制文本（200 OK + 错内容）。
       * 标准 Fetch 对非法 BodyInit 的做法是**构造时抛 TypeError** ——就照它办。
       */
      throw new TypeError(
        `fetch 垫片：不支持的 Response body 类型 —— ${Object.prototype.toString.call(body)}`
        + '（支持 string / Buffer / ArrayBuffer / TypedArray / Blob / FormData / ReadableStream）',
      );
    }
  }

  /** 读全文并缓存：`text()/json()/arrayBuffer()` 共享同一份，符合 bodyUsed 语义。 */
  async _readAll() {
    if (this._buffer !== null) return this._buffer;
    if (this.body === null) return Buffer.alloc(0);
    const reader = this.body.getReader();
    const chunks = [];
    for (;;) {
      const step = await reader.read();
      if (step.done === true) break;
      chunks.push(Buffer.from(step.value));
    }
    this.bodyUsed = true;
    this._buffer = Buffer.concat(chunks);
    return this._buffer;
  }

  async text() { return (await this._readAll()).toString('utf8'); }

  async arrayBuffer() {
    const b = await this._readAll();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }

  async json() { return JSON.parse(await this.text()); }

  async blob() { return new ShimBlob([await this._readAll()], { type: this.headers.get('content-type') || '' }); }

  clone() { throw new Error('fetch 垫片：Response.clone() 未实现'); }

  /*
   * 【静态构造器】上层代码用标准 Fetch 的静态方法构造响应：
   * `Response.json(data, init)` / `Response.redirect(url, 302)`。
   * 缺它们时的症状是 **HTTP 500 + `TypeError: Response.json is not a function`**。
   */
  static json(data, init = {}) {
    const headers = init.headers instanceof ShimHeaders ? init.headers : new ShimHeaders(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new ShimResponse(JSON.stringify(data), Object.assign({}, init, { headers }));
  }

  static redirect(url, status = 302) {
    return new ShimResponse(null, { status, headers: new ShimHeaders({ location: String(url) }) });
  }

  static error() {
    return new ShimResponse(null, { status: 0, statusText: '' });
  }
}

// ── Request ───────────────────────────────────────────────────────────────
/**
 * 最小的 `Request` 实现。
 *
 * 【为什么必须有它】上层会把请求包成标准 `Request` 再交给服务器桥：
 *   `new Request(url, { method, headers, body: Buffer.concat(chunks), signal })`
 * 而 `globalThis.Request` 在旧 Node（或某些裁剪构建）里**不存在** ⇒ `new Request(...)` 抛
 * `ReferenceError` ⇒ 被 catch-all 兜成**空体 400**（GET 正常、所有 POST 全 400）。
 *
 * 【`body` 要保住流】流式路由会构造 `new Request(url, { body: Readable.toWeb(req),
 * duplex: 'half' })`，处理器随后 `request.body.getReader()`。把流式体吞成 `_body = null`
 * 且不设 `body` 属性 ⇒ 处理器拿到 `undefined` ⇒ `undefined.getReader()` 抛 TypeError
 * ⇒ 上传静默失败。故流式体原样交给 `this.body`。
 */
class ShimRequest {
  constructor(input, init = {}) {
    this.url = typeof input === 'string' ? input
      : (input instanceof URL ? input.href
        : (input !== null && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input)));
    this.method = init.method === undefined ? 'GET' : String(init.method).toUpperCase();
    this.headers = init.headers instanceof ShimHeaders ? init.headers : new ShimHeaders(init.headers);
    this.signal = init.signal === undefined ? null : init.signal;
    this.bodyUsed = false;
    this.redirect = init.redirect === undefined ? 'follow' : String(init.redirect);
    const raw = init.body;
    this._stream = null;
    if (raw === undefined || raw === null) this._body = null;
    else if (Buffer.isBuffer(raw)) this._body = raw;
    else if (typeof raw === 'string') this._body = Buffer.from(raw, 'utf8');
    else if (raw instanceof ArrayBuffer) this._body = Buffer.from(raw);
    else if (ArrayBuffer.isView(raw)) this._body = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    /* 判据与 `encodeRequestBody` 同一把尺子（鸭子类型），别用 `instanceof ReadableStream`：
     * 调用方给的是 `Readable.toWeb(nodeStream)`，跨实现 `instanceof` 会漏判。 */
    else if (typeof raw.getReader === 'function') {
      this._body = null;
      this._stream = raw;
    } else this._body = null;
    /* 【`body === null` 而不是 `undefined`】原生 Fetch 对"没有体"的请求给的就是 `null`，
     * 而调用方的早退判据正是 `body === null`；给 `undefined` 会掉进 `undefined.getReader()`。 */
    this.body = this._stream;
  }

  async text() {
    this.bodyUsed = true;
    return this._body === null ? '' : this._body.toString('utf8');
  }

  async json() { return JSON.parse(await this.text()); }

  async arrayBuffer() {
    const b = this._body === null ? Buffer.alloc(0) : this._body;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}

// ── fetch ─────────────────────────────────────────────────────────────────
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** 造一个 `name === 'AbortError'` 的错误（要求明确：中止错误必须是这个 name）。 */
function abortError(signal) {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  try {
    if (signal !== undefined && signal !== null && signal.reason !== undefined) error.cause = signal.reason;
  } catch {
    /* reason 取不到就算了 */
  }
  return error;
}

/** 重定向后体被丢掉时，必须同时剔掉体相关的头（否则 content-length 会让服务端等字节）。 */
function stripBodyHeaders(headers) {
  const out = headers.clone();
  out.delete('content-length');
  out.delete('content-type');
  out.delete('transfer-encoding');
  return out;
}

/**
 * 发一次请求（重定向靠递归调用它）。
 *
 * @param {string} url 目标地址
 * @param {{method?: string}} init 只看 method（体已编进 `encoded`）
 * @param {ShimHeaders} headers
 * @param {{data: Buffer|null, type: string|null, stream: ReadableStream|null}|null} encoded
 * @param {AbortSignal|undefined|null} signal
 * @param {number} redirectsLeft 还能跟几跳
 * @param {boolean} redirected 是否已经跟过跳（写进 Response.redirected）
 * @param {'follow'|'manual'|'error'} mode 重定向模式
 */
/**
 * 把 URL 脱敏后用于**日志/错误消息**：只留 origin + pathname（去 query/hash，截断过长部分）。
 *
 * 为什么需要它：`Invalid URL` 这类错误会被上游原样写进 app.log / node.log，
 * 而模型 API 的 URL 常把密钥放在 query（`?api_key=…`）⇒ 原文落盘即泄露。
 */
function describeUrlForLog(url) {
  const text = String(url);
  try {
    const parsed = new URL(text);
    const path = parsed.pathname === '' ? '/' : parsed.pathname;
    const compact = `${parsed.protocol}//${parsed.host}${path}`;
    return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact;
  } catch {
    // 连 URL 都解析不了：只留前 32 字符，且截断掉可能存在的 `?`
    const cut = text.indexOf('?');
    const head = cut === -1 ? text : text.slice(0, cut);
    return head.length > 32 ? `${head.slice(0, 32)}…` : head;
  }
}

function onceFetch(url, init, headers, encoded, signal, redirectsLeft, redirected, mode) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      // 【为什么不含 url 原文】URL 常带 `?api_key=…`，而这条错误会被上层写进 app.log / node.log
      // ⇒ 日志泄露密钥。只报协议与前 120 字符的 origin+pathname，足够定位又不会带凭据。
      reject(new TypeError(`Invalid URL: ${describeUrlForLog(url)}`));
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new TypeError(`fetch 垫片只支持 http/https，收到 ${parsed.protocol}`));
      return;
    }
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      reject(abortError(signal));
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const method = init.method === undefined ? 'GET' : String(init.method).toUpperCase();
    /*
     * 【为什么不用 `Object.fromEntries(headers.entries())`】同名字多值头（`cookie`/`accept`/
     * `x-forwarded-for` 这类）会被后一个覆盖前一个 —— 请求头静默丢一半，症状是服务端 401/400
     * 且极难归因（dshm 真实事故同源）。这里按同名聚成数组交给 node:http，它会逐条发出。
     */
    const nodeHeaders = {};
    for (const [name, value] of headers.entries()) {
      const key = String(name);
      if (nodeHeaders[key] === undefined) nodeHeaders[key] = value;
      else if (Array.isArray(nodeHeaders[key])) nodeHeaders[key].push(value);
      else nodeHeaders[key] = [nodeHeaders[key], value];
    }
    const options = {
      method,
      headers: nodeHeaders,
    };
    let req = null;
    /* 响应流的 controller：中止/对端提前断开时要靠它把错误送进读端（见下面的流定义）。 */
    let responseController = null;
    let settled = false;
    let onAbort = () => {};

    /*
     * 【只有在 reject 时才摘掉 abort 监听】早先的写法是"只要 settle 就摘"，
     * 结果响应一到就把监听摘了 ⇒ 调用方后续 `abort()` 完全无效、`body.getReader().read()`
     * 永远挂住（实测踩到）。正确语义：请求失败即摘；请求成功则保留到**响应体结束**为止
     * （读体阶段中止靠它）。
     */
    const detach = () => {
      if (signal === undefined || signal === null || typeof signal.removeEventListener !== 'function') return;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* 忽略 */
      }
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (fn === reject) detach();
      fn(value);
    };

    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      /*
       * 【中止必须 destroy socket，并且把错误送进**已返回的响应流**】只 reject 的话，
       * ① 连接会挂在服务端（长连接的 SSE 把进程拖住，`process` 永远不退出）；
       * ② 如果调用方已经拿到 response 正在 `body.getReader()`，读端会**永远挂住**
       *    —— 实测 Node 24 上 `req.destroy(err)` 不会在 response 上补发 'error'/'aborted'，
       *    只有 'close'。所以这里显式 `controller.error(...)`（abort 与 close 两条路径都兜）。
       */
      onAbort = () => {
        const error = abortError(signal);
        if (req !== null && typeof req.destroy === 'function') req.destroy(error);
        if (responseController !== null) {
          try {
            responseController.error(error);
          } catch {
            /* 流已关闭：忽略 */
          }
        }
        settle(reject, error);
      };
      try {
        signal.addEventListener('abort', onAbort, { once: true });
      } catch {
        /* 忽略：拿不到 AbortSignal 语义时退化为"不能中止"，但不影响请求本身 */
      }
    }

    const follow = (status, resHeaders, location) => {
      const nextUrl = new URL(location, parsed).toString();
      const nextInit = { method };
      /*
       * 体改写规则（对齐 Fetch 标准，也是原生 fetch 的实际行为）：
       *   · 303 ⇒ 一律改写成 GET 并丢体（表单提交后的通用形态）；
       *   · 301 / 302 **且原方法是 POST** ⇒ 同样改写成 GET 并丢体。
       *     为什么这条要单独做：尾斜杠跳转（`/api/x` → `/api/x/`）在 Next 里极常见，
       *     不改写就会把同一个 POST 体重发一次 —— 服务端可能**重复写入**，
       *     而日志上看起来只是"多了一次请求"。
       */
      let nextEncoded = encoded;
      let nextHeaders = headers;
      const rewriteToGet = method !== 'HEAD'
        && (status === 303 || ((status === 301 || status === 302) && method === 'POST'));
      if (rewriteToGet) {
        nextInit.method = 'GET';
        nextEncoded = null;
        nextHeaders = stripBodyHeaders(headers);
      } else if (nextEncoded !== null && nextEncoded !== undefined && nextEncoded.stream !== null) {
        /* 流式体不能重放（已经被消费）⇒ 丢掉体，同时剔掉体相关的头。 */
        nextEncoded = null;
        nextHeaders = stripBodyHeaders(headers);
      } else if (nextEncoded === null || nextEncoded === undefined || nextEncoded.data === null) {
        nextHeaders = stripBodyHeaders(headers);
      }
      /* 307/308 且体在内存里 ⇒ 原样重放（`data` 是 Buffer，可重复写）。
       * 先摘掉本跳的 abort 监听：下一跳的 `onceFetch` 会自己注册一个（留着会多一层悬挂监听）。 */
      detach();
      settle(resolve, onceFetch(nextUrl, nextInit, nextHeaders, nextEncoded, signal, redirectsLeft - 1, true, mode));
    };

    /*
     * `redirect: 'error'`：见到 3xx 直接 reject（调用方拿它当"不许跳"的断言用）。
     * 放在跟跳之前判，才不会被 `redirectsLeft` 的取值顺序绕过去。
     */
    const rejectRedirect = () => {
      const error = new TypeError('fetch failed: redirect not allowed (redirect: "error")');
      error.code = 'ERR_REDIRECT_NOT_ALLOWED';
      settle(reject, error);
    };

    try {
      req = mod.request(parsed, options, (res) => {
        const status = res.statusCode === undefined ? 0 : res.statusCode;
        const resHeaders = new ShimHeaders();
        /* 【逐条 append，不走 Object.fromEntries(res.headers)】后者会把多个 set-cookie
         * 合并成一条，也会丢掉同名头的顺序。 */
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          resHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        }
        if (REDIRECT_STATUS.has(status) && mode === 'error') {
          res.resume();
          rejectRedirect();
          return;
        }
        const location = resHeaders.get('location');
        if (REDIRECT_STATUS.has(status) && mode === 'follow' && location !== null && location !== '') {
          if (redirectsLeft <= 0) {
            /*
             * 跳数用尽 ⇒ **必须抛错**，不能把最后一个 3xx 当正常响应返回：
             * 上一版就是这么做的，结果是重定向环被上层当成"200 空体"，
             * 报出来的错是"JSON 解析失败"，根因完全看不见（原生 fetch 抛的是
             * `TypeError: redirect count exceeded`，这里对齐）。
             */
            res.resume();
            const error = new TypeError('fetch failed: redirect count exceeded（上限 ' + MAX_REDIRECTS + ' 跳）');
            error.code = 'ERR_REDIRECT_COUNT_EXCEEDED';
            settle(reject, error);
            return;
          }
          res.resume();
          follow(status, resHeaders, location);
          return;
        }
        /*
         * 【响应体必须是标准 ReadableStream】SSE 用 `body.getReader()` 逐块读，
         * 不能整体缓冲（否则流式输出要等全部结束才出现，等于没有流式）。
         * 不做背压：`res` 一有数据就 enqueue（与参考实现一致，见文件头已知取舍 ④）。
         */
        const stream = new ReadableStream({
          start(controller) {
            responseController = controller;
            res.on('data', (chunk) => {
              try {
                controller.enqueue(new Uint8Array(chunk));
              } catch {
                /* 流已被 cancel：忽略后续 chunk */
              }
            });
            res.on('end', () => {
              detach();
              try {
                controller.close();
              } catch {
                /* 已关闭（例如被 cancel）时忽略 */
              }
            });
            res.on('error', (error) => {
              try {
                controller.error(error);
              } catch {
                /* 忽略 */
              }
            });
            /*
             * 【`close` 这一个分支是必需的，不是保险】实测 Node 24：请求被 `destroy(err)` 之后，
             * response 上**不会**补发 'error'/'aborted'，只有 'close'。不在这里把错误送进
             * 读端，`body.getReader().read()` 会永远挂住（真机上就是"中止之后进程不退出"）。
             * `res.complete === false` 表示报文没收完（提前断开）。
             */
            res.on('close', () => {
              detach();
              if (res.complete === false) {
                try {
                  controller.error(new Error('响应流被中断（对端或中止导致的提前关闭）'));
                } catch {
                  /* 已关闭：忽略 */
                }
              }
            });
          },
          cancel() {
            detach();
            responseController = null;
            try {
              res.destroy();
            } catch {
              /* 忽略 */
            }
          },
        });
        settle(resolve, new ShimResponse(stream, {
          status,
          statusText: res.statusMessage === undefined ? '' : res.statusMessage,
          headers: resHeaders,
          url: parsed.toString(),
          redirected,
        }));
      });
    } catch (error) {
      settle(reject, error);
      return;
    }

    req.on('error', (error) => settle(reject, error));

    /*
     * 【流式体的 `end()` 只能由泵在读到 done 时调用】早先这里无条件 `req.end()`：
     * `pump()` 是异步的，紧接着的 `end()` 会先把请求关掉 ⇒ 后续 `req.write()` 抛
     * `ERR_STREAM_WRITE_AFTER_END`（自检 `post-stream-body` 抓到的就是这一条）。
     */
    if (encoded !== null && encoded !== undefined && encoded.stream !== null && encoded.stream !== undefined) {
      const reader = encoded.stream.getReader();
      const pump = () => reader.read().then((step) => {
        if (step.done === true) {
          req.end();
          return;
        }
        req.write(Buffer.from(step.value), pump);
      }, (error) => req.destroy(error));
      pump();
    } else {
      if (encoded !== null && encoded !== undefined && encoded.data !== null) req.write(encoded.data);
      req.end();
    }
  });
}

/**
 * `fetch` 的最小可用实现。
 *
 * @param {string|URL|{url: string}} input
 * @param {{method?: string, headers?: any, body?: any, signal?: AbortSignal, redirect?: string}} [init]
 */
async function shimFetch(input, init = {}) {
  /*
   * Request 形态：把它的 method/headers/body/signal 展开成 init，再按字符串 URL 走。
   *
   * 【为什么必须做】原实现对 Request 只取 `.url`，于是
   * `fetch(new Request(url, {method:'POST', headers, body}))` 会退化成**无头无体的 GET**
   * —— 比"丢头"更严重：method 与 body 一起没了。
   *
   * 【取值优先级】显式 init 覆盖 Request 自带值（与标准 fetch 一致）。
   */
  if (input !== null && typeof input === 'object' && !(input instanceof URL)
    && typeof input.url === 'string' && typeof input.method === 'string') {
    const req = input;
    let reqBody = init.body;
    if (init.body === undefined && typeof req.text === 'function') {
      // Request 的 body 是一次性流：这里读成文本；读不到就当无 body（保守）
      try {
        const txt = await req.text();
        reqBody = txt.length > 0 ? txt : undefined;
      } catch {
        reqBody = undefined;
      }
    }
    init = {
      method: init.method === undefined ? req.method : init.method,
      headers: init.headers === undefined ? req.headers : init.headers,
      signal: init.signal === undefined ? req.signal : init.signal,
      redirect: init.redirect === undefined ? req.redirect : init.redirect,
      body: reqBody,
    };
    input = req.url;
  }

  const url = typeof input === 'string' ? input
    : (input instanceof URL ? input.href
      : (input !== null && typeof input === 'object' && typeof input.url === 'string' ? input.url : String(input)));

  const headers = new ShimHeaders(init.headers);
  const encoded = await encodeRequestBody(init.body);
  if (encoded.type !== null && !headers.has('content-type')) headers.set('content-type', encoded.type);

  /*
   * 已知长度的 body 必须**显式**给 Content-Length。
   *
   * 【真机 412 的根因】只 `req.write(data); req.end();` 时 node 会改用
   * `Transfer-Encoding: chunked`，而部分网关的前置 WAF 直接拒 chunked POST，返回 412 空体
   * （设备上复现：带 `Transfer-Encoding: chunked` → 412；去掉 → 200）。
   *
   * 【为什么 delete transfer-encoding】调用方可能自己传了，同时又给 content-length
   * 会构成冲突头，两种传输语义并存必被拒。
   *
   * 【长度用 `encoded.data.length`（字节数）】不是字符数 —— 中文 body 两者不等。
   *
   * 【流式 body 不设】长度未知，保持 chunked 是唯一正确选择。
   */
  if (encoded.data !== null && encoded.data !== undefined) {
    headers.delete('transfer-encoding');
    if (!headers.has('content-length')) headers.set('content-length', String(encoded.data.length));
  }

  /*
   * `redirect` 模式必须被尊重：
   *   · `manual` —— 不跟跳，把 3xx 原样返回（调用方可能要在同源白名单内自己逐跳跟进）；
   *   · `error`  —— 见到 3xx 就 reject；
   *   · 默认 `follow` —— 最多 5 跳。
   * 否则垫片擅自跟跳会绕过调用方自己的安全策略。
   */
  const mode = init.redirect === undefined ? 'follow' : String(init.redirect);
  const redirectsLeft = mode === 'manual' || mode === 'error' ? 0 : MAX_REDIRECTS;
  return await onceFetch(url, { method: init.method }, headers, encoded, init.signal, redirectsLeft, false, mode);
}

// ── 全局安装 ──────────────────────────────────────────────────────────────
/**
 * 把一个全局接口**确实**换成垫片实现。
 *
 * 【为什么不能用 `globalThis.X = shim`】Node 上这批名字是 `exposeLazyInterfaces()` 装的
 * **惰性**属性：对"只有 getter、没有 setter"的属性赋值，严格模式抛 `TypeError`、
 * 非严格模式静默失败（本文件是 `'use strict'`，所以旧写法会抛）。另外：**读属性描述符本身
 * 就会物化惰性 getter**，所以这里统一用 `Object.defineProperty` 并逐个 try/catch。
 *
 * @returns {'installed'|'kept'|'failed'}
 */
function defineGlobalShim(name, value) {
  try {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (desc !== undefined && desc.value === value) return 'kept';
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return 'installed';
  } catch (error) {
    warn(`全局 ${name} 替换失败：${String(error)}`);
    return 'failed';
  }
}

/**
 * 安装垫片：六个 Web 接口"缺哪个补哪个"，`fetch` 本身在 WASM 不可用时无条件接管。
 *
 * @returns {{status: 'installed'|'kept'|'failed', installed: boolean, fetch: Function, globals: Record<string, string>}}
 */
function installFetchShim() {
  const globals = {};
  for (const [name, impl] of [
    ['Headers', ShimHeaders],
    ['Request', ShimRequest],
    ['Response', ShimResponse],
    ['FormData', ShimFormData],
    ['Blob', ShimBlob],
    ['File', ShimFile],
  ]) {
    /*
     * 【为什么不读值、也不读属性描述符 —— 真机实测（2026-10-20，HAD-W32 / Node v24.2.0）】
     * Node 24 把这六个名字装成 **globalThis 上的惰性 accessor**，而**读值或读描述符都会
     * 物化它** ⇒ 拉起源码里的内建 undici ⇒ `lazyllhttp` 立刻抛
     * `ReferenceError: WebAssembly is not defined`（真机 app.log 里那条 unhandledRejection
     * 的栈顶就是 `at lazyllhttp (node:internal/deps/undici/undici:6340:9)`）。
     * 上一版正是"逐个 try/catch 直接读"，PC 上看不出来（PC 上这六个是普通数据属性），
     * 一到真机就留下一条噪声 rejection。
     *
     * 现在改用 `Object.hasOwn`：它只查**属性是否存在**，**不触发 getter**。
     * 存在即 `kept`（Node 原生提供，我们不碰）；真不存在才补垫片。
     */
    /*
     * 【真机结论（2026-10-20，HAD-W32 / Node v24.2.0，两轮对照）】
     *   · 只"不读"（本实现）⇒ compat 正常就绪，但 Next 启动链自己读这种惰性全局时，
     *     Node 内建 undici 仍会被物化 ⇒ app.log 留一条
     *     `unhandledRejection: WebAssembly is not defined`（栈顶 `lazyllhttp`）。功能不受影响。
     *   · 试过"compat 下一律用垫片类接管这六个全局"（顶掉惰性 accessor）⇒ 报错依旧，
     *     且 **Next 路由直接 500**（`/api/web-auth` 从 200 变 500）：`NextResponse` 继承
     *     `globalThis.Response`，我们的最小垫片不满足其语义。**已回滚**。
     * ⇒ 取舍：宁可留一条已记录、不影响功能的 rejection，也**不接管全局类**。
     *     彻底消掉它需预载 `internal/deps/undici/undici`（要 `--expose-internals`，
     *     参见同源工程 dshm 的 `installInternalUndiciShim`），列为后续项。
     */
    const present = Object.hasOwn(globalThis, name);
    globals[name] = present ? 'kept' : defineGlobalShim(name, impl);
  }

  /*
   * 【fetch：`存在` 不等于 `能用`】Node 24 起 fetch 转正，`globalThis.fetch` 启动即存在。
   * 但 jitless 下 WASM 不可用，原生 fetch 的 undici 解析器（WASM 版 llhttp）注定不可用
   * —— 实测 `fetch('http://127.0.0.1:…')` 直接 `TypeError: fetch failed /
   * cause: WebAssembly is not defined`。所以判据是"WASM 可用 **且** 已有函数"才不覆盖；
   * 其余情况一律覆盖（原生 fetch 在 jitless 下反正调一次炸一次，覆盖是无损的）。
   */
  let fetchStatus;
  /*
   * 评审 #9：**不读 `globalThis.fetch` 的值** —— Node 24 上它可能是惰性 accessor，读一下就把
   * 内建 undici 物化，留下 `unhandledRejection: WebAssembly is not defined`（真机 app.log 实测）。
   * 只看描述符：数据属性取 value，accessor 只表示「存在」。
   */
  const fetchDesc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const fetchValue = fetchDesc !== undefined && 'value' in fetchDesc ? fetchDesc.value : undefined;
  const fetchPresent = fetchDesc !== undefined
    && ((('value' in fetchDesc) && typeof fetchValue === 'function') || typeof fetchDesc.get === 'function');
  if (fetchValue === shimFetch) {
    fetchStatus = 'kept'; // 幂等
  } else if (typeof WebAssembly !== 'undefined' && fetchPresent) {
    fetchStatus = 'kept';
  } else {
    fetchStatus = defineGlobalShim('fetch', shimFetch);
  }

  const status = fetchStatus === 'failed' ? 'failed' : fetchStatus;
  return { status, installed: status === 'installed', fetch: shimFetch, globals };
}

/*
 * 给每个垫片类挂 `Symbol.toStringTag`。
 *
 * 为什么需要：`Object.prototype.toString.call(x)` 与部分库的跨来源判据会读它；
 * 没有它时垫片对象打印成 `[object Object]`，与原生 `[object Response]` 不一致
 * （真机上排查"这个 Response 是谁造的"时非常误导）。`instanceof` 仍然**不能**跨实现用，
 * 判据一律走能力（见文件头）。
 */
for (const [tag, impl] of [
  ['Headers', ShimHeaders],
  ['Request', ShimRequest],
  ['Response', ShimResponse],
  ['FormData', ShimFormData],
  ['Blob', ShimBlob],
  ['File', ShimFile],
]) {
  try {
    Object.defineProperty(impl.prototype, Symbol.toStringTag, { value: tag, configurable: true });
  } catch {
    /* 极少数运行时不支持改原型：不影响功能，静默跳过（下面仍以能力判据工作） */
  }
}

module.exports = {
  installFetchShim,
  shimFetch,
  Headers: ShimHeaders,
  Request: ShimRequest,
  Response: ShimResponse,
  FormData: ShimFormData,
  Blob: ShimBlob,
  File: ShimFile,
  // 供同目录其它模块复用的小工具（不对外承诺稳定）
  makeMultipartBoundary,
  isBlobLike,
  isFormDataLike,
};
