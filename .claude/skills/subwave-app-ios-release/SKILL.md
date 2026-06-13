---
name: subwave-app-ios-release
description: Cut a NEW iOS build of the SUB/WAVE app (the Expo project in `app/`) and ship it via EAS — to TestFlight, and on to the live App Store. The app is LIVE in production on the App Store, so a release is build+submit (one command) then a manual "promote to production" step in App Store Connect. Use this skill whenever the user wants to "submit a build", "release iOS again", "push a new TestFlight build", "ship the iOS app", "release to the App Store", "cut an iOS release", "build and submit for iOS", "send a new build to testers", "deploy the iOS app", "bump the iOS build", or any equivalent phrasing aimed at getting a fresh iOS build out. Trigger it even when the user doesn't say "EAS" or "TestFlight" by name — if they want a new iOS build out, this is the path. The one-time pieces (EAS project link, signing certs, App Store Connect app record, eas.json) already exist, so the build is essentially one command. Do NOT use this for the Android app (that's `subwave-app-android`), for running on a simulator/dev (`expo run:ios`), or for first-time EAS/Apple account setup.
---

# SUB/WAVE iOS release → TestFlight

Build a fresh iOS binary in the cloud and push it to TestFlight. All the
painful one-time setup is already done — signing credentials live on EAS, the
App Store Connect app record exists, and `eas.json` is wired — so a normal
release is a single command. This skill is about doing it again, reliably, and
knowing what to check.

## Why this is now easy

The first release required interactive setup (creating a distribution
certificate, registering the App Store Connect app). That's finished. EAS stores
the credentials server-side and `app/eas.json` pins the submit target, so repeat
builds run **non-interactively** — no Xcode, no Apple login prompts, no TTY.

## First: does this even need a new build? (OTA)

The app ships **expo-updates** (OTA). If the change is **JS/TS only** —
components, hooks, styles, copy, logic, Metro-bundled assets — you do **not** need
a TestFlight build at all. Push it over-the-air to the binaries already out there:

```bash
cd "$APP"
eas update --channel production --message "fix: …"   # testers first: --channel preview
```

It reaches every installed build whose **runtime version (fingerprint)** matches —
i.e. any build with the same native code. Testers see it on the **next cold
start** (it fetches in the background; `fallbackToCacheTimeout: 0` keeps launch
instant, so killing + relaunching twice is how you confirm it applied).

A **new binary is only required when native inputs changed**: a dependency
add/upgrade, anything under `app/patches/`, a config plugin, or `app.json`'s
`ios`/`infoPlist`/`plugins` sections. The fingerprint policy guarantees an OTA
can't land on a binary with mismatched native code, so you can't break a build
this way. Rule of thumb: **ran `npx expo install` or touched `patches/`? → build a
binary. Otherwise → OTA.** Full decision table + fingerprint debugging:
`app/docs/RELEASE.md`.

The rest of this skill is the **binary** path (native change, or a store release).

## Fixed facts about this app

Derive the repo root once; don't hardcode it. The Expo project and `eas.json`
live in `app/`, and **every `eas` command must run from there**.

```bash
REPO=$(git -C "<this skill's base directory>" rev-parse --show-toplevel)
APP="$REPO/app"   # eas.json lives here — cd into it before any eas command
```

| Thing | Value |
|---|---|
| EAS project | `@pinku1/subwave` (Expo account `pinku1`) |
| Bundle identifier | `com.getsubwave.app` |
| App Store Connect App ID | `6778786696` |
| Apple Team | `BU9RD766GN` (Individual) |
| Build profile | `production` (store distribution, `autoIncrement` on) |
| OTA channel | `production` — JS-only updates via `eas update` (see OTA section above) |
| Runtime version | `fingerprint` policy — hashes native deps + `patches/` so OTAs only reach matching binaries |
| Version source | `remote` — EAS owns the **build number**; never bump it by hand |
| TestFlight page | https://appstoreconnect.apple.com/apps/6778786696/testflight/ios |

`eas.json` → `submit.production.ios` already carries `ascAppId` + `appleTeamId`,
which is what makes submit non-interactive. Leave it intact.

## Preflight (10 seconds)

```bash
cd "$APP"
eas whoami        # expect: pinku1   (if not logged in: eas login)
```

If `eas` isn't found, install it: `npm i -g eas-cli`.

## The release — one command

Build in the cloud and auto-submit to TestFlight when the binary is ready:

```bash
cd "$APP"
eas build --platform ios --profile production --auto-submit --non-interactive
```

That's the whole thing. It:
1. Increments the build number on EAS (because `autoIncrement` + remote
   versions), so each release is a distinct TestFlight build.
2. Builds the `.ipa` on EAS servers (~7–15 min) using the stored distribution
   cert + provisioning profile.
3. On success, submits straight to App Store Connect using the pinned
   `ascAppId` + EAS-stored App Store Connect API key.

The command stays attached and streams progress. If you'd rather not hold the
session, add `--no-wait` and monitor separately (see below) — but then submit
won't auto-chain, so you'd submit by build id afterwards.

### Detached variant (don't block the session on a 15-min build)

```bash
cd "$APP"
# Queue the build, return immediately
eas build --platform ios --profile production --no-wait --non-interactive
# Grab the build id from the output, then watch it:
eas build:view <BUILD_ID>          # Status: new → in queue → in progress → finished
# Once finished, submit that build:
eas submit --platform ios --profile production --id <BUILD_ID> --non-interactive
```

Poll to completion without babysitting:

```bash
BID=<BUILD_ID>
until eas build:view "$BID" --json 2>/dev/null \
      | grep -qiE '"status":[[:space:]]*"(finished|errored|canceled)"'; do sleep 60; done
eas build:view "$BID" | grep -iE "Status|Application Archive"
```

