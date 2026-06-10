---
name: subwave-app-android-release
description: Cut a NEW Android build of the SUB/WAVE app (the Expo project in `app/`) in the cloud with EAS and get it to testers — the remote, no-cable counterpart to the iOS TestFlight skill. Use this skill whenever the user wants to "build android for testing", "release the android app", "send the android build to testers", "get a shareable install link for android", "make an apk for the testers", "submit android for testing", "do open testing", "push to the Play open-testing track", "build an aab for Play", "ship the android app", "build a new android version", "distribute the android app", or "put android on testers' phones" — anything aimed at producing a fresh Android build and handing it out. Trigger it even when the user doesn't say "EAS" by name. Two distribution paths: (1) EAS internal distribution — EAS builds an APK and returns an install link + QR testers tap to install directly (no Play Store, no setup); (2) Play Store OPEN TESTING — build a `.aab` with the `production` profile and upload it (currently MANUAL — no service-account key wired yet; `eas submit` is documented for when it is). Do NOT use this skill for putting the app on a LOCAL phone over USB/adb with hot reload — that's `subwave-app-android`. Do NOT use it for the iOS app — that's `subwave-app-ios-release`.

---

# SUB/WAVE Android release → testers

Build a fresh Android binary in the cloud and hand it to testers. Two paths:

- **EAS internal distribution (APK + link)** — needs no Google account and no
  cable: EAS builds an APK, generates+stores the signing keystore for you, and
  gives back an install link + QR any Android phone can tap to install. Fastest;
  great for a small trusted group or a quick smoke test.
- **Play Store open testing (`.aab` + manual upload)** — the chosen path going
  forward for real tester distribution. The Play Console account and the app
  record for `com.getsubwave.app` already exist. Build a `.aab` with the
  `production` profile; the operator uploads it by hand to the **Open testing**
  track (no service-account key wired yet, so `eas submit` is NOT used — see
  [Play Store open testing](#play-store-open-testing-current-path) below).

Either way, for testers across the room or across the world this beats the local
`subwave-app-android` skill (USB/adb to a phone you can physically plug in).
Reach for that one only when you want live hot-reload on your own device.

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
| Internal-test profile | `preview` (`distribution: internal`, `buildType: apk`) |
| Play Store profile | `production` (builds an `.aab` App Bundle, `autoIncrement` on) |
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
owns it. `eas.json` has `appVersionSource: "remote"`, so EAS owns the canonical
`versionCode` and bumps it on every `production` build (the Play Store rejects a
re-used `versionCode`; internal APKs don't care).

## Play Store open testing (current path)

This is now the chosen path for real tester distribution. The Play Console
account and the app record for `com.getsubwave.app` **already exist**. What's
*not* wired yet is a service-account key, so submission is **manual** — EAS
builds the `.aab`, the operator uploads it by hand. No `eas submit`.

### Build the bundle

```bash
cd "$APP"
eas build --platform android --profile production --no-wait --non-interactive
# poll to completion, then grab the Application Archive (.aab) URL:
BID=<BUILD_ID>
until eas build:view "$BID" --json 2>/dev/null \
      | grep -qiE '"status":[[:space:]]*"(finished|errored|canceled)"'; do sleep 60; done
eas build:view "$BID" | grep -iE "Status|Application Archive"
```

The **Application Archive URL** is the `.aab`. Hand that link to the operator.

### Operator's manual upload (browser-only — you can't do this)

1. Download the `.aab` from the Application Archive URL.
2. Play Console → `com.getsubwave.app` → **Testing → Open testing → Create new
   release**.
3. **Upload** the `.aab`. First upload establishes **Play App Signing** — accept
   Google's managed signing; the EAS keystore stays the **upload** key.
4. Add release notes → **Save → Review release → Roll out to open testing**.
5. Share the open-testing **opt-in URL**:
   `https://play.google.com/apps/testing/com.getsubwave.app`.

**Rollout can be blocked by the one-time app-content checklist** (Dashboard →
"Set up your app"): privacy policy URL, data safety, content rating, target
audience, ads declaration. Google gates *all* tracks on these. Operator-only;
once cleared, future releases are just upload + roll out.

### Later: automate with `eas submit` (needs a service-account key)

To skip the manual upload, the operator creates a **Google service-account JSON
key** with Play Developer API access (Play Console → Setup → API access → link a
Cloud project → create service account → JSON key → grant "Release to testing
tracks"), stored **outside the repo** (suggest `~/.config/subwave/play-service-account.json`).
Then add to `eas.json` → `submit.production.android`:

```json
{ "serviceAccountKeyPath": "/path/to/play-service-account.json", "track": "beta" }
```

`track: "beta"` is the API name for the **Open testing** track (`internal` =
Internal testing, `alpha` = Closed testing, `production` = Production). Then:

```bash
cd "$APP"
eas submit --platform android --profile production --non-interactive
```

Note: a brand-new app's *first* `.aab` usually must still go up manually through
the Console before the API will accept submissions; `eas submit` takes over from
the second release.

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
| Build + shareable install link for testers (APK) | `cd "$APP" && eas build -p android --profile preview --non-interactive` |
| Build `.aab` for Play open testing (manual upload) | `cd "$APP" && eas build -p android --profile production --non-interactive` |
| New app version first | edit `expo.version` in `app/app.json`, commit, then build |
| Queue without waiting | add `--no-wait`, then `eas build:view <id>` |
| Get the .apk / .aab / install link of a build | `eas build:view <id>` (Application Archive URL) |
| List recent builds | `eas build:list --platform android` |
| Open-testing opt-in URL for testers | `https://play.google.com/apps/testing/com.getsubwave.app` |
| Automate Play submit (once key exists) | wire `submit.production.android` + `track: "beta"`, then `eas submit -p android --profile production` |
| Confirm login | `eas whoami` (expect `pinku1`) |
