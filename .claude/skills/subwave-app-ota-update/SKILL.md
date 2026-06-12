---
name: subwave-app-ota-update
description: Ship a JS/TS-only change to the already-installed SUB/WAVE app (the Expo project in `app/`) over-the-air via EAS Update — no new TestFlight/Play build, no store round-trip. Use this skill whenever the user wants to "send an OTA update", "push this over the air", "ship these changes without a new build", "eas update", "hotfix the app", "do we need a build or can we OTA this?", "publish to the preview/production channel", "get my last commit out to testers", or asks "will my TestFlight / Android beta build get this update?". Trigger it even when the user doesn't say "OTA" or "EAS" by name — if they changed app code and want it on people's phones quickly, this is the path. The skill judges OTA-eligibility (JS/asset change vs. a native change that needs a real build), publishes to a channel, and verifies which installed builds will actually receive it. Do NOT use this when native inputs changed (a dependency add/upgrade, anything under `app/patches/` or `plugins/`, or `app.json` native sections) — that needs a binary, which is `subwave-app-ios-release` / `subwave-app-android-release`. Also not for local dev/USB runs.
---

# SUB/WAVE app — OTA update (EAS Update)

Push a **JS/TS-only** change to the app binaries already on people's phones,
without building or submitting anything. The app ships `expo-updates`; an
`eas update` bundles the current JS + Metro assets and serves them to matching
installs, who pick them up on next launch. Most changes (UI, hooks, copy, logic,
styles) go out this way in ~1 minute instead of a 15-min build + store round-trip.

