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
- [ ] **iOS** / [ ] **Android** — **Lock screen after a reconnect**: tuned in with the phone locked, turn airplane mode on for ~15 s and off again (or walk off Wi-Fi onto cellular) so the stream reconnects. While it reconnects, the lock screen / notification shows the current song's title and artist with no cover, not `SUB/WAVE · Live broadcast`. Once audio is back it shows the **title, artist and cover** within a few seconds, and the progress bar resumes. Repeat with the outage running across a song change, so the new cover can't come from the phone's cache: it appears the same way, once the audio does. _(validates #2143 — every reload resets the native card to the loaded item's placeholders; `useNowPlayingInfo` re-sends it on `PlaybackActiveTrackChanged` — and #2162 — the cover waits for the item's first `playing`, so its one fetch runs on a link the stream has proved)_
- [ ] **iOS** — **No cover fetch on a status flip**: tuned in with the phone locked, force a buffering stall that recovers without a reconnect (Network Link Conditioner, briefly at 100% loss). The lock-screen cover stays put, its progress bar is right again once audio resumes, and the station's access log shows no new `/api/cover/…` request for the stall, only on a song change, a DJ persona swap or a reconnect. _(validates #2143 — a status or foreground flip re-anchors progress only; Android's RNTP patch already skipped an unchanged card)_
- [ ] **iOS** / [ ] **Android** — Lock-screen / notification controls: **Play, Pause, Stop** work. **No Skip/Next** control is present (intentional — shared live stream).

## Resilience & connectivity

