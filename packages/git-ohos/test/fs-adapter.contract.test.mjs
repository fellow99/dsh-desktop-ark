/**
 * Contract tests for the chroot adapter (`lib/fs-adapter.js`).
 *
 * The first two tests pin a defect that was **measured on device** and is invisible in a code
 * review: isomorphic-git decides whether an `fs` speaks promises or callbacks by calling
 * `readFile()` with **no arguments** and asking whether the result is promise-like (`isPromiseFs` /
 * `isPromiseLike` in its `FileSystem`). A *synchronous* throw counts as "callbacks": the library
 * then wraps all eleven commands in `pify` and waits for a callback that never comes, so **every**
 * git operation hangs forever while the event loop stays healthy (`git_init` never returned; the
 * Electron main thread stayed blocked and the window sat on "reconnecting").
 *
 * Declaring each method `async` is what makes the probe see a promise — an async function cannot
 * throw synchronously. That is a contract, so it is asserted here rather than left to a comment.
 *
 * The remaining tests pin the security property the whole design rests on (every path stays inside
 * one repository root, symlinks included) — see `../dsh-desktop-hos/docs/204-插件-GIT.md` §8 / FR-4.2.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createRepositoryFs,
  isWithin,
  PathOutsideRepositoryError,
  resolveWithin,
} from '../lib/fs-adapter.js'

/** The eleven commands isomorphic-git's `bindFs` requires of every `fs`. */
const REQUIRED_COMMANDS = [
  'readFile', 'writeFile', 'mkdir', 'rmdir', 'unlink',
  'stat', 'lstat', 'readdir', 'readlink', 'symlink',
]

/** isomorphic-git's own probe, reproduced: a synchronous throw must not escape it. */
function looksLikePromiseFs(fs) {
  try {
    const result = fs.promises.readFile().catch(error => error)
    return typeof result?.then === 'function' && typeof result?.catch === 'function'
  } catch {
    return false
  }
}

/** A throwaway root with a file inside and a directory outside it. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'git-adapter-'))
  const root = join(base, 'repo')
  const outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET')
  writeFileSync(join(root, 'inside.txt'), 'ok')
  return { base, root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('every promises method is an async function (isPromiseFs contract)', () => {
  const fs = createRepositoryFs('/tmp/whatever')
  for (const command of REQUIRED_COMMANDS) {
    const method = fs.promises[command]
    assert.equal(typeof method, 'function', `promises.${command} must exist`)
    assert.equal(
      method.constructor.name,
      'AsyncFunction',
      `promises.${command} must be declared async — otherwise isomorphic-git treats this fs as `
      + 'callback-style and every call hangs inside pify',
    )
  }
  assert.equal(typeof fs.promises.rm, 'function', 'promises.rm backs recursive deletes')
})

test('the fs is detected as promise-style, not callback-style', () => {
  const { root, cleanup } = fixture()
  try {
    assert.equal(looksLikePromiseFs(createRepositoryFs(root)), true)
  } finally {
    cleanup()
  }
})

test('a path inside the root resolves, a `..` escape is refused', () => {
  const { root, cleanup } = fixture()
  try {
    assert.equal(resolveWithin(root, 'inside.txt'), join(root, 'inside.txt'))
    assert.equal(resolveWithin(root, join(root, 'inside.txt')), join(root, 'inside.txt'))
    assert.throws(() => resolveWithin(root, '../outside/secret.txt'), PathOutsideRepositoryError)
    assert.throws(() => resolveWithin(root, '../../etc/passwd'), PathOutsideRepositoryError)
  } finally {
    cleanup()
  }
})

test('an absolute path outside the root is refused without touching the filesystem', () => {
  const { root, outside, cleanup } = fixture()
  try {
    assert.throws(
      () => resolveWithin(root, join(outside, 'secret.txt')),
      PathOutsideRepositoryError,
    )
    // The sibling that merely shares a name prefix must not pass the boundary check either.
    assert.throws(() => resolveWithin(root, `${root}-evil/x`), PathOutsideRepositoryError)
  } finally {
    cleanup()
  }
})

test('a symlink pointing out of the root is refused (read and write direction)', async t => {
  const { root, outside, cleanup } = fixture()
  try {
    const link = join(root, 'link')
    try {
      symlinkSync(outside, link, 'dir')
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
        t.skip(`symlinks unavailable here (${error.code})`)
        return
      }
      throw error
    }
    const fs = createRepositoryFs(root)
    assert.throws(() => resolveWithin(root, join(link, 'secret.txt')), PathOutsideRepositoryError)
    await assert.rejects(
      fs.promises.readFile(join(link, 'secret.txt'), 'utf8'),
      PathOutsideRepositoryError,
    )
    await assert.rejects(
      fs.promises.writeFile(join(link, 'new.txt'), 'x'),
      PathOutsideRepositoryError,
    )
    // A relative link target that walks out of the root is refused too.
    assert.throws(
      () => resolveWithin(root, join(dirnameOf(link), '..', '..', 'outside', 'secret.txt')),
      PathOutsideRepositoryError,
    )
  } finally {
    cleanup()
  }
})

test('isWithin is a segment-boundary test, not a string prefix test', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true)
  assert.equal(isWithin('/a/b', '/a/b/c'), true)
  assert.equal(isWithin('/a/b', '/a/bc'), false)
  assert.equal(isWithin('/a/b', '/a'), false)
})

/** `dirname` without importing `node:path` twice in the body of a test. */
function dirnameOf(p) {
  return p.slice(0, p.lastIndexOf('/'))
}
