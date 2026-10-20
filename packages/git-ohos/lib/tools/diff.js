/**
 * The model-facing `git_diff` tool.
 *
 * isomorphic-git has no `diff` primitive (see `../dsh-desktop-hos/docs/204-插件-GIT.md` F5, §11.2), so this tool
 * enumerates the changed paths by walking two of the four available views — HEAD (`TREE`),
 * the index (`STAGE`) and the working tree (`WORKDIR`) — reads only the blobs that actually
 * differ, and renders them with jsdiff.
 *
 * Reading policy, in order of importance:
 *
 * 1. Paths whose object ids are equal are **never** read.
 * 2. A working-tree file whose `lstat` size exceeds `maxDiffBlobBytes` is never read.
 * 3. A blob over the cap is reported as skipped; the diff is never truncated.
 * 4. Binary content (a NUL byte) is reported as differing, never rendered as text.
 * 5. Untracked files are excluded, exactly as `git diff` excludes them.
 *
 * @module @dsh-ohos/git/tools/diff
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { binaryDiffNote, isBinaryBytes, oversizeDiffNote, statOf, unifiedDiff } from '../diff.js'
import { resolveRevision } from './commit.js'

/**
 * Whether one walk side is absent.
 *
 * `git.walk` hands the map callback a `null` for a tree that lacks the path (see the walk's
 * `unionOfIterators`) and `undefined` in other cases, so both must be treated as "not there".
 * @param {object | null | undefined} entry - the walker entry for one side.
 * @returns true when this side has no such path.
 */
function isAbsent(entry) {
  return entry === undefined || entry === null
}

/** The diff modes and which views each one compares. */
const MODES = ['workdir', 'staged', 'head', 'refs']

/**
 * Whether one repository path is selected by the requested pathspecs.
 * @param {string} filepath - the repository-relative path.
 * @param {string[]} specs - the requested pathspecs; an empty list selects everything.
 * @returns true when the path is inside the requested scope.
 */