- [ ] **iOS** / [ ] **Android** — **Headphone / Bluetooth unplug** pauses playback; pressing play (or replugging) **resumes at the LIVE edge**, not a stale buffered segment. _(validates A3 — `service.ts` RemotePlay re-load, through `stream-recovery.ts` while the app is open, #2139)_
- [ ] **iOS** / [ ] **Android** — **Remote Play during a reload**: tuned in, turn Wi-Fi off for ~10 s and back on, and send a Play from the car or the lock screen while the player still says `CONNECTING…`. On iOS a headset's single button won't do: it toggles, and RNTP sends Pause unless the player is already paused. The station's Icecast access log never shows two `t=` connections open at once, and the audio plays without a passage repeating twice over. _(validates #2139 — a remote Play queues behind the recovery's reload)_
- [ ] **iOS** / [ ] **Android** — **Remote Play after a login edit**: on a station behind a proxy login, pause from the lock screen, edit the Station login in the app to the new password (after changing it on the proxy), lock the phone, and press Play on the lock screen. It plays, and the proxy log shows the new login, not a refusal. _(validates #2139 — a remote Play reads the current URL and login)_
- [ ] **iOS** — **Hung connection**: while tuned in, make the stream hang before it answers (a proxy or firewall rule that accepts the connection and never responds). The player stays on `CONNECTING…` and keeps retrying: a few attempts ~6 s apart, then further apart up to a minute (proxy access log), never a stretch of minutes with none. Restore the stream and it plays at the next attempt. _(validates #2143 — a reload made while the item is still Loading is checked again)_
- [ ] **iOS** — **Output device disappears** (Bluetooth speaker powered off, or CarPlay: car turned off / cable pulled): app pauses instead of "playing" silently, and the **admin listener count decrements** within a few seconds (no phantom Icecast session). _(validates #992 — `usePlayer` route-change tune-out on `oldDeviceUnavailable`)_
- [ ] **iOS** — **AirPlay regression guard**: pick a HomePod from the in-app AirPlay button, let a crossfade pass, pick the phone back — playback keeps running on the chosen device throughout, never snapping to the built-in speaker or pausing. _(the #992 pause must fire ONLY on `oldDeviceUnavailable`, not on handoffs — 0b060a3a behavior)_
- [ ] **iOS** / [ ] **Android** — **Phone-call interruption**: audio ducks/pauses for the call and resumes after. _(validates `autoHandleInterruptions: true`)_
- [ ] **iOS** / [ ] **Android** — **Phone call / Siri while listening**: take a call (or hold the side button for Siri) mid-listen. Nothing reloads during it: the station's Icecast access log shows no new `/stream.mp3?t=…` until it ends. Afterwards the audio comes back by itself, and a new `t=` appears only if the old connection didn't survive the call. _(validates #2114 — `stream-recovery.ts` `onDuck` and its keep-watching rule)_
- [ ] **iOS** / [ ] **Android** — **Wi-Fi → cellular switch** while tuned in: the **`CONNECTING…` / `NO CONNECTION` banner** appears and playback **reconnects within a beat** (not the full ~6s watchdog wait), or keeps playing with no reload if the old connection survived the switch. _(validates A1 — `useConnectivity` proactive reconnect)_
- [ ] **iOS** / [ ] **Android** — **An hour on a healthy link**: tune in on good Wi-Fi and listen for an hour. The station's Icecast access log shows one `/stream.mp3?t=…` connection for the session and the listener count stays at 1; it doesn't show a new `t=` every few minutes or several open at once. Keep Bluetooth and CarPlay disconnected: their Play reloads the stream too, and the log can't tell it from a recovery reload. _(validates #2114 — `src/lib/stream-recovery.ts` reloads only when the native media clock has stalled)_
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
- [ ] **iOS** / [ ] **Android** — **Live dot behind a proxy**: the dot only shows on Discover rows, so this needs the proxy-guarded station in the directory (a test build's `extra.directoryUrl` can point at a `stations.json` that lists it) and a saved login while it is not under Recent (save it with its login, then tune to eight other stations so it drops off). Stations and onboarding → its Discover row reads `ON AIR`, not `OFFLINE`. A guarded station you never saved a login for still reads `OFFLINE`. Neither ever brings up Station login rejected or the station password prompt, and the proxy log shows only `GET /api/now-playing`, every 30 s. _(validates #2143 — `StationLiveStatus` sends the saved login, `lib/live-status.ts`)_
- [ ] **iOS** / [ ] **Android** — **A 403 is not a rejected login**: make the proxy answer `/api` with 403 (an IP allowlist, or `respond 403`) while tuned in → never Station login rejected; on the edit screen, Check and save says it couldn't check the login and offers Save anyway.
- [ ] **iOS** / [ ] **Android** — **Station password**: Station login screen → **Forget station password** → back on the player, the password prompt appears. Rotate the password in Admin and reopen the station → the prompt says "The saved password was not accepted."
- [ ] **iOS** / [ ] **Android** — **Station password rotated after a network drop**: tuned in on a stream-password station with its password saved → airplane mode on, and wait past the connection banner (at least 30 s) → rotate the password in Admin → airplane mode off → within about 2 minutes the audio stops and the prompt says "The saved password was not accepted." _(a check that lands while the phone is offline must not use up the next one, #2141)_
- [ ] **iOS** / [ ] **Android** — **A proxy's bare 401 keeps the station password**: make the proxy answer `/api/station-auth` with a 401 and no challenge (Caddy: `handle /api/station-auth { respond 401 }` above `handle_path /api/*`; a bare `respond` line runs after the `handle_path` and never answers) → reopen a stream-password station whose password is saved → it plays, with no prompt. _(only the controller's own `{"ok":false}` is a wrong password, #2143)_
- [ ] **iOS** / [ ] **Android** — **A proxy's login page unlocks nothing**: make the proxy answer `/api/station-auth` with a 200 page (Caddy: `handle /api/station-auth { respond "<html>Sign in</html>" 200 }` above `handle_path /api/*`) → open a stream-password station with no saved password and type anything → it says "Could not reach the station", stays on the prompt and saves nothing. A saved password still plays. _(only the controller's own `{"ok":true}` is a right password, #2164)_
- [ ] **iOS** / [ ] **Android** — **A stalled body lets go**: on a computer on the same network run a stand-in station that answers `/api/health` and then stalls every other body: `node -e "require('http').createServer((q,s)=>{q.socket.once('close',()=>console.log('closed',q.url));s.writeHead(200,{'Content-Type':'application/json'});q.url.endsWith('/health')?s.end('{}'):s.write('{')}).listen(8099)"`. Add `http://<computer>:8099` as a station → onboarding gets past the booth-name step in about 5 s and the computer prints `closed /api/dj`. Open the station → `/api/now-playing`, `/api/state` and `/api/session` each print `closed` about 8 s after they open, and a new round starts within 5 s, so the polls keep going and never pile up. _(an abort closes the connection but doesn't end a native body read, so the app stops waiting for it as well; a native-only path, #2163)_
- [ ] **iOS** / [ ] **Android** — **Upgrade keeps saved logins**: on the previous build save a station with a login, install this build over it → the station still plays, and the edit screen shows the login filled in.

## Playback log _(validates #2140)_

- [ ] **iOS** / [ ] **Android** — **The log is there in a store build**: tune in, stop, tune in again → About SUB/WAVE → **Share playback log** → Copy, and paste it into a note. The first line names the app version, the bundle (`OTA <id>` or `built-in <id>`) and the OS version; below it are UTC-stamped lines, including a `reload [tune]` for each tune-in.
- [ ] **iOS** / [ ] **Android** — **Nothing secret in it**: on a private station with a Station login and a station password, tune in, toggle airplane mode to force a reload, then share the log → no password, no username, no `auth=` value and no `Authorization` value appear anywhere; any URL reads `https://<host>/<path>` with no `?…`.
- [ ] **iOS** / [ ] **Android** — **Errors say what failed** _(validates #2160)_: tune in, then stop the station or toggle airplane mode so the stream fails, and share the log → the `event playback-error` line has `code=android-…` and `msg=` on Android and a readable `msg=` on iOS, with no `?…` on any URL in it.
- [ ] **iOS** — **Route lines keep no device name**: connect and disconnect Bluetooth headphones while tuned in → the route lines read like `outputs=BluetoothA2DPOutput`, without the headphones' name. An `Other` means a port type the app's list doesn't have yet (`PORT_TYPES` in `src/lib/playback-log.ts`), or a device name with `,Word:` in it.
- [ ] **iOS** / [ ] **Android** — **Memory only**: kill the app from the switcher, relaunch, share the log → none of the lines from before the kill are in it.

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
