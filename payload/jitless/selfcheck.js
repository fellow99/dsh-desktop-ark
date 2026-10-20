'use strict';
/**
 * jitless 兼容层的**运行期回环自检**（需求 109-jitless，FR-109-017）
 *
 * 只证明一件事：**这个进程现在能不能用 fetch 发请求**（GET / POST JSON / SSE 分块 / Abort / FormData）。
 * 不启动外部服务、不依赖凭据：自己在 127.0.0.1 上起一个临时 http 服务，跑完即关。
 *
 * 用法（CJS）：
 *     const { runSelfCheck } = require('./selfcheck.js');
 *     const result = await runSelfCheck((line) => log(line));
 *
 * 约定：
 *   · 不 require undici，也不碰 WebAssembly 本体；只依赖 node:http 与调用方给的 fetch；
 *   · 失败不抛：返回 { status: 'ok'|'failed', cases: [...] }，由调用方决定是否阻断；
 *   · 不缓存（每次调用都重新起服务），便于"启动一次、测一次"。
 */

const http = require('node:http');

const DEFAULT_TIMEOUT_MS = 5000;
/** 总预算：设备上任何一步卡死都只记 timeout，不拖住启动（评审 #2）。 */
const DEFAULT_BUDGET_MS = 2000;

/** 包一层超时，避免某个 case 把启动流程挂住。 */
function deadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** 起临时服务，跑 fn(baseUrl)，最后一定关服务。 */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${String(port)}`);
  } finally {
    // 原生 fetch（undici）会保留 keep-alive 连接，server.close() 会一直等它们 ⇒ 先断开再关。
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

/** 读完整条响应体（流式用例用；SSE 必须逐块读）。 */
async function readAll(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, chunks };
}

/**
 * @param {(line: string) => void} [log]
 * @param {{fetch?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{status: 'ok'|'failed', cases: Array<{name: string, ok: boolean, detail: string}>, durationMs: number}>}
 */
async function runSelfCheckInner(log = () => {}, options = {}) {
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const cases = [];
  const started = Date.now();

  const record = (name, ok, detail) => {
    cases.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
    log(`[jitless] selfcheck ${name}: ${ok ? 'ok' : 'failed'}${detail ? ' — ' + String(detail) : ''}`);
  };

  if (typeof fetchImpl !== 'function') {
    record('fetch-available', false, 'fetch 不是函数（兼容层与原生都不可用）');
    return { status: 'failed', cases, durationMs: Date.now() - started };
  }
  record('fetch-available', true, 'fetch 可用');

  try {
    await withServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/get') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok-get');
        return;
      }
      if (url.pathname === '/echo') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'x-echo': req.headers['x-probe'] || '' });
          res.end(Buffer.concat(chunks));
        });
        return;
      }
      if (url.pathname === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: 1\n\n');
        setTimeout(() => {
          res.write('data: 2\n\n');
          setTimeout(() => res.end('data: 3\n\n'), 20);
        }, 20);
        return;
      }
      if (url.pathname === '/slow') {
        const timer = setTimeout(() => { res.writeHead(200); res.end('late'); }, 800);
        req.on('close', () => clearTimeout(timer));
        return;
      }
      if (url.pathname === '/form') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            type: String(req.headers['content-type'] || ''),
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end('not found');
    }, async (base) => {
      try {
        const response = await deadline(fetchImpl(`${base}/get`), timeoutMs, 'get');
        const text = await deadline(response.text(), timeoutMs, 'get.text');
        record('get', response.ok === true && text === 'ok-get', `status=${response.status} body=${text}`);
      } catch (error) {
        record('get', false, error && error.message ? error.message : String(error));
      }

      try {
        const response = await deadline(fetchImpl(`${base}/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-probe': 'p109' },
          body: JSON.stringify({ hello: '109' }),
        }), timeoutMs, 'post');
        const body = await deadline(response.json(), timeoutMs, 'post.json');
        record('post-json', body && body.hello === '109' && response.headers.get('x-echo') === 'p109',
          JSON.stringify(body));
      } catch (error) {
        record('post-json', false, error && error.message ? error.message : String(error));
      }

      try {
        const response = await deadline(fetchImpl(`${base}/sse`), timeoutMs, 'sse');
        const { text, chunks } = await deadline(readAll(response), timeoutMs, 'sse.read');
        const ordered = text.indexOf('data: 1') >= 0 && text.indexOf('data: 2') > text.indexOf('data: 1')
          && text.indexOf('data: 3') > text.indexOf('data: 2');
        record('sse-stream', ordered && chunks >= 2, `chunks=${chunks} body=${JSON.stringify(text)}`);
      } catch (error) {
        record('sse-stream', false, error && error.message ? error.message : String(error));
      }

      try {
        const controller = new AbortController();
        const pending = fetchImpl(`${base}/slow`, { signal: controller.signal });
        const killer = setTimeout(() => controller.abort(), 30);
        try {
          await deadline(pending, timeoutMs, 'abort');
          record('abort', false, '请求未被中止');
        } finally {
          clearTimeout(killer);
        }
      } catch (error) {
        const name = error && error.name ? error.name : '';
        record('abort', name === 'AbortError' || /abort/i.test(String(error && error.message)),
          `name=${name} message=${error && error.message ? error.message : String(error)}`);
      }

      try {
        const form = new FormData();
        form.append('field', 'value109');
        form.append('file', new Blob(['hello-blob'], { type: 'text/plain' }), 'a.txt');
        const response = await deadline(fetchImpl(`${base}/form`, { method: 'POST', body: form }), timeoutMs, 'form');
        const parsed = await deadline(response.json(), timeoutMs, 'form.json');
        const ok = String(parsed.type).startsWith('multipart/form-data')
          && String(parsed.body).includes('name="field"')
          && String(parsed.body).includes('value109')
          && String(parsed.body).includes('hello-blob');
        record('formdata', ok, `content-type=${String(parsed.type).slice(0, 40)} bytes=${String(parsed.body).length}`);
      } catch (error) {
        record('formdata', false, error && error.message ? error.message : String(error));
      }
    });
  } catch (error) {
    record('server', false, error && error.message ? error.message : String(error));
  }

  // 惰性 getter 封印的副作用检查（只在 compat 下有意义；读这两个值本身是安全的）
  try {
    const httpMod = require('node:http');
    const httpsMod = require('node:https');
    const maxHeader = httpMod.maxHeaderSize;
    const agent = httpsMod.globalAgent;
    const ok = typeof maxHeader === 'number' && maxHeader > 0
      && agent !== undefined && agent !== null && agent.protocol === 'https:';
    record('http-lazy-sealed', ok, `maxHeaderSize=${String(maxHeader)} httpsAgentProtocol=${agent && agent.protocol}`);
  } catch (error) {
    record('http-lazy-sealed', false, error && error.message ? error.message : String(error));
  }

  const failed = cases.filter((item) => item.ok !== true).length;
  const result = { status: failed === 0 ? 'ok' : 'failed', cases, durationMs: Date.now() - started };
  log(`[jitless] selfcheck ${result.status}：${cases.length - failed}/${cases.length} 通过（${result.durationMs}ms）`);
  return result;
}

/**
 * 带**总预算**的自检（评审 #2）：任何一步卡死都只记 `status:'timeout'`，绝不拖住启动。
 * @param {(line: string) => void} [log]
 * @param {{fetch?: Function, timeoutMs?: number, budgetMs?: number}} [options]
 * @returns {Promise<{status: 'ok'|'failed'|'timeout', cases: Array<{name: string, ok: boolean, detail: string}>, durationMs: number}>}
 */
async function runSelfCheck(log = () => {}, options = {}) {
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : DEFAULT_BUDGET_MS;
  const started = Date.now();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: 'timeout', cases: [], durationMs: Date.now() - started });
    }, budgetMs);
  });
  try {
    const result = await Promise.race([runSelfCheckInner(log, options), timeout]);
    if (result.status === 'timeout') {
      log(`[jitless] selfcheck timeout：超过总预算 ${budgetMs}ms（不阻断启动）`);
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

module.exports = { runSelfCheck };