This skill covers the **whole OTA loop**: decide if the change is even
OTA-eligible, publish it to the right channel, and confirm which installed builds
will actually receive it (the question that always comes up — "will my TestFlight
build get this?").

The authoritative reference with the full decision table and fingerprint
debugging is [`app/docs/RELEASE.md`](../../../app/docs/RELEASE.md). This skill is
the hands-on OTA path; for a **binary** build read the release skills instead
(see "When you actually need a build" below).

## Fixed facts

Derive the repo root; don't hardcode paths. `eas.json` + `app.json` live in
`app/`, and **every `eas` command must run from there.**

```bash
REPO=$(git -C "<this skill's base directory>" rev-parse --show-toplevel)
APP="$REPO/app"   # cd here before any eas command
```

| Thing | Value |
|---|---|
| EAS project | `@pinku1/subwave` (Expo account `pinku1`) |
| Updates URL | `https://u.expo.dev/b834b64c-f694-4f45-b3fa-0f2c0a4df5ba` (in `app.json`) |
| Channels | `preview` (tester builds) and `production` (TestFlight / Play) |
| Runtime version | `fingerprint` policy — an OTA only reaches builds whose native fingerprint matches (see below) |
| Apply behaviour | `checkAutomatically: ON_LOAD` + `fallbackToCacheTimeout: 0` — fetches in background, applies on the **next** cold start |

## The one decision: can this go OTA, or does it need a build?

An OTA can only carry **JS, TS, and Metro-bundled assets**. It cannot carry
native code. EAS enforces this with the `fingerprint` runtime policy: it hashes
the native inputs, and an update only installs on a binary whose hash matches — so
you physically *can't* ship mismatched native code, but you also can't sneak a
native change out via OTA.

Judge it from what the change actually touched:

```bash
cd "$APP"
git log -1 --stat        # or: git diff --stat <base>..HEAD
```

| The change touched… | Ship via |
|---|---|
| **`app/src/**` only** — components, hooks, styles, copy, business logic, JS/TS assets | ✅ **OTA** (this skill) |
| `package.json` deps (ran `npx expo install …`), anything under `app/patches/` or `plugins/`, `app.json` `ios`/`android`/`infoPlist`/`plugins`/`expo-build-properties` | ❌ **New build** — fingerprint shifts; old binaries can't receive it. Use the release skills. |

Rule of thumb: **only `src/**` (and other Metro-bundled assets) changed → OTA.
Ran `expo install` or edited `patches/`/`plugins`/native `app.json` → build.** When
unsure, the stat output is the tell — if every changed path is under `app/src/`,
it's OTA.

## Preflight (10 seconds)

```bash
cd "$APP"
eas whoami        # expect: pinku1   (if not: eas login)
```

Optionally typecheck before shipping — `tsc --noEmit` is the project gate and an
OTA pushes whatever's in the working tree's bundle:

```bash
npm run typecheck
```

## Publish

**Recommended flow: preview first, then production.** Push to `preview`, sanity-
check it on a preview build, then promote the same change to `production`. Ship
straight to `production` only when the user explicitly asks or the change is
already verified locally.

### The command — and the non-interactive gotcha

From a real terminal (TTY) the simple form prompts as needed:

```bash
cd "$APP"
eas update --channel preview --message "fix: …"
```

But when running **non-interactively** (this agent, CI), `eas update` has two
quirks worth knowing — both learned the hard way:

- It **requires `--environment <name>`** in non-interactive mode, or it aborts
  with *"The `--environment` flag must be set when running in `--non-interactive`
  mode."* Pass the environment matching the channel (`preview` / `production`).
- It does **not** accept `--non-interactive` (the inner expo-cli prints
  *"`--non-interactive` is not supported, use `$CI=1` instead"*). Use the `CI=1`
  env var to force non-interactive instead of the flag.

So the form that reliably works headlessly:

```bash
cd "$APP"
CI=1 eas update --channel preview --environment preview --message "fix: …"
# promote later:
CI=1 eas update --channel production --environment production --message "fix: …"
```

A line like *"No environment variables with visibility … found for the
'production' environment"* is **harmless** — it just means EAS has no stored
build-time env vars for that environment. The app reads its config at runtime, so
nothing is missing.

`eas update` publishes **per platform** and, under the `fingerprint` policy,
**per runtime version** (iOS and Android have different native graphs, so you'll
see two update groups). Capture from the output, for each platform: the **branch
(= channel)**, the **runtime version**, and the **update group ID** — you need the
runtime version for the verification step.

## Verify who will actually receive it

An installed build gets an OTA only if **both** match the published update:

1. **Channel** — baked into the build at build time (`eas.json`
   `build.<profile>.channel`).
2. **Runtime version (fingerprint)** — must equal the update's runtime.

List the builds and compare against the runtime(s) `eas update` just printed.
`scripts/ota-delivery-check.sh [channel]` does this for you (defaults to
`production`):

```bash
"$REPO/.claude/skills/subwave-app-ota-update/scripts/ota-delivery-check.sh" production
```

It prints recent finished builds with their channel + runtime and flags the ones
on the target channel. Match those runtimes to the update's runtime: equal →
that build receives it.

**The trap: old builds with `channel=None` / `runtime=None`.** Early binaries
built before OTA/channels were wired in (e.g. SUB/WAVE's pre-`1.0.0 (7)` iOS /
pre-`(5)` Android builds) have no channel and no runtime — they can **never**
receive an OTA, no matter the fingerprint. Anyone on one of those needs a fresh
install from TestFlight / the Android link. Builds that show a real channel +
runtime are the ones an update can reach.

## When testers actually see it

Not instantly, by design. With `checkAutomatically: ON_LOAD` and
`fallbackToCacheTimeout: 0`, launch **never blocks** on the update fetch (critical
for a radio app opened in a dead zone). The app runs the cached bundle, downloads
the new one in the background, and applies it on the **next** cold start. So to
confirm an update applied: **kill the app and relaunch twice** — first relaunch
downloads, second shows the change. Tell testers the same.

## When you actually need a build instead

If the decision above lands on "native change", an OTA won't reach the old
binaries and you need a fresh binary that carries the new native code + a new
fingerprint:

- **iOS** → `subwave-app-ios-release` (EAS build → TestFlight)
- **Android** → `subwave-app-android-release` (EAS build → internal link / Play)

After that build is out, OTAs target the new fingerprint and the loop resumes.

## Things that bite

- **Wrong directory.** `eas` reads `eas.json` in `app/`. Always `cd "$APP"` first.
- **Non-interactive needs `--environment` + `CI=1`** — not `--non-interactive`. See
  the publish section.
- **Native change snuck in.** If the diff touched deps / `patches/` / `plugins` /
  native `app.json`, the fingerprint shifted: the OTA won't reach existing builds
  and you've shipped a no-op to them. Build instead.
- **`channel=None` builds never update.** Pre-OTA binaries are dead to `eas
  update`; they need a reinstall.
- **The two-relaunch apply** is expected, not a bug — it's the price of an instant,
  non-blocking launch. Verify by killing + relaunching twice.

## Quick reference

| Want | Do (`cd "$APP"` first) |
|---|---|
| Is this OTA-able? | `git log -1 --stat` — only `app/src/**`? → OTA. deps/`patches`/native `app.json`? → build |
| Push to testers | `CI=1 eas update --channel preview --environment preview --message "…"` |
| Promote to production | `CI=1 eas update --channel production --environment production --message "…"` |
| Who receives it? | `scripts/ota-delivery-check.sh <channel>`, match runtimes to the update |
| See live updates | `eas update:list` / the EAS dashboard link in the publish output |
| Need a native build | `subwave-app-ios-release` / `subwave-app-android-release` |
| Confirm login | `eas whoami` (expect `pinku1`) |
