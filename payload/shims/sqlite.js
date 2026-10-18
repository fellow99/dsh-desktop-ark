'use strict';
/**
 * 平台垫片 S5：`node:sqlite` + FTS5 探测（G2 门禁的现场判据）。
 *
 * `session-query-sqlite` 依赖内置 `node:sqlite` 且需要 FTS5。若不可用，
 * 按规划走 better-sqlite3（G9）+ loader 重定向（S5 的完整形态在 P2 落地）。
 * 本文件只测量，不改写模块解析。
 *
 * 标记：DSH_OHOS_SHIM node:sqlite
 */
const MARKER = 'DSH_OHOS_SHIM node:sqlite';

/**
 * @param {(line: string) => void} log
 * @returns {{ marker: string, available: boolean, fts5: boolean, detail: string }}
 */
function install(log) {
  let available = false;
  let fts5 = false;
  let detail = '';

  try {
    const sqlite = require('node:sqlite');
    available = typeof sqlite.DatabaseSync === 'function';
    if (available) {
      const db = new sqlite.DatabaseSync(':memory:');
      try {
        db.exec('CREATE VIRTUAL TABLE __probe USING fts5(x)');
        fts5 = true;
      } finally {
        db.close();
      }
    }
    detail = 'ok';
  } catch (error) {
    detail = error && error.message ? error.message : String(error);
  }

  log(`${MARKER}: available=${available} fts5=${fts5} (${detail})`);
  return { marker: MARKER, available, fts5, detail };
}

module.exports = { install, marker: MARKER };
