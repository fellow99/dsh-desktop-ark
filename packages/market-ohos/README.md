# @dsh-ohos/market

Plugin-market runtime for DSH Desktop (Ark). It publishes the two services `dsh-market`
feature-detects — `desktopProfiles` and `desktopPnpm` — so marketplace installs/uninstalls run
the packaged pure-JS pnpm **inside a worker thread of this process** instead of spawning
node/pnpm children (spawned children are killed with SIGSYS on this platform).

Specs: [`specs/012-pnpm-integration`](../../specs/012-pnpm-integration/spec.md),
[`specs/201-dsh-market`](../../specs/201-dsh-market/spec.md). Design:
[`docs/pnpm+dsh-market.md`](../../docs/pnpm+dsh-market.md).

## Contract

| Service | Shape | Notes |
|---|---|---|
| `desktopProfiles` | `{ current: { name, dir } }` | `dir` comes **only** from `ctx.get('profileContext').dir`; when unusable the services are not published (the market then fails closed on its own CLI path) |
| `desktopPnpm` | `{ runPlugin(args, invokingDir, signal), probePnpm() }` | Returns `{ stdout, stderr, done, cancel }`; `args` pass through and `--dir <profile>` is appended; `invokingDir` is ignored |

One operation at a time: a second concurrent call **throws synchronously** with
`another desktop pnpm operation is already running`, which the market classifies as `busy`.

## Runtime prerequisites (provided by the Host)

| Variable | Source | Purpose |
|---|---|---|
| `DSH_PNPM_ENGINE` | `payload/host.js` → `<runDir>/node_modules/dsh-market-pnpm/bin/pnpm.cjs` | Engine entry materialized by `collectMarketPNPM()` |
| `DSH_OHOS_JITLESS_ENTRY` | `payload/bootstrap.js` → `<assetDir>/jitless/index.js` | A worker is a **new realm**: the jitless compat layer must be installed again |

## Known limits

- Under `--jitless` pnpm unpacks in pure JS; budget minutes per install (market timeout: 15 min).
- The profile lives inside the payload generation, so installed plugins do not survive a HAP
  upgrade (design §8 R6).
- `ignoreScripts: true`: plugins needing build scripts cannot be installed, and the market's
  approve-and-retry banner cannot succeed on this host.
- No `git` binary on device → `git:` sources cannot be installed.
- No in-thread fallback when a worker cannot start: pnpm's CLI is fire-and-forget, so a
  same-thread run has no decidable completion signal. The call fails with 127 and records why.

## Diagnostics

`app.log` lines prefixed `[dsh-ohos] market: …`, `globalThis.__dshOhosMarket`, and the market's
own `<profile>/.dsh-market/log.ndjson`.
