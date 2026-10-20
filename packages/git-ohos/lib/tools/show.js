/**
 * The model-facing `git_show` tool: one ref, whatever object it names.
 *
 * isomorphic-git has no `show` (see `../dsh-desktop-hos/docs/204-插件-GIT.md` §11.1), so this tool resolves the
 * ref itself and dispatches on the object type: a commit is reported as metadata plus its
 * change list plus the content of each changed path, a tag as its own metadata followed by the
 * object it points at, a tree as a listing, and a blob as its content. Content over
 * `maxDiffBlobBytes` is skipped with an explicit note rather than truncated.
 *
 * @module @dsh-ohos/git/tools/show
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadGit } from '../runtime.js'
import { decodeText, isBinaryBytes, oversizeDiffNote } from '../diff.js'
import { renderChangeList, renderCommitMeta, formatTimestamp, shortOid } from '../report.js'
import { resolveRevision } from './commit.js'

/**
 * The text shown for a file that cannot be rendered as text.
 * @param {string} label - the path label.
 * @param {number} size - the content size in bytes.
 * @returns the model-facing explanation.
 */
function binaryContentNote(label, size) {
  return `${label}: binary content (${size} bytes), not rendered as text.`
}

/**
 * Render one blob, or explain why it is not rendered as text.
 * @param {Uint8Array} bytes - the blob content.
 * @param {string} label - the path label.
 * @param {number} maxBytes - the per-file cap.
 * @returns the model-facing text.
 */
function renderBlobBytes(bytes, label, maxBytes) {
  if (bytes.length > maxBytes) return oversizeDiffNote(label, bytes.length, maxBytes)
  if (isBinaryBytes(bytes)) return binaryContentNote(label, bytes.length)
  return decodeText(bytes)
}

/**
 * Describe one object referenced from a change list or a tag, without recursing into
 * directories: a tree is summarised by its entries, a blob by its content.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} root - the repository root.
 * @param {string} oid - the object id to read.
 * @param {string} label - the label to print for this object.
 * @param {number} maxBytes - the per-file cap.
 * @returns the model-facing text for this object.
 */
async function describeObject(git, fs, root, oid, label, maxBytes) {
  const object = await git.readObject({ fs, dir: root, oid, format: 'parsed' })
  if (object.type === 'tree') {
    const entries = object.object
    return `${label}: directory (${entries.length} entries) — `
      + entries.map(entry => `${entry.type === 'tree' ? `${entry.path}/` : entry.path}`).join(', ')
  }
  if (object.type === 'blob') return renderBlobBytes(object.object, label, maxBytes)
  return `${label}: ${object.type} object ${oid} (not expanded by git_show).`
}

/**
 * Render whatever object a ref resolves to.
 * @param {object} git - the loaded isomorphic-git namespace.
 * @param {object} fs - the confined repository filesystem.
 * @param {string} root - the repository root.
 * @param {string} oid - the resolved object id.
 * @param {object} options - rendering options.
 * @param {boolean} options.content - read the content of the changed paths and blobs.
 * @param {string[]} options.paths - pathspecs limiting a commit's change list; empty means all.
 * @param {number} options.maxBytes - the per-file cap.
 * @param {number} options.depth - how many times a tag may be followed before stopping.
 * @returns the object's type and its rendered text.
 */
