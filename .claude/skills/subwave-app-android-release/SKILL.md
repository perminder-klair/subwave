---
name: subwave-app-android-release
description: Cut a NEW Android build of the SUB/WAVE app (the Expo project in `app/`) in the cloud with EAS and ship it — to the live Google Play Store, or as a direct install link for testers. Use this skill whenever the user wants to "release the android app", "ship the android app", "push a new Play Store build", "build a new android version", "send the android build to testers", "get a shareable install link for android", "make an apk for the testers", "submit android", "distribute the android app", or "put android on testers' phones" — anything aimed at producing a fresh Android build and getting it out. Trigger it even when the user doesn't say "EAS" by name. Two paths: a **Play Store release** (`production` profile builds an `.aab`, which you upload to the Play Console by hand — the app is LIVE in production), and a **quick sideload test** (`preview` profile builds an APK + install link/QR, no Google account needed). Do NOT use this skill for putting the app on a LOCAL phone over USB/adb with hot reload — that's `subwave-app-android`. Do NOT use it for the iOS app — that's `subwave-app-ios-release`.

---

# SUB/WAVE Android release → Play Store / testers

The app is **live in production on the Google Play Store**. There are two ways to
ship a fresh Android binary, and which you want depends on the audience:

- **Play Store release (`production` profile)** — builds a signed `.aab` App
  Bundle on EAS. You then **upload it to the Play Console by hand** (submission is
  manual — see the Play Store section). This is how real users get the update.
- **Quick sideload test (`preview` profile)** — builds an APK and returns an
  install link + QR any Android phone can tap, no Google account involved. Good
  for handing a build to a trusted tester fast, outside the Play Store machinery.

Either way EAS generates+stores the signing keystore for you. **Ask which one the
user wants if it's ambiguous** — "release"/"ship to the store" → `production`
`.aab`; "send to a tester"/"install link" → `preview` APK.

For a phone you can physically plug in (USB/adb, live hot-reload), use the local
`subwave-app-android` skill instead.

## First: does this even need a new build? (OTA)

The app ships **expo-updates** (OTA). If the change is **JS/TS only** —
components, hooks, styles, copy, logic, Metro-bundled assets — you do **not** need
a new APK/AAB. Push it over-the-air to the binaries already installed:

```bash
cd "$APP"
eas update --channel preview --message "fix: …"      # tester (internal-APK) builds
eas update --channel production --message "fix: …"    # Play builds
```

It reaches every installed build whose **runtime version (fingerprint)** matches.
Testers see it on the **next cold start** (it fetches in the background;
`fallbackToCacheTimeout: 0` keeps launch instant, so kill + relaunch twice to
confirm it applied).

A **new build is only required when native inputs changed**: a dependency
add/upgrade, anything under `app/patches/`, a config plugin, or `app.json`'s
`android`/`plugins` sections. The fingerprint policy guarantees an OTA can't land
on a binary with mismatched native code. Rule of thumb: **ran `npx expo install`
or touched `patches/`? → build. Otherwise → OTA.** Full decision table:
`app/docs/RELEASE.md`.

The rest of this skill is the **build** path (native change, or a store release).

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
| Android package | `com.getsubwave.app` |
| Internal-test profile | `preview` (`distribution: internal`, `buildType: apk`, channel `preview`) |
| Play Store profile | `production` (builds an `.aab` App Bundle, `autoIncrement` on, channel `production`) |
| OTA channels | `preview` / `production` — JS-only updates via `eas update` (see OTA section) |
| Runtime version | `fingerprint` policy — hashes native deps + `patches/` so OTAs only reach matching binaries |
| Signing keystore | EAS-managed (auto-generated in the cloud, stored on EAS) |

## Preflight (10 seconds)

```bash
cd "$APP"
eas whoami        # expect: pinku1   (if not: eas login)
```

If `eas` isn't found: `npm i -g eas-cli`.

## Play Store release (the real release) — `production`

```bash
cd "$APP"
eas build --platform android --profile production --non-interactive   # builds the .aab
```

It:
1. Reuses the EAS-stored keystore (generated once, self-signed — no TTY needed).
2. Auto-increments `versionCode` (`autoIncrement` on the `production` profile).
3. Builds a signed **`.aab` App Bundle** on EAS (~10–15 min) and links it on the
   build page as the **Application Archive**.

**Submission is manual.** This project uploads the `.aab` to the Play Console by
hand — there's no `play-service-account.json` on this machine, so `eas submit`
won't run headlessly here, and the operator's flow is a manual Console upload.
When the build finishes:

