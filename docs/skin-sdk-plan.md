# Skin SDK + standalone skin kit — plan

Status: **planned** (builds on the shell + skin architecture from #995)

## Goal

Let anyone build a SUB/WAVE player skin **without cloning this repo**, developing
against a *live station* instead of fixtures, and end up with a skin that renders
identically when it ships inside the real web player.

Two deliverables:

1. **`@subwave/skin-sdk`** — an npm package holding the skin authoring surface,
   published **from this repo by CI** (never hand-maintained elsewhere).
2. **`subwave-skin-kit`** — a new standalone repository: a thin Next.js template
   app that depends on the SDK. Skin authors click "Use this template", point it
   at any station URL, and build their skin in `skins/<id>/`.

## The decision this plan encodes

The SDK can't be types-only — rendering a skin outside this repo needs the
working runtime (core provider, shell, station client). That forces a choice
about where the shell *lives*:

- **Option A — main app consumes the published package too.** Zero drift by
  construction, but every shell iteration goes through a package version bump.
  Too slow for the pace `web/` moves at today.
- **Option B (chosen) — the SDK is a build artifact of this repo.** `web/`
  keeps its local copy and iterates freely; CI extracts + publishes the SDK on
  release. Drift is possible in principle, so it's contained by (a) the SDK
  being *generated from the same source files* the app compiles, never forked,
  and (b) the five shipped skins doubling as the contract test — they must
  build against the extracted SDK in CI.

This mirrors an existing pattern: `cli/src/assets.generated.ts` is embedded
from the root compose files by a script and verified by CI. Same discipline,
bigger artifact.

## What goes in the SDK

The exact surface skins are already restricted to (see
`web/components/skins/types.ts`) — nothing more:

| Piece | Source of truth today |
|---|---|
| Skin contract (`SkinProps`, `SkinManifest`, `SKIN_API_VERSION`) | `components/skins/types.ts` |
| Core contexts (`usePlayerFeed` / `usePlayerAudio` / `usePlayerActions`) + `PlayerCoreProvider` | `components/player/PlayerCore.tsx` |
| Minimal shell (audio element, tune-in gate, toaster, portal plumbing) | `components/player/PlayerShell.tsx`, `useTuneInGate.ts` |
| Station client (`useStationClient`, cover/avatar URLs) | `lib/stationClient.ts` |
| Shared derivations + hooks (booth lines, request slip, volume nudge) | `components/skins/shared.ts`, `sharedHooks.ts` |
| Theme tokens + lite-mode CSS (`--bg`, `--ink`, `--accent`, …, `html.lite` kill) | `app/globals.css` (extracted subset) |
| Utility hooks skins actually use (`useAnalyser`, `useCoverColors`, `useElapsed`, `useKeyboardShortcuts`, `useLiteMode`) | `lib/hooks.ts`, `hooks/*` |

Explicitly **not** in the SDK: the skin registry, admin/settings surfaces,
onboarding, landing, anything reachable only through shell internals. The
prerequisite discipline (already true on #995 and to be kept): skins import
only the barrel surface. An ESLint `no-restricted-imports` rule in `web/`
should enforce it so the boundary can't erode silently.

## The skin-kit repo

Thin by design — everything real comes from the SDK:

```
subwave-skin-kit/
  app/            # Next.js shell page: station URL picker → PlayerShell
  skins/
    example/      # one heavily-commented reference skin
    <yours>/      # author works here
  skin.config.ts  # id, name, description, skinApiVersion
  README.md       # authoring guide (contract, tokens, lite mode, tune-in gate)
```

- **Next.js, not Vite** — real skins are SSR'd in production and lite mode /
  the pre-paint skin script are layout concerns; the harness must render the
  way production does or authors ship skins that break on install.
- Points at any station via URL (the `stationClient` is runtime-URL based and
  controller CORS is wide open, so localhost dev against a remote live station
  works — see CORS notes below).
- Dev niceties: theme switcher, lite-mode toggle, simulated track-change +
  offline states for the states a live station won't produce on demand.

## Distribution of finished skins

Near-term unchanged: a finished skin lands via PR into this repo
(`components/skins/<id>/` + one registry entry), reviewed like any code —
review *is* the security model while skins compile into the web image.

The kit is deliberately the forge for a later phase: if/when runtime-loadable
skins (install from `state/`, no rebuild) prove worth building, the kit's build
step is where "emit an ESM bundle with React external" lives. Nothing in this
plan commits to that; `SKIN_API_VERSION` history between now and then is the
input for whether it's viable.

## Versioning & parity

- SDK version tracks this repo's release version; `SKIN_API_VERSION` (already
  in `types.ts`) is the compatibility gate — bumped only on breaking contract
  changes, and every skin manifest declares the version it was written against.
- CI on this repo: an `extract-skin-sdk` job builds the package from `web/`
  sources and **compiles the five shipped skins against the extracted package**
  (not against `web/` paths). Green = the SDK is complete and the contract
  holds. Publish on release tags, same trigger as image publishing.
- The kit repo pins a minor range and its example skin is smoke-built in its
  own CI.

## CORS prerequisites (done alongside this plan)

Cross-origin operation is what makes the kit possible; the audit of #995 found
the stack mostly ready, with two hardenings shipped with this doc:

- Icecast already emits `Access-Control-Allow-Origin: *` on the mounts, and
  the controller's CORS is wide open. The bundled Caddy now also guarantees
  ACAO on the stream routes (set-if-empty, so no duplicate header) in case an
  operator customises icecast.xml.
- The player engine (`usePlayer`) now owns the audio element's `crossOrigin`
  attribute: `anonymous` by default (untainted Web Audio for Subamp-class
  analysers), demoted once to a plain no-CORS request when a cross-origin
  stream errors before first playback — so a station behind a header-stripping
  BYO proxy still *plays*, and the analysers fall back to their idle visuals
  instead of the whole player failing.
- BYO operators who want cross-origin visualisers must pass/emit ACAO on the
  stream routes (Icecast sets it; don't strip it).

## Phases

1. **Now (this repo, no new infra):** authoring docs + a template skin under
   `components/skins/`; accept community skins by PR. The contract needs zero
   changes. Add the ESLint import-boundary rule.
2. **SDK extraction:** the CI job + package publish. No consumer yet except
   the contract-test build — this phase is pure de-risking.
3. **Kit repo:** create `subwave-skin-kit` from the extracted SDK, example
   skin, authoring README, template-repo setting on GitHub.
4. **Later, demand-gated:** runtime-loadable skins / community catalog.

## Open questions

- npm scope: publish under `@subwave/*` (org exists?) or unscoped
  `subwave-skin-sdk`.
- Does the SDK ship the token CSS as a file authors import, or does the kit
  fetch the active station's theme so authored skins preview against real
  operator themes? (Leaning: both — file for defaults, fetch for preview.)
- Whether `useAnalyser`'s iOS carve-outs and the Opus-probe UA logic belong in
  the SDK or stay shell-private (leaning SDK — skins shouldn't reimplement
  platform quirks).
