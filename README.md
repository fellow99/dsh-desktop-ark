[中文](./README_zh.md) | English

# DSH Desktop · HarmonyOS Edition

> The **official DeepSeek Harness (dsh) Web UI, unmodified**, running on HarmonyOS 2in1 / tablet inside the system **ArkWeb** — with the dsh Host on a **real Node.js runtime embedded in the same process**. No Electron, no bundled Chromium, no ArkUI rewrite.

<p align="center">
  <img src="https://img.shields.io/badge/release-0.2.1-4D6BFE" alt="Version">
  <img src="https://img.shields.io/badge/dsh-dsh--v0.2.1--rc.2-7C5CFF" alt="dsh version">
  <img src="https://img.shields.io/badge/HarmonyOS-API%2024-0A59F7" alt="HarmonyOS API 24">
  <img src="https://img.shields.io/badge/Node-v24.2.0-5FA04E" alt="Node 24.2.0">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F" alt="MIT">
</p>

## What you get

- **The same dsh you already know** — sessions, tools, plugins, settings, themes. The frontend is upstream, untouched; the agent host runs locally, so there is no relay, no CORS, no account gate.
- **Nothing to render with** — the system WebView draws the UI, so the package ships only the agent runtime (≈42 MB payload) instead of a browser engine. The HAP is ≈88 MB.
- **Installs without restricted permissions** — the default build is JIT-free (`compat`), so side-loading needs no ACL-bound permission. A `jit` variant exists for devices granted the writable-code-memory permission.
- **Zero upstream changes** — HarmonyOS differences live in an `ohos` profile, one bundle layer, seam plugins and six audited shims. Upgrading dsh means re-running the pipeline, not re-doing patches.
- **Branded as this product** — own icon, name and window title; the upstream preview notice and the DeepSeek first-run dialog no longer open by themselves (both remain reachable in Settings).

## Two HarmonyOS editions

HarmonyOS gets **two independent editions** with the same shell architecture, the same unmodified Web UI and the same data plane; the difference is **which runtime provides Node**:

| | **HarmonyOS Edition** (this repo) | **Electron on HarmonyOS Edition** ([`dsh-desktop-hos`](../dsh-desktop-hos)) |
|---|---|---|
| Renderer | The system **ArkWeb** — nothing bundled | Chromium, shipped inside Electron 37 |
| Node.js | `libnode.so` started in the app's own process (v24.2.0) | Inside the Electron runtime (Node 22.17) |
| Runtime plumbing | [`ohos-node-bridge`](../ohos-node-bridge) | [`harmonypc-electron`](../harmonypc-electron) |
| Upstream dsh patches | **0** — profile + bundle layer + audited shims | 13 source patches |
| Install requirement | none (JIT-free default) | JIT restricted permission (ACL) |
| Package size | ≈88 MB | Electron-sized (hundreds of MB) |
| Maturity | 0.2.1 — device-verified on HarmonyOS 6.1.0.135 (API 24) | 0.2.1 — device-verified (0.2.0 baseline) |

Neither replaces the other: the Electron edition buys maximum desktop fidelity at the cost of a bundled Chromium and JIT; this edition buys a small payload and a permission-free install at the cost of covering platform gaps in the shim layer.

## Capabilities at a glance

| Area | State |
|---|---|
| dsh Web UI, sessions, tools, skills, subagents | ✅ works as upstream |
| File read / write / edit, image attachments | ✅ |
| Workspace picker with Documents & Downloads (grant → read/write) | ✅ |
| Git (21 tools, pure JS, no `git` binary needed) | ✅ |
| Local plugins loaded from the profile, own branding | ✅ |
| Command execution (`bash`) | ⚠️ executor ships; a path-resolution fix is pending |
| Content search (`grep` / `glob`) | ⚠️ needs a pure-JS backend (no `ripgrep` binary on arm64) |
| Delete / move / copy / chmod | ⚠️ upstream `ctx.fs` has no such primitives yet |
| Plugin marketplace, tray icon, window-state memory | — not in this edition |

The complete matrix — every capability, both editions side by side, with root causes — is [`docs/鸿蒙环境能力清单-0.2.1.md`](docs/鸿蒙环境能力清单-0.2.1.md).

## Status

`0.2.1` (`versionCode` 201) — **runs on device**. Verified on HarmonyOS 6.1.0.135 (API 24, 2in1): installs with zero ACLs, the payload self-extracts and reports `ready`, all shims install, `node:sqlite`/FTS5 available, text and image conversations, workspace picker across the three roots, git clone (public and intranet), and the branded window (checked through the WebView debugger). Known gaps and their fix points are listed in the capability inventory above.

## Build

Prerequisites: DevEco **Command Line Tools** (SDK API 24), the sibling submodules `../ohos-node-bridge` and `../deepseek-harness`, and a provisioned Node runtime.

```bash
bash scripts/build-bridge-har.sh    # ① Node runtime bridge → libs/@fellow99/node-bridge.har
bash scripts/provision-runtime.sh   # ② libnode.so + ELF gates + SHA-256
node scripts/assemble-payload.mjs --deploy --apply   # ③ materialize the dsh runtime
bash scripts/build-hap.sh           # ④ payload archive + HAP build/sign
hdc app install -r entry/build/default/outputs/default/entry-default-signed.hap
```

`OHOS_CLT` overrides the Command Line Tools root; `node scripts/verify-upstream.mjs` proves the upstream pin is intact (tag, clean tree, patch ids, brand/onboarding gates).

## Docs

| Document | What it answers |
|---|---|
| [Capability inventory 0.2.1](docs/鸿蒙环境能力清单-0.2.1.md) | What works, what does not, and how this compares to the Electron edition |
| [Engineering plan](docs/000-工程规划.md) | Why this architecture, what was rejected, and the shim whitelist |
| [On-device notes](docs/010-真机调试记录.md) | What broke on the device and how it was diagnosed |
| [JIT and ACL](docs/ACL配置.md) · [JIT-less decision](docs/109-jitless-方案决策.md) | The two runtime forms and what each costs |
| [Specifications](specs/README.md) | 11 spec modules (101–109, 204, 205) with plans and gates |

## Related

- [`dsh-desktop`](../dsh-desktop) — Electron shell for Windows / Linux / macOS
- [`dsh-desktop-hos`](../dsh-desktop-hos) — Electron on HarmonyOS Edition
- [`ohos-node-bridge`](../ohos-node-bridge) — the ArkTS library that embeds Node (`node::Start`)
- [`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) — the wrapped agent host

## License

[MIT](./LICENSE)
