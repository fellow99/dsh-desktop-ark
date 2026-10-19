'use strict';
/**
 * 平台垫片 S6：`node-addon-require-builtin` 的纯 JS 实现。
 *
 * 为什么需要：上游 `@deepseek-ai/dsh-app-boot` 的 profile 解析要读 Node 内部模块
 * （`internal/modules/esm/loader`、`internal/modules/cjs/loader`、`internal/modules/helpers`、
 * `internal/modules/esm/utils`、`internal/modules/esm/resolve`），它通过原生 addon
 * `node-addon-require-builtin` 取得——该 addon 只有 darwin/linux/win32 预编译二进制，
 * **没有 OHOS 目标**，在设备上必然 `No usable native binding found for
 * node-addon-require-builtin-openharmony-arm64`。
 *
 * 替代手段：OHOS 运行时（libnode v24.2.0）支持 `--expose-internals`，
 * 因此用 `require(id)` 直接取同一批内部模块，语义等价（同一个 Node 内部实现）。
 *
 * 约束（宪法 C2：不假装）：
 *   - 只有显式白名单的内部 id 被放行，其它 id 一律抛错并给出原因；
 *   - 若进程未带 `--expose-internals`，抛错信息直接说明缺哪个启动参数（不静默降级）；
 *   - 本文件同时作为 `node_modules/node-addon-require-builtin/lib/index.js` 的替换实现，
 *     与 `bootstrap.js` 的垫片清单共用（标记 `DSH_OHOS_SHIM node-addon-require-builtin`）。
 */
const MARKER = 'DSH_OHOS_SHIM node-addon-require-builtin';
const SHIM_VERSION = '0.1.9+ohos.1';

/** app-boot 实际需要的内部模块（见 packages/boot/app-boot/src/profile-resolution/resolver.ts）。 */
const ALLOWED_INTERNAL_IDS = new Set([
  'internal/modules/esm/loader',
  'internal/modules/cjs/loader',
  'internal/modules/helpers',
  'internal/modules/esm/utils',
  'internal/modules/esm/resolve'
]);

const EXPOSE_FLAG = '--expose-internals';

function exposeInternalsEnabled() {
  const argv = Array.isArray(process.execArgv) ? process.execArgv : [];
  if (argv.indexOf(EXPOSE_FLAG) >= 0) return true;
  // worker_threads 从父线程继承 execArgv；NODE_OPTIONS 也是合法来源。
  const nodeOptions = process.env.NODE_OPTIONS || '';
  return nodeOptions.indexOf(EXPOSE_FLAG) >= 0;
}

/**
 * 取一个 Node 内部模块。
 * @param {string} moduleId 例如 `internal/modules/esm/loader`
 * @returns {unknown}
 */
function requireBuiltin(moduleId) {
  if (typeof moduleId !== 'string' || moduleId === '') {
    throw new Error(`${MARKER}: requireBuiltin 需要非空的内部模块 id`);
  }
  if (!ALLOWED_INTERNAL_IDS.has(moduleId)) {
    throw new Error(`${MARKER}: 未放行的内部模块 ${moduleId}（白名单见 payload/shims/require-builtin.js）`);
  }
  try {
    return require(moduleId);
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    if (!exposeInternalsEnabled()) {
      throw new Error(
        `${MARKER}: 无法读取 ${moduleId}，进程缺少 ${EXPOSE_FLAG} 启动参数（内部原因：${detail}）`
      );
    }
    throw new Error(`${MARKER}: 无法读取 ${moduleId}（${detail}）`);
  }
}

/**
 * @param {string} moduleId
 * @returns {boolean}
 */
function isAllowedInternalId(moduleId) {
  return typeof moduleId === 'string' && ALLOWED_INTERNAL_IDS.has(moduleId);
}

/** 诊断面：谁在这个进程里提供了 requireBuiltin。 */
function getBindingInfo() {
  return {
    mode: 'js-shim',
    backend: 'js',
    abi: 'n/a',
    node: process.version,
    exposeInternals: exposeInternalsEnabled(),
    shimVersion: SHIM_VERSION,
    allowed: [...ALLOWED_INTERNAL_IDS]
  };
}

/**
 * bootstrap 侧安装入口：只做可用性测量，不改写模块解析（替换在装配期完成）。
 * @param {(line: string) => void} log
 */
function install(log) {
  let available = false;
  let detail = '';
  try {
    const helpers = requireBuiltin('internal/modules/helpers');
    available = typeof helpers.getCjsConditions === 'function';
    detail = available ? 'ok' : 'getCjsConditions 不可用';
  } catch (error) {
    detail = error && error.message ? error.message : String(error);
  }
  if (typeof log === 'function') {
    log(`${MARKER}: installed=${available} exposeInternals=${exposeInternalsEnabled()} (${detail})`);
  }
  return { marker: MARKER, installed: available, exposeInternals: exposeInternalsEnabled(), detail };
}

module.exports = {
  requireBuiltin,
  isAllowedInternalId,
  getBindingInfo,
  install,
  marker: MARKER,
  SHIM_VERSION
};
