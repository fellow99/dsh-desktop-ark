/**
 * The merge → index/working-tree contract.
 *
 * isomorphic-git's `_merge` moves the branch ref (or writes a merge commit) and leaves the
 * index and the working tree alone; `@dsh-ohos/git` compensates with `materializeMergedHead()`.
 * Without that call the tool reports success while `git_status` still shows the pre-merge
 * content — measured on the device for both the fast-forward and the merge-commit path
 * (`['b.txt',1,0,0]`, `['m.txt',1,0,0]`).
 *
 * These cases drive the real isomorphic-git closure and the plugin's own fs adapter, so they
 * fail if either the library behaviour or the compensation changes.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRepositoryFs } from '../lib/fs-adapter.js'
import { materializeMergedHead } from '../lib/merge-worktree.js'
import { loadGit } from '../lib/runtime.js'

const author = { name: 'test', email: 'test@example.com' }

/** Create a repository in a fresh temp dir, and remove it when the case ends. */
async function withRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-merge-'))
  const fs = createRepositoryFs(root)
  const { git } = await loadGit()
  try {
    await git.init({ fs, dir: root, defaultBranch: 'main' })
    await run({ git, fs, root })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Write a file and commit it. */
async function commitFile({ git, fs, root }, path, content, message) {
  writeFileSync(join(root, path), content)
  await git.add({ fs, dir: root, filepath: path })
  return git.commit({ fs, dir: root, message, author })
}

test('a fast-forward merge materializes the working tree', async () => {
  await withRepo(async (repo) => {
    const { git, fs, root } = repo
    await commitFile(repo, 'a.txt', 'one\n', 'c1')
    await git.branch({ fs, dir: root, ref: 'dev' })
    const tip = await commitFile(repo, 'b.txt', 'two\n', 'c2')
    await git.checkout({ fs, dir: root, ref: 'dev' })

    const result = await git.merge({ fs, dir: root, theirs: 'main', fastForward: true, abortOnConflict: true, author, committer: author })
    assert.equal(result.fastForward, true)
    // The library alone would leave b.txt absent; the compensation is what makes this pass.
    await materializeMergedHead({ git, fs, dir: root, oid: result.oid })

    assert.equal(existsSync(join(root, 'b.txt')), true)
    assert.deepEqual(await git.statusMatrix({ fs, dir: root }), [
      ['a.txt', 1, 1, 1],
      ['b.txt', 1, 1, 1],
    ])
    assert.equal(await git.resolveRef({ fs, dir: root, ref: 'HEAD' }), tip)
    assert.equal(await git.currentBranch({ fs, dir: root, fullname: false }), 'dev')
  })
})

test('a merge commit materializes the working tree', async () => {
  await withRepo(async (repo) => {
    const { git, fs, root } = repo
    await commitFile(repo, 'a.txt', 'one\n', 'c1')
    await git.branch({ fs, dir: root, ref: 'dev' })
    await commitFile(repo, 'm.txt', 'main side\n', 'main side')
    await git.checkout({ fs, dir: root, ref: 'dev' })
    await commitFile(repo, 'd.txt', 'dev side\n', 'dev side')

    const result = await git.merge({ fs, dir: root, theirs: 'main', fastForward: true, abortOnConflict: true, author, committer: author })
    assert.equal(result.mergeCommit, true)
    await materializeMergedHead({ git, fs, dir: root, oid: result.oid })

    assert.equal(existsSync(join(root, 'm.txt')), true)
    assert.deepEqual(await git.statusMatrix({ fs, dir: root }), [
      ['a.txt', 1, 1, 1],
      ['d.txt', 1, 1, 1],
      ['m.txt', 1, 1, 1],
    ])
    assert.equal(await git.resolveRef({ fs, dir: root, ref: 'HEAD' }), result.oid)
  })
})

test('a dry-run merge writes neither refs nor files', async () => {
  await withRepo(async (repo) => {
    const { git, fs, root } = repo
    await commitFile(repo, 'a.txt', 'one\n', 'c1')
    await git.branch({ fs, dir: root, ref: 'dev' })
    await commitFile(repo, 'b.txt', 'two\n', 'c2')
    await git.checkout({ fs, dir: root, ref: 'dev' })
    const before = await git.resolveRef({ fs, dir: root, ref: 'HEAD' })

    await git.merge({ fs, dir: root, theirs: 'main', fastForward: true, dryRun: true, abortOnConflict: true, author, committer: author })

    assert.equal(existsSync(join(root, 'b.txt')), false)
    assert.equal(await git.resolveRef({ fs, dir: root, ref: 'HEAD' }), before)
  })
})

test('materialization refuses to overwrite a local edit and says HEAD already moved', async () => {
  await withRepo(async (repo) => {
    const { git, fs, root } = repo
    await commitFile(repo, 'a.txt', 'one\n', 'c1')
    await git.branch({ fs, dir: root, ref: 'dev' })
    const tip = await commitFile(repo, 'b.txt', 'tracked version\n', 'c2')
    await git.checkout({ fs, dir: root, ref: 'dev' })
    // The same path now exists locally with other content, so a forced update would lose it.
    writeFileSync(join(root, 'b.txt'), 'local version\n')

    const result = await git.merge({ fs, dir: root, theirs: 'main', fastForward: true, abortOnConflict: true, author, committer: author })
    await assert.rejects(
      () => materializeMergedHead({ git, fs, dir: root, oid: result.oid }),
      (error) => {
        assert.match(error.message, /moved HEAD to /)
        assert.match(error.message, /b\.txt/)
        return true
      },
    )
    // The local file is untouched, and HEAD really did move (the error says so).
    assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'local version\n')
    assert.equal(await git.resolveRef({ fs, dir: root, ref: 'HEAD' }), tip)
  })
})