async function describeObjectGraph(git, fs, root, oid, options) {
  const object = await git.readObject({ fs, dir: root, oid, format: 'parsed' })

  if (object.type === 'tag') {
    const tag = await git.readTag({ fs, dir: root, oid })
    const tagger = tag.tag.tagger
    const lines = [
      `tag ${tag.tag.tag}`,
      `Object:  ${tag.tag.object} (${tag.tag.type})`,
      ...tagger === undefined ? [] : [
        `Tagger:  ${tagger.name}${tagger.email === '' ? '' : ` <${tagger.email}>`}`,
        `Date:    ${formatTimestamp(tagger.timestamp, tagger.timezoneOffset)}`,
      ],
      '',
      String(tag.tag.message ?? '').replace(/\n+$/, '') || '(empty tag message)',
    ]
    if (options.depth > 0) {
      const peeled = await describeObjectGraph(git, fs, root, tag.tag.object, {
        ...options,
        depth: options.depth - 1,
        content: false,
      })
      lines.push('', `The tag points at a ${peeled.type}:`, peeled.text)
    }
    return { type: 'tag', text: lines.join('\n') }
  }

  if (object.type === 'tree') {
    const entries = object.object
    const body = entries.length === 0
      ? 'This tree is empty.'
      : entries.map(entry => `  ${entry.mode} ${entry.type.padEnd(6)} ${shortOid(entry.oid)} ${entry.path}`).join('\n')
    return { type: 'tree', text: `${entries.length} entries:\n${body}` }
  }

  if (object.type === 'blob') {
    return { type: 'blob', text: renderBlobBytes(object.object, oid, options.maxBytes) }
  }

  if (object.type !== 'commit') {
    return { type: String(object.type), text: `Object ${oid} is a ${object.type}, which git_show does not render.` }
  }

  const commits = await git.log({ fs, dir: root, ref: oid, depth: 1, includeChanges: true })
  const entry = commits[0]
  if (entry === undefined) {
    return { type: 'commit', text: `Commit ${oid} could not be read back from the history walk.` }
  }
  const meta = renderCommitMeta(entry)
  const all = (entry.commit.changes ?? []).map(([newOid, oldOid, path]) => ({
    path,
    status: oldOid === null ? 'added' : newOid === null ? 'deleted' : 'modified',
    newOid,
    oldOid,
  }))
  const selected = options.paths.length === 0
    ? all
    : all.filter(change => options.paths.some(spec => {
      const clean = spec.replace(/^\.\//, '').replace(/\/+$/, '')
      if (clean === '' || clean === '.') return true
      return change.path === clean || change.path.startsWith(`${clean}/`)
    }))
  const sections = [meta, renderChangeList(selected, {
    empty: 'No changed paths: this commit records no change against its parent.',
  })]
  if (options.content === true) {
    for (const change of selected) {
      // An added or modified path is shown at its new content; a deleted path is shown at the
      // content being removed, which is the only side that still exists.
      const side = change.newOid ?? change.oldOid
      const label = `${change.status === 'deleted' ? 'removed' : 'content'} ${change.path}`
      sections.push(`--- ${label} ---\n${await describeObject(git, fs, root, side, change.path, options.maxBytes)}`)
    }
  }
  return { type: 'commit', text: sections.join('\n\n') }
}

/**
 * Register the `git_show` tool.
 * @param ctx - the plugin context; `ctx.tools` receives the registration.
 * @param deps - shared collaborators.
 * @param {import('../fence.js').GitRepositoryFence} deps.fence - the repository fence.
 * @param {object} deps.config - the resolved plugin config.
 */
export function applyGitShowTool(ctx, deps) {
  ctx.tools.register(defineTool({
    name: 'git_show',
    description: 'Show one object from the repository: a commit (metadata, full message, the paths it changed and '
      + 'their content), an annotated tag (its metadata, then the object it points at), a tree (its entries) or a '
      + 'blob (its content). `ref` accepts "HEAD", a branch name, a tag, or a full or abbreviated '
      + 'object id: the ids this tool prints can be passed straight back in; ancestry syntax such as '
      + 'HEAD~1 is not implemented by the git library in this deployment. `paths` limits the change '
      + 'list of a commit to pathspecs. `content: false` reports '
      + 'the change list without reading file contents, which is the cheap call in a large commit. Binary content '
      + 'is reported as binary, and content over maxDiffBlobBytes is reported as skipped rather than truncated. '
      + 'Fails when `ref` cannot be resolved or `dir` is not a repository; a `dir` outside the session workspace is '
      + 'refused with an escalation hint.',
    parameters: {
      dir: {
        type: 'string',
        required: true,
        description: 'Repository root. Resolved against the session workspace; outside it the call is refused '
          + 'until a one-shot escalation is approved.',
      },
      ref: {
        type: 'string',
        required: true,
        description: 'The commit, tag, tree or blob to show: "HEAD", a branch name, a tag, or a full or abbreviated '
          + 'object id (the ids this tool prints can be passed straight back in). Ancestry syntax such as "HEAD~1" and '
          + 'the "<rev>:<path>" spelling are not implemented by the git library in this deployment — read the object '
          + 'id you need from git_log or from the change list this tool prints.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Pathspecs limiting which changed paths are listed and read for a commit.',
      },
      content: {
        type: 'boolean',
        description: 'Read and print the content of the changed paths (default true). Set false for a commit to '
          + 'get only the metadata and the change list.',
      },
      ...deps.fence.escalationFields(),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          ref: { type: 'string', required: true },
          oid: { type: 'string', required: true },
          type: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.ref} resolves to ${value.type} ${value.oid}\n\n${value.text}`,
      }],
    },
    async execute(args, exec) {
      let policy
      try {
        const opened = await deps.fence.open('git_show', args, exec, args.dir)
        policy = opened.policy
        const { git } = await loadGit()
        const { oid } = await resolveRevision(git, opened.fs, opened.root, args.ref)
        const described = await describeObjectGraph(git, opened.fs, opened.root, oid, {
          content: args.content !== false,
          paths: Array.isArray(args.paths) ? args.paths : [],
          maxBytes: deps.config.maxDiffBlobBytes,
          depth: 1,
        })
        return { root: opened.root, ref: args.ref, oid, type: described.type, text: described.text }
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw deps.fence.mapError(error, policy ?? await deps.fence.resolvePolicy('git_show', args, exec))
      }
    },
  }))
}
