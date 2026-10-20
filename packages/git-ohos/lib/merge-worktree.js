/**
 * Bringing the index and the working tree in line with a merge that moved HEAD.
 *
 * isomorphic-git's `_merge` never does this: the fast-forward branch only writes the ref
 * (`_merge` → `GitRefManager.writeRef`) and the merge-commit branch only writes objects
 * (`mergeTree` + `_commit`, and `_commit` takes no `dir`). Its own `_pull` compensates with a
 * `_checkout` right after `_merge`; `merge` does not. Measured on the device before this
 * module existed: merging a descendant branch left `statusMatrix` at `['b.txt',1,0,0]`, and
 * merging a diverged branch left `['m.txt',1,0,0]` — HEAD moved, the files were simply absent.
 *
 * This module has **no dsh imports** on purpose, so the worktree contract can be tested with a
 * temporary repository instead of a plugin context (`test/merge.worktree.test.mjs`).
 *
 * @module @dsh-ohos/git/merge-worktree
 */

import { renderConflicts } from './report.js'

/**
 * Bring the index and the working tree in line with the commit `oid` that a merge just moved
 * HEAD to.
 *
 * `force:false` is deliberate: if the checkout would overwrite a local edit, this throws a
 * message that names the paths **and** states that HEAD already advanced — never a silent
 * overwrite, and never a bare `CheckoutConflictError` with no context.
 *
 * @param {object} options - the merge result to materialize.
 * @param {object} options.git - the loaded isomorphic-git namespace.
 * @param {object} options.fs - the confined repository filesystem.
 * @param {string} options.dir - the repository root.
 * @param {string} options.oid - the commit HEAD now points at.
 * @param {AbortSignal} [options.signal] - the call's cancellation signal.
 * @returns {Promise<void>} resolves once the index and working tree hold `oid`.
 */
export async function materializeMergedHead({ git, fs, dir, oid, signal }) {
  let branch = null
  try {
    branch = await git.currentBranch({ fs, dir, fullname: false })
  } catch {
    branch = null
  }
  // A detached HEAD must stay detached: pass the commit and skip the symbolic-ref rewrite.
  // On a branch, re-writing the same symbolic ref is a no-op.
  const detached = branch === null || branch === undefined
  try {
    await git.checkout({
      fs,
      dir,
      ref: detached ? oid : branch,
      noUpdateHead: detached,
      force: false,
      signal,
    })
  } catch (error) {
    if (error instanceof Error && error.code === 'CheckoutConflictError') {
      const paths = Array.isArray(error.data?.filepaths) ? error.data.filepaths : []
      throw new Error(renderConflicts(paths, {
        reason: `The merge moved HEAD to ${oid}, but updating the index and the working tree would `
          + `overwrite local changes in ${paths.length} path(s), so it was stopped.`,
        next: 'Resolve or stash those paths (git_stash), then run git_checkout on the current branch, '
          + 'or git_reset --hard to take the merged commit as-is.',
      }))
    }
    throw error
  }
}
