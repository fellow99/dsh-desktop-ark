English | [中文](./README_zh.md)

# `@dsh-ohos/git`

> The **git plugin** of DSH Desktop (HarmonyOS / Ark edition): it embeds the pure-JS [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) into the host process so a device **without a `git` binary** can still do version control. Same contract as the Electron edition (`dsh-desktop-hos/plugins/harmony-plugin-git`).

## What ships

| Face | Content |
|---|---|
| Host (`lib/index.js`) | **21 tools**: `git_init` `git_clone` `git_status` `git_diff` `git_log` `git_show` `git_add` `git_commit` `git_branch` `git_checkout` `git_reset` `git_merge` `git_cherry_pick` `git_revert` `git_stash` `git_tag` `git_remote` `git_fetch` `git_pull` `git_push` `git_config` |
| Client (`lib/client.js`) | Settings page “Git credentials”: save / show state / remove (`settings.section`, id `git-credentials`) |

One `insert` row in `@dsh-ohos/bundle` delivers both: the tools register on the host plane, and the page is discovered through the `dsh.client` declaration.

## Configuration (`Config`, schemastery)

| Key | Default | Meaning |
|---|---|---|
| `authorName` | `yourname` | Commit/merge author name. **Deliberately a placeholder**; real identities come from `git_config` writing repository-local config |
| `authorEmail` | `yourname@somehost` | Same rationale |
| `maxDiffBlobBytes` | `1048576` | Per-file cap for `git_diff`; larger blobs are reported as skipped, never silently truncated |
| `networkTimeoutMs` | `300000` | Wall-clock budget for one network operation (clone/fetch/pull/push) |

## Credentials

- Reference name: `GIT_CREDENTIAL_<HOST>` where `<HOST>` is `host[:port]` upper-cased with every non-alphanumeric replaced by `_`; value is `username:password` split on the **first** `:`.
- Source priority: a host saved in Settings is read **from the dsh credential store**; everything else is read **from `<DSH_HOME>/.git-credentials`** (git's own format — one userinfo URL per line, `0600`, hand-editable).
- Credentials actually used by a tool are **mirrored back** to that file on a best-effort basis (a read-only or full config dir never fails the operation) — copy `$DSH_HOME` elsewhere and another `git` can reuse them.
- Nothing plaintext reaches the conversation, the logs or `cordis.patch.yml`; remote URLs are scrubbed of userinfo before they are printed.
- Identity (`user.name`/`user.email`) never goes into the credential store.

## Fence

Every call first resolves `dir` through `ctx.fs` into the absolute **repository root**, and every later I/O is confined to it (lexical check plus `realpath`):

- root inside the session workspace → runs freely;
- root outside it → `FS_SANDBOX_DENIED` with the shared marker and the same-turn escalation hint; a retry carrying `sandbox_permissions` + `justification` goes through the existing approval channel, once.

**Accepted trade-off**: writes *inside* the repository do not pass `fs-sandbox.checkedTarget` one by one; the fence is a single point at the repository root (stricter than the `bash` tool, which has no fs fence at all).

## Dependency materialization (build time, required)

`isomorphic-git` is **not committed**; `collectGitRuntime()` in `scripts/assemble-payload.mjs` materializes it into this package's **nested** `node_modules/`:

```
<stage>/node_modules/@dsh-ohos/git/node_modules/isomorphic-git@1.44.2   ← 55 packages / ≈8.4 MiB
```

- Nested, not flattened: the payload top level already carries `pako@0.2.9` and friends — flattening would overwrite them and break upstream.
- `diff` is **not** materialized: four upstream packages already declare `diff ^9.0.0`, so the payload top level has `diff@9.0.0`. This package only declares it as a peer (a second copy would shadow it and add 0.8 MiB).
- The version pin lives in the assembly script; `lib/runtime.js` asserts it at load time.

## Known limitations

- **`rebase` is not delivered** (isomorphic-git has no such primitive).
- **No SSH**: HTTPS username/password only; `git@host:path` and `ssh://` are rewritten to https by the library (dropping the username).
- Pure-JS performance: cloning a large repository is visibly slower than native git, and this project's `--jitless` profile makes it slower still (`depth`/`singleBranch`/`noTags` are the mitigations).
- Binary files are reported as `Binary files … differ`, with no content-level diff.
- SHA-1 repositories only.
- The page cannot enumerate references (the credential API has no enumeration surface), so the "hosts you have entered" list lives in page `localStorage`; the page origin changes on every start, which empties that list after a restart (the credentials themselves are unaffected).
- A plaintext `http://` remote sends Basic credentials base64-encoded over the wire; use `https://` in production.

## Tests

```bash
node --test packages/git-ohos/test/*.test.mjs
```

- `test/fs-adapter.contract.test.mjs`: every promises method must be an `AsyncFunction` (a synchronous throw makes isomorphic-git treat the adapter as callback-style and **hangs every git call forever**), the dialect probe, and escape refusal.
- `test/git-credentials.test.mjs`: parsing, matching, writing and removing `.git-credentials`, plus `0600`.

Specification and device evidence: `specs/204-plugin-git/`.