function matchesPathspec(filepath, specs) {
  if (specs.length === 0) return true
  return specs.some(spec => {
    const clean = spec.replace(/^\.\//, '').replace(/\/+$/, '')
    if (clean === '' || clean === '.') return true
    return filepath === clean || filepath.startsWith(`${clean}/`)
  })
}

/**
 * Read one side's bytes, refusing to buffer content over the diff cap.
 *
 * A working-tree entry reports its real file size, so an oversized file is refused before
 * anything is hashed or read. Tree and index entries carry no size — isomorphic-git exposes no
 * size-only accessor for an object — so their cap is applied to the blob that was read, and the
 * caller turns that into an explicit "skipped" note rather than truncating.
 *
 * Content comes from the walker when it has any (the working-tree and tree walkers do) and from
 * the object store otherwise: the index walker's `content()` is deliberately empty, while the
 * id it reports may name an object that was never written to the repository (a freshly staged
 * working-tree blob), which is why the walker's own accessor is tried first.
 *
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} dir - the repository root.
 * @param {object | null | undefined} entry - the walker entry for this side.
 * @param {string | null} oid - this side's blob id, or null when the path is absent.
 * @param {string} label - the side's label, for the skip note.
 * @param {number} maxBytes - the per-file cap.
 * @returns the bytes, or the reason they were not read.
 */
async function readSide(git, fs, dir, entry, oid, label, maxBytes) {
  if (isAbsent(entry) || oid === null) return {}
  const stat = await entry.stat()
  if (stat !== undefined && Number.isFinite(stat.size) && stat.size > maxBytes) {
    return { oversize: { label, size: stat.size } }
  }
  let bytes = await entry.content()
  if (bytes === undefined) bytes = (await git.readBlob({ fs, dir, oid })).blob
  if (bytes !== undefined && bytes.length > maxBytes) return { oversize: { label, size: bytes.length } }
  return { bytes }
}

/**
 * Register the `git_diff` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitDiffTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_diff',
    description: 'Show a unified diff between two sides of the repository. `mode` selects them: "workdir" is the '
      + 'index against the working tree (unstaged changes), "staged" is HEAD against the index (what `git_commit` '
      + 'would record), "head" is HEAD against the working tree (everything not yet committed), and "refs" compares '
      + '`ref` against `ref2` (any branch, tag, commit id or full or abbreviated commit id). `paths` narrows the diff to '
      + 'pathspecs. `stat: true` reports only added/removed line counts. Untracked files are not diffed, binary '
      + 'files are reported as differing without a text diff, and a file over maxDiffBlobBytes is reported as '
      + 'skipped (never truncated). Fails when a ref cannot be resolved or `dir` is not a repository; a `dir` '
      + 'outside the session workspace is refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      mode: {
        type: 'string',
        enum: MODES,
        description: 'Which two sides to compare. Defaults to "head" (HEAD against the working tree).',
      },
      ref: {
        type: 'string',
        description: 'Base ref for `mode: "refs"` (which also needs ref2). Omit it with the other modes: '
          + 'they pin their own base, and passing it there is reported as an error instead of being '
          + 'dropped silently. Ancestry syntax (`HEAD~1`) is not implemented by the git library in this '
          + 'deployment — pass a branch, a tag, "HEAD", or an object id.',
      },
      ref2: {
        type: 'string',
        description: 'Target ref for `mode: "refs"` (required there). Omit it with the other modes: they '
          + 'pin their own target, and passing it there is reported as an error instead of being dropped.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Pathspecs (files or directory prefixes, repository-relative) to limit the diff to.',
      },
      stat: { type: 'boolean', description: 'Report only the added and removed line counts per file.' },
      context: {
        type: 'number',
        description: 'Unchanged context lines kept around each hunk. Defaults to 3; use 0 for a minimal diff.',
      },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          base: { type: 'string', required: true },
          target: { type: 'string', required: true },
          stat: { type: 'boolean', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                status: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                addedLines: { type: 'number', required: true },
                removedLines: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const header = `diff ${value.mode} (${value.base} -> ${value.target})`
        if (value.files.length === 0) {
          return [{
            type: 'text',
            text: `${header}\nNo changes: the two sides are identical`
              + `${Array.isArray(args.paths) && args.paths.length > 0 ? ` under ${args.paths.join(', ')}` : ''}.`,
          }]
        }
        const totals = value.files.reduce(
          (sum, file) => ({ added: sum.added + file.addedLines, removed: sum.removed + file.removedLines }),
          { added: 0, removed: 0 },
        )
        const body = value.files.map(file => value.stat
          ? `  ${file.status.padEnd(8)} ${file.path}  (+${file.addedLines}/-${file.removedLines})${file.kind === 'text' ? '' : ` [${file.kind}]`}`
          : `--- ${file.status} ${file.path} ---\n${file.text}`).join('\n\n')
        return [{
          type: 'text',
          text: `${header}\n${value.files.length} changed file(s), +${totals.added}/-${totals.removed} lines:\n\n${body}`,
        }]
      },
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_diff', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const mode = args.mode ?? 'head'
        // `ref`/`ref2` name the base and target of the "refs" comparison only: the other three modes
        // pin those themselves. Dropping them silently is what made a device run report "no changes"
        // for `ref: "HEAD~1"` — an unsupported ancestry spelling — instead of saying so (FR-9).
        for (const [name, value] of [['ref', args.ref], ['ref2', args.ref2]]) {
          if (mode !== 'refs' && value !== undefined) {
            throw new Error(
              `git_diff: ${name} is only meaningful with mode "refs" (which needs ref and ref2); mode `
              + `"${mode}" always compares ${mode === 'workdir' ? 'the index with the working tree'
                : mode === 'staged' ? 'HEAD with the index' : 'HEAD with the working tree'}.`,
            )
          }
        }
        const specs = Array.isArray(args.paths) ? args.paths : []
        /** The walk's trees, which of them are compared, and which of them prove tracking. */
        let plan
        let base
        let target
        switch (mode) {
          case 'workdir':
            plan = { trees: [git.STAGE(), git.WORKDIR()], base: 0, target: 1, tracked: [0] }
            base = 'the index'
            target = 'the working tree'
            break
          case 'staged':
            plan = { trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()], base: 0, target: 1, tracked: [0, 1] }
            base = 'HEAD'
            target = 'the index'
            break
          case 'head':
            plan = { trees: [git.TREE({ ref: 'HEAD' }), git.STAGE(), git.WORKDIR()], base: 0, target: 2, tracked: [0, 1] }
            base = 'HEAD'
            target = 'the working tree'
            break
          case 'refs': {
            if (args.ref2 === undefined) throw new Error('git_diff: mode "refs" requires ref2 (the target ref)')
            const fromRef = (await resolveRevision(git, opened.fs, opened.root, args.ref ?? 'HEAD')).ref
            const toRef = (await resolveRevision(git, opened.fs, opened.root, args.ref2)).ref
            plan = { trees: [git.TREE({ ref: fromRef }), git.TREE({ ref: toRef })], base: 0, target: 1, tracked: [0, 1] }
            base = fromRef
            target = args.ref2
            break
          }
          default:
            throw new Error(`git_diff: unknown mode "${mode}" (expected one of ${MODES.join(', ')})`)
        }

        const maxBytes = deps.config.maxDiffBlobBytes
        const files = await git.walk({
          fs: opened.fs,
          dir: opened.root,
          trees: plan.trees,
          map: async (filepath, entries) => {
            // `.git` is pruned explicitly: it is not part of any diff and must never be walked.
            if (filepath === '.git' || filepath.startsWith('.git/')) return null
            if (filepath === '.') return undefined
            // Tracking first: a path that exists only in the working tree is untracked, and
            // `git diff` does not show untracked files.
            if (!plan.tracked.some(index => !isAbsent(entries[index]))) return null
            if (!matchesPathspec(filepath, specs)) return null
            const baseEntry = entries[plan.base]
            const targetEntry = entries[plan.target]
            const baseType = isAbsent(baseEntry) ? undefined : await baseEntry.type()
            const targetType = isAbsent(targetEntry) ? undefined : await targetEntry.type()
            if (baseType === 'tree' || targetType === 'tree') {
              // A directory that is absent on one side is carried by its children; a directory
              // replaced by a file (or the reverse) is a type change with no content to show.
              if (baseType === targetType) return undefined
              if (baseType === undefined || targetType === undefined) return undefined
              // (a side that is absent is carried by its children, handled just above)
              return {
                path: filepath,
                status: 'type-change',
                kind: 'type-change',
                addedLines: 0,
                removedLines: 0,
                text: `${filepath}: ${baseType} replaced by ${targetType} (no content diff).`,
              }
            }
            const beforeLabel = `a/${filepath}`
            const afterLabel = `b/${filepath}`
            const status = isAbsent(baseEntry) ? 'added' : isAbsent(targetEntry) ? 'deleted' : 'modified'
            // A working-tree file over the cap is refused before it is hashed or read.
            const tooBig = [
              [beforeLabel, isAbsent(baseEntry) ? undefined : await baseEntry.stat()],
              [afterLabel, isAbsent(targetEntry) ? undefined : await targetEntry.stat()],
            ].find(([, stat]) => stat !== undefined && Number.isFinite(stat.size) && stat.size > maxBytes)
            if (tooBig !== undefined) {
              return {
                path: filepath,
                status,
                kind: 'oversize',
                addedLines: 0,
                removedLines: 0,
                text: oversizeDiffNote(tooBig[0], tooBig[1].size, maxBytes),
              }
            }
            const baseOid = isAbsent(baseEntry) ? null : await baseEntry.oid()
            const targetOid = isAbsent(targetEntry) ? null : await targetEntry.oid()
            if (baseOid === targetOid) return undefined
            const before = await readSide(git, opened.fs, opened.root, baseEntry, baseOid, beforeLabel, maxBytes)
            const after = await readSide(git, opened.fs, opened.root, targetEntry, targetOid, afterLabel, maxBytes)
            if (before.oversize !== undefined || after.oversize !== undefined) {
              const skipped = before.oversize ?? after.oversize
              return {
                path: filepath,
                status,
                kind: 'oversize',
                addedLines: 0,
                removedLines: 0,
                text: oversizeDiffNote(skipped.label, skipped.size, maxBytes),
              }
            }
            if (isBinaryBytes(before.bytes) || isBinaryBytes(after.bytes)) {
              return {
                path: filepath,
                status,
                kind: 'binary',
                addedLines: 0,
                removedLines: 0,
                text: binaryDiffNote(beforeLabel, afterLabel),
              }
            }
            if (args.stat === true) {
              const counts = await statOf(before.bytes, after.bytes)
              return {
                path: filepath,
                status,
                kind: 'text',
                addedLines: counts.added,
                removedLines: counts.removed,
                text: `${counts.added} insertion(s)(+), ${counts.removed} deletion(s)(-)`,
              }
            }
            const text = await unifiedDiff(before.bytes, after.bytes, beforeLabel, afterLabel, {
              ...args.context === undefined ? {} : { context: args.context },
            })
            const counts = await statOf(before.bytes, after.bytes)
            return {
              path: filepath,
              status,
              kind: 'text',
              addedLines: counts.added,
              removedLines: counts.removed,
              text,
            }
          },
        })

        return {
          root: opened.root,
          mode,
          base,
          target,
          stat: args.stat === true,
          files: (files ?? []).filter(file => file !== undefined && file !== null),
        }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_diff', args, exec))
      }
    },
  }))
}