## After it submits

The binary uploads to App Store Connect, then **Apple processes it (~5–15 min)**
before it shows in TestFlight — that part is out of our hands. Apple emails when
processing finishes. Internal testers (already in a TestFlight group) can install
as soon as it clears; external testers need Beta App Review first.

Confirm/track at the TestFlight page above, or
`https://expo.dev/accounts/pinku1/projects/subwave/builds`.

**`--auto-submit` lands the build in TestFlight, NOT on the public App Store.**
That's the right default — the build burns in with testers first. Releasing to
the public store is a deliberate, manual step (next section), so don't tell the
user the App Store is updated just because the build submitted.

## Promoting to the public App Store (live app)

SUB/WAVE is **live in production on the App Store**. EAS only gets the binary into
App Store Connect; pushing it to real users is a manual App Store Connect step —
EAS doesn't do App Store *release* (only TestFlight delivery). Once the processed
build appears under TestFlight:

1. App Store Connect → SUB/WAVE → **Distribution / App Store** tab.
2. **Create a new version** if this is a new marketing version (e.g. `1.0.1`) —
   the number must match `expo.version` in `app.json`. For a same-version
   resubmission, edit the existing version.
3. Under **Build**, attach the processed build (the one EAS just submitted).
4. Fill "What's New", then **Add for Review → Submit**. Apple review for an
   update is typically hours-to-a-day.
5. Choose phased release or immediate; it goes live when Apple approves.

So a full public release = run the build command below, wait for processing, then
do this promotion. A TestFlight-only push (testers only, no store change) stops
after the build submits.

## Bumping the version vs. just the build number

Decide which kind of release this is:

- **Another TestFlight build of a version Apple hasn't released yet** (a fix, a
  tweak still in beta): change nothing. `autoIncrement` gives it a fresh build
  number under the same `expo.version`. Just run the release command.
- **A new public App Store release** (the live-app case): you **must** bump
  `expo.version` in `app/app.json` first (e.g. `1.0.0` → `1.1.0`), commit, then
  release. The build number still auto-increments under it.

**Live-app gotcha — once a marketing version is released on the App Store, you
can't ship to the public store again under that same version.** `--auto-submit`
(or `eas submit`) will fail at the submission step with:

```
You've already submitted this version of the app.
Versions are identified by CFBundleShortVersionString (expo.version)…
```

The **build still succeeds** — only the submit is rejected — so the fix is: bump
`expo.version`, commit, rebuild. SUB/WAVE is **live on the App Store**, so treat a
version bump as **mandatory for every public release**, not optional. (TestFlight
alone would take another build under the same version; the public store will
not.) Don't query/guess the current version — read `expo.version` from
`app/app.json` and the released version from App Store Connect.

You only hand-edit `app.json`'s `version`. You never set `buildNumber` —
`appVersionSource: "remote"` means EAS is the source of truth for it, and setting
it locally would fight EAS. The current build number isn't worth recording here
either — it auto-increments every build; check `eas build:list` for the live value.

## When something needs Apple auth again (rare)

Stored credentials cover normal releases. EAS may need to re-touch Apple only on
edge cases — the distribution certificate expiring (this one lasts until
**2027-06-10**), adding a device, or regenerating a profile. If a command starts
asking to "log in to your Apple account" or for an "App Store Connect API Key",
feed it the API key instead of an interactive login:

Keep the App Store Connect API key (`.p8`) **outside the repo** and never commit
it — the `.p8`, its Key ID, and Issuer ID are the credential. Point the env vars
at wherever you store it:

```bash
export EXPO_ASC_API_KEY_PATH=/path/to/your/AuthKey_<KEYID>.p8
export EXPO_ASC_KEY_ID=<KEY_ID>
export EXPO_ASC_ISSUER_ID=<ISSUER_ID>
export EXPO_APPLE_TEAM_ID=BU9RD766GN   # already in eas.json; non-secret
# then re-run the eas command
```

Creating a brand-new distribution certificate is the one thing EAS refuses to do
headlessly — it needs a real interactive terminal. If you hit that, have the user
run the same `eas build` command via `!` (so it gets a TTY) and answer the
cert/profile prompts (Yes), then it proceeds.

## Things that bite

- **Wrong directory.** `eas` reads `eas.json`, which is in `app/`. Run from
  anywhere else and it won't find the project config. Always `cd "$APP"` first.
- **Don't hand-edit the build number.** `appVersionSource: remote` owns it.
- **Export compliance is already handled** — `ITSAppUsesNonExemptEncryption` is
  set to `false` in `app.json`, so TestFlight won't block on the encryption
  question. (The app only uses standard HTTPS.)
- **`--auto-submit` vs `--no-wait` are mutually exclusive in spirit**: auto-submit
  waits for the build then submits; no-wait returns early and skips the submit.
  Pick based on whether you want to hold the session.
- **A failed build still bumps the build number.** That's fine — build numbers
  are cheap and monotonic; a gap doesn't matter.

## Quick reference

| Want | Do |
|---|---|
| Ship a **JS-only** change (no new build) | `cd "$APP" && eas update --channel production --message "…"` |
| Ship a new build to TestFlight | `cd "$APP" && eas build -p ios --profile production --auto-submit --non-interactive` |
| **Release to the public App Store** | build+submit (above), wait for processing, then promote the build in App Store Connect (manual) |
| New app version first | edit `expo.version` in `app/app.json`, commit, then ship |
| Queue without waiting | add `--no-wait`, then `eas submit -p ios --profile production --id <id>` |
| Check a build | `eas build:view <id>` / list: `eas build:list` |
| See it in TestFlight | https://appstoreconnect.apple.com/apps/6778786696/testflight/ios |
| Confirm login | `eas whoami` (expect `pinku1`) |
