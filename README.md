[中文](./README_zh.md) | English

# DSH Desktop · HarmonyOS Edition

> The **official DeepSeek Harness (DSH) Web UI, unmodified**, running on HarmonyOS 2in1 / tablet inside the system **ArkWeb** — with the dsh Host on a **real Node.js runtime embedded in the same process**. No Electron, no bundled Chromium, no ArkUI rewrite of the Web UI.

<p align="center">
  <img src="https://img.shields.io/badge/release-0.1.0%20scaffold-4D6BFE" alt="Version">
  <img src="https://img.shields.io/badge/dsh-dsh--v0.2.1--rc.2-7C5CFF" alt="dsh version">
  <img src="https://img.shields.io/badge/HarmonyOS-API%2024-0A59F7" alt="HarmonyOS API 24">
  <img src="https://img.shields.io/badge/Node-v24.2.0-5FA04E" alt="Node 24.2.0">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F" alt="MIT">
</p>

**Status** `0.1.0` — **scaffold** (`versionCode` 100). It now compiles, packages and **boots a real payload**: `assemble-payload.mjs --deploy` materializes the upstream dsh runtime (pruned from 628.6 MiB to 151 MiB, packed into a **40.4 MB** `dsh.tar.gz`), producing an **86 MB** unsigned HAP that carries the Node runtime plus the payload. On a host Node the same tree extracts in ~13 s, stages the profile, starts the Host and serves the unmodified dsh Web UI at the token URL (**HTTP 200**) with **0** unactivated profile rows. **No HarmonyOS device verification has been done** — see [Status](#status) for exactly what is proven and what is not.

## Two HarmonyOS editions

HarmonyOS gets **two independent editions** of DSH Desktop; they share the same shell architecture, the same unmodified Web UI and the same data plane — the difference is **which runtime provides Node**:

| | **Electron on HarmonyOS Edition** ([`dsh-desktop-hos`](../dsh-desktop-hos)) | **HarmonyOS Edition** (this repo) |
|---|---|---|
| Renderer | Chromium, shipped inside Electron 37 | The system **ArkWeb** — nothing bundled |
| Node.js | Inside the Electron runtime (Node 22.17) | `libnode.so` started via `node::Start` in the app's own process (**v24.2.0**) |
| Runtime plumbing | [`harmonypc-electron`](../harmonypc-electron) | [`ohos-node-bridge`](../ohos-node-bridge) HAR |
| Upstream dsh patches | 13 (flock & hardlink fallbacks, `ctx.fs` remove / writeBytes / chmod, extra writable roots, attachment fsync, rebrand) | **0** — `ohos` profile + `@dsh-ohos/bundle` layer + audited shims |
| Web server binding | `0.0.0.0:<port>` + LAN IP with `Host`/`Origin` rewrite | `127.0.0.1:<port>`, same-origin loopback |
| Maturity | v0.2.1, device-verified on HarmonyOS 6.1.0.135 (API 24) | v0.1.0 scaffold, compiles & packages |

Neither is a replacement for the other: the Electron edition buys maximum desktop fidelity at the cost of a bundled Chromium and JIT, and this edition buys a small payload and a JIT-free runtime at the cost of covering the platform gaps in the shim layer.

## How it works — one process, one origin

```
EntryAbility (ArkTS)
  └─ libnode.so  node::Start(bootstrap.js)      ← in-process Node v24.2.0
       └─ extract resfile/dsh-payload → filesDir/payload   (marker .ready-<sha12>)
       └─ host.js: dsh Host (webserver + apiProxy + connection) on 127.0.0.1:<free port>
       └─ ready.json { schema, at, phase, port, token }
  └─ ArkWeb: loadUrl(ctx.connection.authenticatedUrl())
       └─ the standard, unmodified dsh Web UI (same-origin HTTP + WebSocket)
```

- The **payload is `resfile`** — a real on-disk directory Node can read — holding a single deterministic `dsh.tar.gz`. **Node is the only extractor**, and extraction is idempotent through the `.ready-<sha12>` marker.
- **Readiness means business readiness.** `waitUntilRunning()` only proves the runtime thread is alive, so the shell polls `ready.json` (20 × 500 ms) and requires all of: `schema === 1`, an `at` no older than the launch timestamp, a terminal `phase`, and a non-empty `token`. Only then does it load the URL.
- **Auth belongs to the Host.** The page loads `authenticatedUrl()` (`http://127.0.0.1:<port>/?token=…`); the Host itself answers `303` and sets the signed cookie. The shell takes no part in authentication, never rewrites the `Host` header, and never binds `0.0.0.0`.
- **Zero upstream changes**: platform differences are confined to an `ohos` profile, the `@dsh-ohos/bundle` YAML layer, and **five marked shims** (`DSH_OHOS_SHIM fs.link | fs.symlink | flock | sharp | node:sqlite`). Every upstream working tree stays pristine.

## Capabilities exposed to dsh

| Capability | State |
|---|---|
| `runtime.facts`, `log.hilog`, `perm.check`, `perm.request`, `perm.openAppInfo`, `shell.openExternal` | ✅ implemented |
| `fs.pickFolder`, `fs.pickFiles`, `fs.saveFile`, `notify.show`, `clipboard.readImage`, `clipboard.writeText`, `image.normalize`, `power.keepAwake` | ⚠️ placeholder — returns `{"ok":false,"error":"not-implemented","hint":…}` |

## Status

| Area | State |
|---|---|
| ArkTS shell, ArkWeb host page, launch orchestration, readiness gate, diagnostics | ✅ implemented |
| `ohos-node-bridge` HAR consumption, runtime provisioning (7 ELF gates + SHA-256), 44 MB HAP | ✅ verified by build |
| Payload pipeline (`resfile` → self-extract), 5 shims, self-check 7/7, upstream pin check | ✅ verified on the host toolchain; profile is loaded from `<runRoot>/profiles/ohos` (moved out of `$DSH_HOME` so `@dsh-ohos/*` resolves) |
| 8 `@dsh-ohos/*` seam plugins + shared host bridge (10 packages under `packages/*-ohos/`) | ✅ implemented (**partial**: no PTY, `notify.show` / `image.normalize` still ArkTS placeholders, approval presets disabled without a confining executor) |
| Real dsh payload assembly + packaging | ✅ `--deploy` (pnpm deploy → link materialization → `@deepseek-ai` completion → non-hoisted flattening → prune → overlay → assertions); 41,331 files / 628.6 MiB → **15,192 files / 151 MiB** → `dsh.tar.gz` **40.4 MB** (`sha12 db181e3b4364`); HAP **86 MB** |
| On-device verification (L1–L4, ArkWeb → `127.0.0.1`, `sh` sentinel, JIT ACL) | ⛔ not done — no device (host-Node end-to-end is green: extract → profile → `runProfile` → token URL `200`) |

## Repository layout

```
dsh-desktop-ark/
├── AppScope/                  # bundle-level config (bundleName org.fellow99.dsh.DshDesktopArk)
├── entry/
│   ├── src/main/ets/
│   │   ├── app/               # DshRuntime (launch orchestration) · Probe (liveness)
│   │   ├── common/            # Constants — single source of truth for paths and budgets
│   │   ├── host/              # HostCapabilities (14-entry capability surface)
│   │   ├── entryability/      # EntryAbility
│   │   └── pages/             # Index (the ArkWeb shell)
│   ├── src/main/resources/    # resfile/dsh-payload (build output, gitignored)
│   └── libs/arm64-v8a/        # provisioned .so files (binaries are never committed)
├── payload/                   # bootstrap.js · host.js · lib/tar-extract.js · shims/ · selfcheck.js
├── profiles/ohos/             # dsh profile + bundle layer + .npmrc
├── packages/bundle-ohos/      # @dsh-ohos/bundle (cordis.patch.yml)
├── scripts/                   # 7 scripts: HAR / runtime / payload / build / upstream pin
├── specs/                     # 26 specifications (10 root files + spec/plan for 101–108)
└── docs/                      # engineering plan and troubleshooting notes
```

## Build

Prerequisites: DevEco **Command Line Tools** (SDK API 24), the sibling submodules `../ohos-node-bridge` and `../deepseek-harness`, and a provisioned Node runtime.

```bash
# 1) bridge HAR → libs/@fellow99/node-bridge.har
bash scripts/build-bridge-har.sh

# 2) Node runtime → entry/libs/arm64-v8a (7 ELF gates + SHA-256)
bash scripts/provision-runtime.sh          # add ALLOW_MISSING=1 to build without it

# 3) payload → entry/src/main/resources/resfile/dsh-payload
node scripts/sync-payload.mjs
node scripts/package-payload.mjs
# node scripts/assemble-payload.mjs --from <built dsh tree> --apply   # real payload, still dry-run by default

# 4) HAP
bash scripts/build-hap.sh                  # --release for release mode; entry/build/default/outputs/default/

# optional: prove the upstream pin is intact (tag + 8 patch ids + clean tree)
node scripts/verify-upstream.mjs
```

`OHOS_CLT` overrides the Command Line Tools root (default `D:/oh-workspace/command-line-tools-6`); `DEVECO_SDK_HOME` overrides the SDK.

## Specifications

This repository is spec-driven: **26 documents** under [`specs/`](./specs/) — index, checklist, structure, tech, architecture, constitution (C1–C14), `overall-*` (spec / plan / data model / test cases), and one `spec.md` + `plan.md` per module (101 runtime launch, 102 payload pipeline, 103 web host, 104 host capabilities, 105 shims, 106 profiles/bundle, 107 packaging/signing, 108 diagnostics). Start at [`specs/README.md`](./specs/README.md).

## Related

- [`dsh-desktop`](../dsh-desktop) — Electron shell for Windows / Linux / macOS
- [`dsh-desktop-hos`](../dsh-desktop-hos) — **Electron on HarmonyOS Edition** (same workspace, Electron runtime)
- [`ohos-node-bridge`](../ohos-node-bridge) — the ArkTS library that embeds Node (`node::Start`) + the `runtime/` release cache
- [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) (sibling `../deepseek-harness`) — the wrapped host
- [`dsh-market`](https://github.com/dsh-market/dsh-market) (sibling `../dsh-market`) — built-in plugin marketplace

## License

[MIT](./LICENSE)
