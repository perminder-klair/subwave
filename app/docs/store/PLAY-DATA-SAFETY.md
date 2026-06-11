# Google Play — Data safety form answers

Transcribe these into **Play Console → App content → Data safety**. They match
the app's privacy posture (no account, no analytics, no trackers — same as
`web/app/privacy/page.tsx`) and the iOS App Privacy answers ("Data Not
Collected"). Keep this file in sync if the app ever starts transmitting data.

> Play's definition of **"collection"** is data that leaves the device. The app
> stores a little state locally (see below) but transmits none of it to any
> first-party server, so every collection/sharing answer is **No**.

## Section 1 — Data collection and security

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **No** |
| Is all of the user data collected by your app encrypted in transit? | N/A — no data is collected. (The audio stream + station API calls to the default station `getsubwave.com` are HTTPS.) |
| Do you provide a way for users to request that their data is deleted? | N/A — no data is collected. Local state is removed on uninstall, or by removing a station / signing out in-app. |

## Section 2 — Data types

**None.** Walk every category and mark *not collected, not shared*:

- Location — none
- Personal info (name, email, address, phone, IDs) — none (no account)
- Financial info — none (no purchases, no ads)
- Health & fitness — none
- Messages / contacts / calendar — none
- Photos / videos / audio files — none (the app *plays* a remote stream; it
  records nothing and reads no media files)
- App activity / browsing — none (no analytics SDK)
- App info & performance (crash logs, diagnostics) — none (no crash reporting)
- Device or other IDs — none (no advertising ID, no device fingerprinting)

## Section 3 — Ads & families

- Contains ads: **No**
- Designed for families / target audience: general audience (see Content rating).

## What the app stores **on-device only** (not "collected" per Play)

For transparency / review notes — none of this is transmitted to us:

- **Station list + active station** — `AsyncStorage` key `subwave.stations.v1`
  (`src/lib/station.ts`): the public station base-URLs the listener has tuned to
  (e.g. `https://www.getsubwave.com`) plus a most-recently-used list. Public URLs,
  no secrets — cleared on uninstall.
- **Theme override** — `AsyncStorage` key `subwave.theme.override.v1`
  (`src/theme/ThemeContext.tsx`): the listener's chosen colour palette id.

## Network behaviour (for the review notes box)

The app is a **client for self-hosted SUB/WAVE radio stations**. All traffic is
**direct device → the station the listener chose** (audio at `/stream.mp3`, a few
read-only JSON endpoints like `/now-playing`, `/state`, `/health`). There is no
SUB/WAVE-operated backend collecting anything, no third-party analytics, and no
ad network. The default station (`getsubwave.com`) is served over HTTPS; a
listener may add their own station by address.
