# Device QA checklist — SUB/WAVE app

Manual pre-release checklist. There's no automated test framework, so this is the
merge gate before a store submit or a production OTA. Run it on a **candidate
build** (a `preview` or `production` binary — not a Metro dev session, which
behaves differently for background audio, interruptions, and OTA).

**Device matrix — minimum:**

- ≥1 **physical iPhone** (background audio / lock screen / CarPlay can't be judged
  on the simulator).
- ≥1 **physical Android** phone (foreground-service notification, lock-screen controls).

Mark each box per platform. Note the device + OS version you tested on.

> Tested on: iPhone __________ (iOS __) · Android __________ (Android __) · build ______

---

## Audio & background

- [ ] **iOS** / [ ] **Android** — Tune in, lock the phone / turn the screen off, leave for **30+ min**: audio keeps playing, no dropout, no silent death.
- [ ] **iOS** / [ ] **Android** — Lock-screen (and notification) shows **now-playing metadata + cover art**; on a song change the **title / artist / persona / cover swap** within a few seconds.
- [ ] **iOS** / [ ] **Android** — Lock-screen / notification controls: **Play, Pause, Stop** work. **No Skip/Next** control is present (intentional — shared live stream).

## Resilience & connectivity

- [ ] **iOS** / [ ] **Android** — **Headphone / Bluetooth unplug** pauses playback; pressing play (or replugging) **resumes at the LIVE edge**, not a stale buffered segment. _(validates A3 — `service.ts` RemotePlay re-load)_
- [ ] **iOS** / [ ] **Android** — **Phone-call interruption**: audio ducks/pauses for the call and resumes after. _(validates `autoHandleInterruptions: true`)_
- [ ] **iOS** / [ ] **Android** — **Wi-Fi → cellular switch** while tuned in: the **`CONNECTING…` / `NO CONNECTION` banner** appears and playback **reconnects within a beat** (not the full ~6s watchdog wait). _(validates A1 — `useConnectivity` proactive reconnect)_
- [ ] **iOS** / [ ] **Android** — **Airplane-mode cold start**: launch with no network → app reaches the player with a **`NO CONNECTION` banner**, **no stuck splash**, no crash. Turn network back on → banner clears, can tune in.
- [ ] **iOS** / [ ] **Android** — **Station goes off-air mid-listen**: `STATION OFF AIR` banner shows and playback stops cleanly (no spinning-forever).
- [ ] **iOS** / [ ] **Android** — Force a render error path if feasible (or note untested): the **root error boundary** shows the retry screen rather than a white screen / stuck splash, and **RETRY** recovers. _(validates A2)_

## Platform controls

- [ ] **iOS** — **CarPlay**: SUB/WAVE appears, shows now-playing, Play/Pause/Stop work.
      _(Android Auto is intentionally **not** declared — rejected by Google Play under the Auto TTS-content policy; nothing to test there.)_
- [ ] **Android** — **Kill the app** (swipe from recents): the **foreground-service notification is removed** and audio stops (`StopPlaybackAndRemoveNotification`).
- [ ] **iOS** — **AirPlay**: the route-picker button in the masthead opens the system picker; audio moves to a HomePod/Apple TV and back. Lock-screen metadata still updates while routed.
- [ ] **iOS** / [ ] **Android** — **Google Cast, connect mid-listen**: tap the cast button while tuned in → audio moves to the Cast device (phone goes silent, deck reads `Cast · <device>`), power/volume/mute now drive the device. First iOS tap shows the **Local Network permission** prompt.
- [ ] **iOS** / [ ] **Android** — **Google Cast, disconnect**: end the session from the cast dialog → playback **resumes locally** at the live edge. Sleep timer while casting stops the Cast audio when it lapses.
- [ ] **iOS** / [ ] **Android** — **Google Cast, station switch**: switching stations while casting stops remote playback (matches local behaviour); re-tune casts the new station.

## Accessibility

- [ ] **iOS** — **VoiceOver** reads the transport controls (power/tune, mute, volume) and the connection banner (`accessibilityRole="alert"`) with sensible labels.
- [ ] **Android** — **TalkBack** equivalent.

## OTA round-trip _(validates Phase B)_

- [ ] On a **`preview` binary**, make a visible JS change (e.g. tweak a label), `eas update --channel preview`.
- [ ] **Kill and relaunch the app once** — update downloads in the background (does NOT block launch; `fallbackToCacheTimeout: 0`).
- [ ] **Kill and relaunch a second time** — the **new JS is visible**. Confirms the OTA applies on the next cold start.
- [ ] Confirm the binary's **runtime version matches** the update (`npx expo-updates fingerprint:generate`) — sanity check that fingerprint OTA targeting works.

## Endurance

- [ ] **iOS** / [ ] **Android** — **Multi-hour playback** (1–2h+): no memory creep crash, no runaway battery drain, audio still live at the end.

---

## After the run

- Any failed item that isn't a release blocker → file it and note it here.
- If **A3** (live-edge resume) misbehaves on device, it's safe to revert just the
  `service.ts` RemotePlay change to a bare `play()` and ship — it's isolated and
  fully try/caught. See `PRODUCTION-READINESS.md` risk callout #4.
- If interruptions (call / becoming-noisy) fail, only then add explicit
  `AudioBecomingNoisy` / duck handlers — `autoHandleInterruptions` should cover it.
