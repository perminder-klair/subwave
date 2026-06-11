---
name: subwave-app-android-release
description: Cut a NEW Android build of the SUB/WAVE app (the Expo project in `app/`) in the cloud with EAS and get it to testers — the remote, no-cable counterpart to the iOS TestFlight skill. Use this skill whenever the user wants to "build android for testing", "release the android app", "send the android build to testers", "get a shareable install link for android", "make an apk for the testers", "submit android for testing", "ship the android app", "build a new android version", "distribute the android app", or "put android on testers' phones" — anything aimed at producing a fresh Android build and handing it out. Trigger it even when the user doesn't say "EAS" by name. The default path needs nothing from the user: EAS builds an APK and returns an install link + QR that testers tap to install directly (no Play Store). Do NOT use this skill for putting the app on a LOCAL phone over USB/adb with hot reload — that's `subwave-app-android`. Do NOT use it for the iOS app — that's `subwave-app-ios-release`. The Google Play Store track is a heavier, optional variant documented below (eas.json submit config is wired; the Play Console account setup is still pending).

---

# SUB/WAVE Android release → testers

Build a fresh Android binary in the cloud and hand it to testers. The default —
**EAS internal distribution** — needs no Google account and no cable: EAS builds
an APK, generates+stores the signing keystore for you, and gives back an install
link + QR that any Android phone can tap to install. This is the practical
"Android testing" path and the one you almost always want.

For testers across the room or across the world, this beats the local
`subwave-app-android` skill (which is USB/adb to a phone you can physically plug
in). Reach for that one only when you want live hot-reload on your own device.

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

## The release — one command

```bash
cd "$APP"
eas build --platform android --profile preview --non-interactive
```

That's it. It:
1. Generates the Android keystore on EAS the first time (no prompt — Android
   keystores are self-signed, so unlike iOS certs this needs no TTY), and reuses
   it every build after.
2. Builds the APK on EAS servers (~10–15 min).
3. Prints an **install link + QR** for an internal-distribution APK.

When it finishes it shows something like:

```
🤖 Open this link on your Android devices (or scan the QR code) to install:
https://expo.dev/accounts/pinku1/projects/subwave/builds/<BUILD_ID>
```

That **build page is the install page** — testers open it on their phone, tap
**Install**, and approve the one-time "install from this source / unknown
sources" prompt (expected for anything outside the Play Store). The raw `.apk` is
also linked from the build page if someone wants to download it directly.

### Detached variant (don't block the session on a 15-min build)

```bash
cd "$APP"
eas build --platform android --profile preview --no-wait --non-interactive
# grab the BUILD_ID from the output, then:
eas build:view <BUILD_ID>          # Status + the Application Archive (.apk) URL
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

## Optional: Google Play Store testing track (config wired; account setup pending)

If you want testers to install through the **Play Store** (the true TestFlight
parallel) instead of a link, the **`eas.json` side is already done**:
`submit.production.android` points at `./secrets/play-service-account.json`
(gitignored) with `track: internal`, `releaseStatus: draft`. The data-safety
form answers are pre-drafted in `app/docs/store/PLAY-DATA-SAFETY.md`.

What's **still needed** is the operator-only account setup (see
`app/docs/PRODUCTION-READINESS.md` Phase D for the full ordered checklist):

1. A **Google Play Console** developer account ($25 one-time; identity
   verification can take days — start it first).
2. **Manually create the app** `com.getsubwave.app` in Play Console — Google has
   no API to create the app record (unlike App Store Connect, which EAS can
   create). Enroll in Play App Signing.
3. A **Google service-account JSON key** with Play Developer API access, dropped
   at `app/secrets/play-service-account.json` (the path `eas.json` already
   expects — kept out of git by the `secrets/` ignore).
4. The very first `.aab` must be uploaded **manually** through the Console for a
   brand-new app; the API submit only works afterwards.
5. Personal developer accounts need a **closed test** (≈12 testers / 14 days)
   before production access — verify the current policy in the Console.

Once those exist, build the bundle and submit to the internal track:

```bash
cd "$APP"
eas build  --platform android --profile production --non-interactive   # builds .aab
eas submit --platform android --profile production --non-interactive    # uses eas.json
```

Until the account side is done, stick with the internal-distribution link above.

## Things that bite

- **Wrong directory.** `eas` needs `eas.json`, which is in `app/`. Always
  `cd "$APP"` first.
- **`preview` = APK for the link; `production` = AAB for Play.** Don't send an
  `.aab` to testers directly — phones can't install App Bundles; the internal
  APK is what's installable.
- **Unknown-sources prompt is normal.** Sideloaded (non-Play) installs trigger a
  one-time per-source permission on the device. Approve it.
- **Guard the EAS keystore if you ever go to Play.** Google permanently binds an
  app to its upload key. EAS stores the keystore, but back it up
  (`eas credentials --platform android`) before you commit to a Play release, or
  you can lock yourself out of updates.
- **This is cloud, not adb.** For live hot-reload on a tethered phone, use
  `subwave-app-android` instead.

## Quick reference

| Want | Do |
|---|---|
| Ship a **JS-only** change (no new build) | `cd "$APP" && eas update --channel preview --message "…"` (or `production`) |
| Build + shareable install link for testers | `cd "$APP" && eas build -p android --profile preview --non-interactive` |
| New app version first | edit `expo.version` in `app/app.json`, commit, then build |
| Queue without waiting | add `--no-wait`, then `eas build:view <id>` |
| Get the .apk / install link of a build | `eas build:view <id>` (Application Archive URL) |
| List recent builds | `eas build:list --platform android` |
| Play Store track (after setup) | `eas build -p android --profile production` then `eas submit -p android --profile production` |
| Confirm login | `eas whoami` (expect `pinku1`) |
