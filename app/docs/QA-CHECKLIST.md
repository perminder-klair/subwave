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
- [ ] **iOS** — **Output device disappears** (Bluetooth speaker powered off, or CarPlay: car turned off / cable pulled): app pauses instead of "playing" silently, and the **admin listener count decrements** within a few seconds (no phantom Icecast session). _(validates #992 — `usePlayer` route-change tune-out on `oldDeviceUnavailable`)_
- [ ] **iOS** — **AirPlay regression guard**: pick a HomePod from the in-app AirPlay button, let a crossfade pass, pick the phone back — playback keeps running on the chosen device throughout, never snapping to the built-in speaker or pausing. _(the #992 pause must fire ONLY on `oldDeviceUnavailable`, not on handoffs — 0b060a3a behavior)_
- [ ] **iOS** / [ ] **Android** — **Phone-call interruption**: audio ducks/pauses for the call and resumes after. _(validates `autoHandleInterruptions: true`)_
- [ ] **iOS** / [ ] **Android** — **Phone call / Siri while listening**: take a call (or hold the side button for Siri) mid-listen. Nothing reloads during it: the station's Icecast access log shows no new `/stream.mp3?t=…` until it ends. Afterwards the audio comes back by itself, and a new `t=` appears only if the old connection didn't survive the call. _(validates #2114 — `stream-recovery.ts` `onDuck` and its keep-watching rule)_
- [ ] **iOS** / [ ] **Android** — **Wi-Fi → cellular switch** while tuned in: the **`CONNECTING…` / `NO CONNECTION` banner** appears and playback **reconnects within a beat** (not the full ~6s watchdog wait), or keeps playing with no reload if the old connection survived the switch. _(validates A1 — `useConnectivity` proactive reconnect)_
- [ ] **iOS** / [ ] **Android** — **An hour on a healthy link**: tune in on good Wi-Fi and listen for an hour. The station's Icecast access log shows one `/stream.mp3?t=…` connection for the session and the listener count stays at 1; it doesn't show a new `t=` every few minutes or several open at once. _(validates #2114 — `src/lib/stream-recovery.ts` reloads only when the native media clock has stalled)_
- [ ] **iOS** / [ ] **Android** — **Tune in from standby**: with the station idle (no listeners past its idle timeout), tune in and listen through the first minute. No passage plays twice, and the access log shows one `t=`. _(validates #1936)_
- [ ] **iOS** / [ ] **Android** — **Rapid Play/Stop**: tap the power button on and off five times quickly, ending on. The station sees one stream connection, not several.
- [ ] **iOS** / [ ] **Android** — **Airplane-mode cold start**: launch with no network → app reaches the player with a **`NO CONNECTION` banner**, **no stuck splash**, no crash. Turn network back on → banner clears, can tune in.
- [ ] **iOS** / [ ] **Android** — **Station goes off-air mid-listen**: `STATION OFF AIR` banner shows and playback stops cleanly (no spinning-forever).
- [ ] **iOS** / [ ] **Android** — Force a render error path if feasible (or note untested): the **root error boundary** shows the retry screen rather than a white screen / stuck splash, and **RETRY** recovers. _(validates A2)_

## Platform controls

- [ ] **iOS** — **CarPlay**: SUB/WAVE appears, shows now-playing, Play/Pause/Stop work.
      _(Android Auto is intentionally **not** declared — rejected by Google Play under the Auto TTS-content policy; nothing to test there.)_
- [ ] **iOS 17+** — **Live Activity appears on tune-in**: lock the phone → the SUB/WAVE card is on the Lock Screen with station name, title, artist, cover and a running clock. Tune out → the card disappears.
- [ ] **iOS 17+** — **Card tracks the broadcast while backgrounded**: leave it locked across a song change → title/artist/cover swap and the progress bar restarts. While the DJ talks, the artist line + artwork swap to the persona (same as the lock screen).
- [ ] **iOS 17+** — **Cover art renders**, not the fallback disc mark. _(a disc mark on every track means the App Group entitlement is missing on one side — see TESTING.md)_
- [ ] **iOS 17+** — **Heart works from the card**: tap it with the app fully backgrounded (swiped out of the switcher is the real test — the intent has to wake the app) → the count moves within ~5s and the in-app heart agrees.
- [ ] **iOS 17+** — **Dynamic Island** (Pro device): compact shows cover + clock; long-press expands to title/artist/heart/progress.
- [ ] **iOS 18+ / watchOS 11+** — **Apple Watch Smart Stack**: with the phone tuned in, raise the paired watch → the SUB/WAVE card is in the Smart Stack and follows track changes.
- [ ] **iOS 16.x** — **Graceful floor**: on a 16.x device no card appears and nothing breaks — the OS Now Playing card still shows metadata and controls.
- [ ] **iOS** — **Live Activities switched off** for SUB/WAVE in Settings → the app tunes in normally, no card, no error.
- [ ] **Android** — **Kill the app** (swipe from recents): the **foreground-service notification is removed** and audio stops (`StopPlaybackAndRemoveNotification`).
- [ ] **iOS** — **AirPlay**: the route-picker button in the masthead opens the system picker; audio moves to a HomePod/Apple TV and back. Lock-screen metadata still updates while routed.
- [ ] **iOS** / [ ] **Android** — **Google Cast, connect mid-listen**: tap the cast button while tuned in → audio moves to the Cast device (phone goes silent, deck reads `Cast · <device>`), power/volume/mute now drive the device. First iOS tap shows the **Local Network permission** prompt.
- [ ] **iOS** / [ ] **Android** — **Google Cast, disconnect**: end the session from the cast dialog → playback **resumes locally** at the live edge. Sleep timer while casting stops the Cast audio when it lapses.
- [ ] **iOS** / [ ] **Android** — **Google Cast, station switch**: switching stations while casting stops remote playback (matches local behaviour); re-tune casts the new station.

## Station login _(validates #1873)_

Needs a station behind a reverse proxy with HTTP Basic Auth, and one with SUB/WAVE's stream password on and no proxy login.

- [ ] **iOS** / [ ] **Android** — **Add a station with a login**: + Add a station → open Station login → the username/password fields look and behave as before → health check passes → tunes in and plays. _(the fields moved into `LoginFields`)_
- [ ] **iOS** / [ ] **Android** — **A proxy that guards everything**: a station whose proxy asks for the login on `/api` and covers too → add it with its login → the health check passes, now-playing fills in, and the cover, its colours and the schedule's persona avatars load. _(Android's fetch and image loaders never sent the login from URL userinfo, and iOS used to answer the proxy's challenge from it; both now send it as a header, so this is the iOS regression check too)_
- [ ] **iOS** — **Lock-screen artwork behind that proxy**: tuned in to it → the lock screen and Control Center show the cover. _(RNTP fetches it with no headers, from the URL userinfo the cover keeps)_
- [ ] **iOS** / [ ] **Android** — **Edit a saved login**: Stations → key button on the row → the saved username and password are filled in → change to a working login → Check and save → the screen closes and the station plays.
- [ ] **iOS** / [ ] **Android** — **Single station, from the tuned-in card**: with only one station, Stations → **Station login** on the Tuned in card → edit → save. No need to switch station or remove it first.
- [ ] **iOS** / [ ] **Android** — **Wrong login is not saved**: enter a wrong password → Check and save → "The station refused this login…" → close and reopen: the old login is still there.
- [ ] **iOS** — **Wrong login after a right one in the same session**: tune in with the right login, then edit to a wrong password → still refused. _(NSURLSession must not answer the proxy with the cached login)_
- [ ] **iOS** / [ ] **Android** — **Stream-password station, no proxy**: a Station login whose password is the stream password saves; a wrong one says "The station's password check refused this password…" and offers **Save anyway**. A wrong login on a proxy that guards `/api` offers no Save anyway.
- [ ] **iOS** / [ ] **Android** — **Proxy on the stream only**: a stream-password station whose proxy guards only `/stream*` → enter the proxy's login → refused by the password check → **Save anyway** → the player asks for the station password → the station plays (the proxy takes the login header, the station password rides as `?auth=`).
- [ ] **iOS** / [ ] **Android** — **Unreachable station**: airplane mode (or stop the station) → Check and save → "Couldn't check this login with the station…" and a **Save anyway** button → Save anyway saves it. Editing a field hides Save anyway again.
- [ ] **iOS** / [ ] **Android** — **http:// station**: Check and save on an explicit `http://` station asks "Send station login over HTTP?" first; Cancel sends nothing.
- [ ] **iOS** / [ ] **Android** — **Remove login**: Remove login → confirm → fields clear, the station opens without a login, and the Cast button comes back.
- [ ] **iOS** / [ ] **Android** — **Login rejected while listening**: while tuned in, change the proxy password on the server and restart the proxy → within about 10–40 s the audio stops and **Station login rejected** covers the player; it does not keep reconnecting (proxy log). A config reload alone keeps the open stream playing, and the app never stops audio that plays: after a reload, stop and tune in again, and the overlay comes up within the same 10–40 s. **Edit station login** → new login → save → the overlay clears and Tune in plays. **Try again** clears it only once the station accepts.
- [ ] **iOS** / [ ] **Android** — **Login rejected after a network drop**: tuned in on a station with a login → airplane mode on, and wait past the connection banner (at least 40 s) → change the proxy password and restart the proxy → airplane mode off → within about 30 s **Station login rejected** covers the player. _(a check that lands while the phone is offline must not use up the next one)_
- [ ] **iOS** / [ ] **Android** — **No false alarm**: airplane mode while tuned in on a station with a login → the usual connection banner, never Station login rejected.
- [ ] **iOS** / [ ] **Android** — **A 403 is not a rejected login**: make the proxy answer `/api` with 403 (an IP allowlist, or `respond 403`) while tuned in → never Station login rejected; on the edit screen, Check and save says it couldn't check the login and offers Save anyway.
- [ ] **iOS** / [ ] **Android** — **Station password**: Station login screen → **Forget station password** → back on the player, the password prompt appears. Rotate the password in Admin and reopen the station → the prompt says "The saved password was not accepted."
- [ ] **iOS** / [ ] **Android** — **Station password rotated after a network drop**: tuned in on a stream-password station with its password saved → airplane mode on, and wait past the connection banner (at least 30 s) → rotate the password in Admin → airplane mode off → within about 2 minutes the audio stops and the prompt says "The saved password was not accepted." _(a check that lands while the phone is offline must not use up the next one, #2141)_
- [ ] **iOS** / [ ] **Android** — **A proxy's bare 401 keeps the station password**: make the proxy answer `/api/station-auth` with a 401 and no challenge (Caddy: `handle /api/station-auth { respond 401 }` above `handle_path /api/*`; a bare `respond` line runs after the `handle_path` and never answers) → reopen a stream-password station whose password is saved → it plays, with no prompt. _(only the controller's own `{"ok":false}` is a wrong password, #2143)_
- [ ] **iOS** / [ ] **Android** — **Upgrade keeps saved logins**: on the previous build save a station with a login, install this build over it → the station still plays, and the edit screen shows the login filled in.

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
  `usePlayer`'s `RemoteDuck` listener isn't one: it only stands the stream
  recovery down for the interruption and never pauses or resumes playback.
