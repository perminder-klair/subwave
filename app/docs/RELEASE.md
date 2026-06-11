# Release runbook — SUB/WAVE app

How to ship the app: when a change can go out as an over-the-air (OTA) JS update
vs. when it needs a new store binary, the channels involved, and the exact
commands. For the step-by-step store-submission flows see the skills:

- **iOS** → `subwave-app-ios-release` (EAS build → TestFlight/App Store)
- **Android** → `subwave-app-android-release` (EAS build → internal link / Play)
- **Local Android phone over USB** → `subwave-app-android`

The bring-up plan that wired OTA + the store tracks is
[`PRODUCTION-READINESS.md`](./PRODUCTION-READINESS.md).

---

## The one decision: OTA or new binary?

Every change is one of two kinds. Get this wrong and you either ship a broken
OTA (JS that needs native code the installed binary doesn't have) or do a slow
store round-trip for a one-line fix.

| Change touches… | Ship via | Command |
|---|---|---|
| **JS / TS only** — components, hooks, styles, copy, business logic, assets bundled by Metro | **OTA** | `eas update --channel <channel>` |
| **Native** — a dependency add/upgrade, `patches/`, a config plugin, `app.json` `ios`/`android`/`infoPlist`/`plugins`, `expo-build-properties` | **New store build** | `eas build --profile production --platform <ios\|android>` then submit |

Rule of thumb: **if you ran `npx expo install <something>` or edited anything
under `patches/` or `plugins/`, it's a new binary.** Pure `src/**` edits are OTA.

### Why the runtime version protects you

`app.json` sets `runtimeVersion.policy = "fingerprint"`. EAS computes the runtime
version by **hashing the native inputs** — native deps, config plugins, the
`app.json` native sections, **and `patches/`**. An OTA only installs on a binary
whose runtime version matches. So:

- A JS-only `eas update` keeps the same fingerprint → it reaches the existing
  binaries. ✅
- The moment you change a native input (e.g. edit the RNTP patch), the
  fingerprint changes → old binaries stop receiving new OTAs, and the next store
  build carries the new native code + a new fingerprint. OTAs after that target
  only the new binary. This makes it **impossible to OTA mismatched native
  code** — the failure mode the `appVersion` policy invites (relies on a human
  remembering to bump).

Inspect / debug fingerprints:

```bash
npx expo-updates fingerprint:generate --platform ios       # or android
eas update:view                                            # what's live per branch
```

If an OTA "isn't applying," 90% of the time the device's binary has a different
fingerprint than the update — confirm with `fingerprint:generate` against the
commit the binary was built from.

---

## Channels ↔ build profiles

Channels are set in `eas.json` (`build.<profile>.channel`); EAS maps a channel to
a branch at update time.

| Profile (`eas.json`) | Channel | Output | Use |
|---|---|---|---|
| `development` / `development-device` | — | dev client | local Metro, no OTA |
| `preview` | `preview` | internal (Android APK, iOS non-sim) | tester builds; OTA test bed |
| `production` | `production` | store builds (Android AAB, iOS) | App Store / Play |

`cli.appVersionSource = "remote"`, so build/version numbers live on EAS
(`production` auto-increments). Don't hand-edit `ios.buildNumber` /
`android.versionCode`.

---

## OTA workflow

```bash
# 1. Make JS-only changes, verify locally.
npm run typecheck                                   # tsc --noEmit (the gate)

# 2. Push to testers first.
eas update --channel preview --message "fix: …"

# 3. Validate on a preview binary: kill the app, relaunch TWICE
#    (fallbackToCacheTimeout=0 means it fetches in the background and applies on
#    the *next* cold start — so the first relaunch downloads, the second shows it).

# 4. Promote the same bits to production.
eas update --channel production --message "fix: …"
```

`fallbackToCacheTimeout: 0` is deliberate — launch never blocks on the update
fetch (critical for a radio app opened in a car/dead zone). The trade-off is the
two-relaunch apply, which is why the QA step kills + relaunches twice.

> First-time only: `eas update` needs an authenticated EAS session and creates
> the `preview`/`production` branches on first push. Run `eas login` as the
> project owner (`pinku1`).

---

## Store build + submit

### iOS (App Store / TestFlight)

```bash
eas build  --profile production --platform ios
eas submit --profile production --platform ios       # submit config already in eas.json
```

Optional metadata push (name/subtitle/description/keywords/review notes live in
[`store.config.json`](../store.config.json), owner-editable):

```bash
eas metadata:push
```

Full flow + App Store Connect checklist: `subwave-app-ios-release` skill and
`PRODUCTION-READINESS.md` Phase C.

### Android (Play)

```bash
eas build  --profile production --platform android   # AAB (EAS-managed keystore)
# First AAB upload is MANUAL via Play Console UI (Play requires it before the API
# works). After production access is granted:
eas submit --profile production --platform android   # uses secrets/play-service-account.json
```

`eas submit` Android config (`eas.json` → `submit.production.android`) points at
`secrets/play-service-account.json` (gitignored). Data-safety form answers:
[`docs/store/PLAY-DATA-SAFETY.md`](./store/PLAY-DATA-SAFETY.md). Full flow +
Play Console checklist: `subwave-app-android-release` skill and
`PRODUCTION-READINESS.md` Phase D.

---

## Pre-release gate

Before any store submit or production OTA:

1. `npm run typecheck` clean.
2. `npx expo-doctor` — only the known patch-version drift may show; no new failures.
3. Run [`QA-CHECKLIST.md`](./QA-CHECKLIST.md) on a physical iPhone **and** Android.
4. For a binary: build `preview` first, OTA a visible JS change to it, confirm it
   applies (two relaunches) before cutting `production`.

## Privacy-manifest watch-item (iOS)

The app declares no `ios.privacyManifests` in `app.json` — it collects nothing,
and the libraries that touch required-reason APIs ship their own
`PrivacyInfo.xcprivacy` (React Native core, `expo-constants`, and AsyncStorage
2.2.0 → declares `FileTimestamp`/`C617.1`), which EAS aggregates at build time.
If an App Store submission is ever rejected for a missing privacy-manifest
reason, add an `ios.privacyManifests` block to `app.json` for the flagged API
category and rebuild — don't add it speculatively.