1. Open the build page (`eas build:view <id>` → Application Archive URL) and
   download the `.aab`.
2. Play Console → SUB/WAVE (`com.getsubwave.app`) → **Production** (or a testing
   track) → **Create new release** → upload the `.aab` → review → roll out.

Data-safety form answers are pre-drafted in `app/docs/store/PLAY-DATA-SAFETY.md`.
A new **marketing version** (what users see) comes from `expo.version` in
`app/app.json` — bump + commit it before building; `versionCode` auto-increments
on its own.

> If you ever wire automated submit: drop the Google service-account JSON at
> `app/secrets/play-service-account.json` (gitignored; the path `eas.json`'s
> `submit.production.android` already expects) and then
> `eas submit --platform android --profile production --non-interactive` pushes to
> the `internal` track as a `draft`. Until that file exists, upload manually.

## Quick sideload test (skip the store) — `preview`

For handing a build straight to a tester without the Play Store:

```bash
cd "$APP"
eas build --platform android --profile preview --non-interactive
```

Builds an **APK** + prints an **install link + QR**:

```
🤖 Open this link on your Android devices (or scan the QR code) to install:
https://expo.dev/accounts/pinku1/projects/subwave/builds/<BUILD_ID>
```

That **build page is the install page** — testers open it on their phone, tap
**Install**, and approve the one-time "install from this source / unknown
sources" prompt (expected for anything outside the Play Store). The raw `.apk` is
also linked from the build page if someone wants to download it directly.

### Detached variant (don't block the session on a 15-min build)

Works for either profile — swap `preview`/`production`:

```bash
cd "$APP"
eas build --platform android --profile production --no-wait --non-interactive
# grab the BUILD_ID from the output, then:
eas build:view <BUILD_ID>          # Status + the Application Archive (.aab/.apk) URL
```

Poll to completion without babysitting:

```bash
BID=<BUILD_ID>
until eas build:view "$BID" --json 2>/dev/null \
      | grep -qiE '"status":[[:space:]]*"(finished|errored|canceled)"'; do sleep 60; done
eas build:view "$BID" | grep -iE "Status|Application Archive"
```

## Sharing the build

The install link works for anyone you send it to — there's no per-tester
allow-list like TestFlight, so treat the link as "anyone with it can install."
That's fine for a small trusted group. The build (and its link) stays available
on EAS; you don't need to rebuild to re-share.

## Bumping the version vs. just rebuilding

- **Another test build of the same version** (the common case): change nothing
  and rebuild — internal APKs install over each other regardless of build number.
- **New marketing version** (e.g. `1.0.0` → `1.0.1`, what testers see): edit
  `expo.version` in `app/app.json` first, commit, then rebuild.

You don't hand-edit `versionCode` — the `production` profile's `autoIncrement`
owns it (it only matters for the Play Store path; internal APKs don't care).

## Things that bite

- **Wrong directory.** `eas` needs `eas.json`, which is in `app/`. Always
  `cd "$APP"` first.
- **`preview` = APK for the link; `production` = AAB for Play.** Don't send an
  `.aab` to testers directly — phones can't install App Bundles; the internal
  APK is what's installable.
- **Unknown-sources prompt is normal.** Sideloaded (non-Play) installs trigger a
  one-time per-source permission on the device. Approve it.
- **Guard the EAS keystore — the app is already on Play.** Google permanently
  binds the app to its upload key; lose it and you can't ship updates. EAS stores
  the keystore, but keep an offline backup (`eas credentials --platform android`).
- **`eas submit` won't work headlessly here.** No `play-service-account.json` is
  present, so the Play upload is manual via the Console. Don't tell the user a
  build "submitted to Play" — it built an `.aab` they still upload by hand.
- **This is cloud, not adb.** For live hot-reload on a tethered phone, use
  `subwave-app-android` instead.

## Quick reference

| Want | Do |
|---|---|
| Ship a **JS-only** change (no new build) | `cd "$APP" && eas update --channel production --message "…"` (testers: `--channel preview`) |
| **Play Store release** (.aab → manual upload) | `cd "$APP" && eas build -p android --profile production --non-interactive`, then upload the `.aab` in Play Console |
| Build + shareable install link for a tester | `cd "$APP" && eas build -p android --profile preview --non-interactive` |
| New app version first | edit `expo.version` in `app/app.json`, commit, then build |
| Queue without waiting | add `--no-wait`, then `eas build:view <id>` |
| Get the .aab / .apk of a build | `eas build:view <id>` (Application Archive URL) |
| List recent builds | `eas build:list --platform android` |
| Confirm login | `eas whoami` (expect `pinku1`) |
