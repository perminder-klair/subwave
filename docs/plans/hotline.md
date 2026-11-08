# Hotline: ring the DJ

Approved design, not yet implemented. Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md) (Hotline, Call, Caller, Busy, Dedication, Grant, Decline, Hotline ban, Request). The decision that a Call is never broadcast is [ADR 0001](../adr/0001-hotline-is-a-private-line.md).

## Problem

A listener can type a request, but they can't talk to the DJ. Realtime speech-to-speech models (OpenAI Realtime, ElevenLabs Agents) make a live phone call to the on-air persona possible: the Caller chats with the DJ, the DJ knows the show and what's playing, and decides on the call whether to queue the track they asked for, with a Dedication it reads on air later.

## Scope

**In v1**

- A private one-to-one Call between a Caller and the on-air DJ, from the web player first, then the native app.
- The DJ can Grant one Request per Call (with an optional Dedication), Decline, or just chat.
- Operator controls: per-show toggle, station-wide limits, live "On the line" card, end call, Hotline bans.

**Not in v1**

- Airing the Call or a clip of the Caller (ADR 0001; a recorded clip is the later route).
- Operator listen-in (audio never passes through the controller).
- On-air "lines are open" promos (later, through the talk slot table).
- ElevenLabs (second provider, through the same seam).

## Decisions

### Access

- **Off by default, opened per Show.** A show setting `hotline` (like `pauseTalk`, `controller/src/schemas/show.ts`). The toggle can only be turned on once a realtime-capable provider is configured; until then the editor shows it unavailable, with the reason.
- **Closed when requests are off station-wide.** A Call that can't Grant is only a chat.
- **One line.** A second Listener ringing during a Call gets Busy. There is no hold queue.
- **Listener auth applies.** The Hotline sits behind the same station-password gate as `POST /request` when the station has one.
- **A live Call counts as a listener presence** for the request gate (`listeners.djCallsAllowed()`, `controller/src/broadcast/listeners.ts`). The Caller has paused their stream, and the gate exists to stop the DJ talking to an empty room, not to a Caller.

### Provider and transport

- **OpenAI Realtime first**, behind a provider seam (`hotline/provider/*`), ElevenLabs Agents second.
- **The client connects to the provider directly** over WebRTC with a short-lived session token the controller mints. The station's key never leaves the controller (`state/secrets.env`). The session's prompt, voice and tool definitions are baked into the token by the controller, not chosen by the client.
- **Tool calls pass through the controller.** The client relays each one to `POST /hotline/calls/:id/tool`, authenticated by the Call's own token. The controller treats every tool call as coming from that Caller and runs it through the normal guards, so a forged call gains nothing over a forged `POST /request`.
- **Voice.** The persona's own voice when the provider can do it (OpenAI TTS persona with a matching realtime voice), otherwise an operator-picked Hotline voice. The client applies a light phone-line EQ to the DJ's voice, which makes a different voice read as "the DJ on the phone".

### Who answers

- The **lead persona of the Show on air when the Call connects** (`getOnAirRoster`, `getEffectivePersona`). The persona stays fixed for the Call.
- The prompt is built from the existing pieces: `djSystem()`, `buildContextLines()` and `settings.spokenContext()`, so a template without `{location}` withholds the place here too. No new context path.
- **A show change mid-Call:** the Call runs to its cap. No new Call connects unless the incoming Show also opens the Hotline.

### What the DJ can do (tools)

| Tool | Purpose |
| --- | --- |
| `now_playing` | What's on air and what's next, read live (the track can change mid-Call) |
| `show_context` | The current Show, its mood and steer |
| `queue_position` | How far away a granted track would be, so the DJ says "about three songs from now", never "next" |
| `identify_requested_track`, `search_library`, `similar_songs`, `tracks_by_mood` | A narrow subset of the picker tools (`buildPickerTools`, `controller/src/llm/internal/tools/picker/index.ts`), kept small for conversation latency |
| `grant_request(trackId, dedication?)` | Queue the track through the request chokepoint |
| `decline_request(reason)` | Record the Decline |
| `end_call()` | Hang up |

Nothing that changes the Show, skips, or reorders the queue. Listeners never get a skip.

### A Grant is a Request

- **One chokepoint.** Extract the final step of the request path, "commit this track as a listener request", into one function that typed requests and Grants both call: blocklist, clean show, repeat cooldown, artist spacing, `maxPending`, `onePendingPerIp`, `perIpHourlyCap`, and the `requestedBy` exemptions. `controller/src/routes/request.ts` pushes from two places today (lines ~328 and ~600); both move onto it. This extraction is a behaviour-preserving refactor and ships as its own PR first.
- **A rejected Grant is a conversation turn.** The chokepoint's reason ("on the never-play list", "played an hour ago", "this is a clean show") goes back to the model, which tells the Caller and offers something else.
- **Queued the moment it's granted.** From then on it stands alone: the Caller hanging up, the provider dropping or the controller restarting do not withdraw it. The Show it airs in judges it like any Request, so a clean incoming Show can still hold it back. The DJ is told this so it doesn't promise what it can't deliver.
- **`requestedBy`** is the Caller's name through `cleanRequesterName`, so the Grant counts in `pendingListenerRequests()` like any listener request.

### Dedication

- Captured as **two short fields**, who it's for and the occasion or gist, each length-capped and cleaned like requester names. It is its own field on the Request, not text inside it (`routes/request.ts` strips "dedication" labels from request text today).
- **Written for air by the normal intro path** (`generateQueuedRequestIntro`, `controller/src/broadcast/request-intro.ts`) in the persona's on-air voice, with the existing stand-in policy and echo guards. The fields are untrusted listener input to that prompt, handled like request text. The call model's words and the Caller's words never air.
- The call model is told to decline offensive or impersonating Dedications.
- **If the intro fails** (LLM down, token cap, a guard drops it), the track airs as a plain request without the Dedication. The station keeps making sound.

### Limits and cost

All operator-adjustable, stored in station-wide Hotline settings:

| Limit | Default |
| --- | --- |
| Call length | 3 min hard cap; the DJ is told to wrap up at 2:30 |
| Calls per device | 1 per Show |
| Hotline minutes per station | 60 per station day; past it the Hotline reads closed |
| Grants per Call | 1 |

Hotline minutes are a separate budget from the LLM token cap. The existing request limits still apply to the Grant.

### Memory and privacy

- **No audio and no transcript are kept.**
- **A one-line outcome** goes into the DJ session in the shape a typed request uses (`Listener "X" requests: …` today), for example "Sam rang the Hotline, asked for X, dedication for their sister", so the on-air DJ can say "just had Sam on the line". The outgoing-show handoff rules in `show-boundary-handoffs.md` apply to it like any other session turn.
- The operator's activity log gets the outcome and the duration.
- **A one-time notice** before a device's first Call names the provider: "Your voice is processed by OpenAI to talk to the DJ. Nothing is recorded."

### Operator surfaces

- Station-wide Hotline settings: provider, voice, limits. The key goes to `state/secrets.env` with the other cloud keys.
- Per-show Hotline toggle in the show editor.
- An **On the line** card in the admin page: Caller name, time elapsed, what's been granted, an end-call button, minutes used today against the cap.
- **Hotline bans** by device, listed and removable in settings.

### Public reads

`/state` gains a Hotline status for listener surfaces: `closed | open | busy` and nothing more. No provider, voice, limits or Caller names. Public reads stay explicit allowlists.

### Clients

- **The controller API is the same for every client.**
- **Web player first.** Browser WebRTC needs no native work and is fastest to test. Pause the `<audio>` stream on connect, rejoin at the live edge on hang-up so the Caller hears their track and Dedication.
- **Native app second.** It needs `react-native-webrtc` and a microphone permission, so a new binary through the stores, with no OTA path (`app/CLAUDE.md`). The same pause and rejoin behaviour with `react-native-track-player`.
- The app sends the name the listener already uses for typed requests. With none set, the DJ asks "who's this?" first.

## Build order

1. **Request chokepoint.** Extract the shared commit step from `routes/request.ts`, behaviour-preserving, with tests over both existing push sites. Own PR.
2. **Schemas.** `settings.hotline` (provider, voice, limits), the show `hotline` toggle, Dedication fields on the request and queue entry. In `controller/src/schemas/`, then `npm run gen:schemas`.
3. **Hotline policy.** `hotline-policy.ts`: is the line open (show toggle, provider configured, requests on, minutes left), Busy, per-device and per-day caps, bans. One module, the only place these are decided.
4. **Call lifecycle.** A single-line call registry (the line is freed on every end, including a controller restart), the minutes ledger and bans in `state/`, the provider seam with OpenAI token minting, the call prompt from the existing context pieces, and the routes: start, tool, end, plus the admin read and end-call.
5. **Tools.** The table above, `grant_request` through the step 1 chokepoint, the live-Call presence for the request gate.
6. **Dedication on air.** The fields flow into `generateQueuedRequestIntro` as untrusted input. Plain request on any intro failure.
7. **Session and log.** The one-line outcome into the session; duration and outcome into the activity log.
8. **Web player.** Call button driven by `/state`, Busy, the provider notice, WebRTC, tool relay, phone EQ, stream pause and live-edge rejoin.
9. **Admin.** Settings, show toggle (disabled without a provider), On the line card, bans.
10. **Native app.** `react-native-webrtc`, microphone permission, the same flow. Ships with the next binary.
11. **Docs.** A Hotline section in `docs/internals/broadcast.md`, the routes in `docs/api.md`, and invariant lines in `CLAUDE.md`, for example:
    - A Call is never broadcast; only its Grant and Dedication air (ADR 0001).
    - A Grant goes through the one request chokepoint, never its own guards.
    - Nothing on air waits on a Call.

## Left for implementation

These are mechanics, not product decisions, but flag them in review:

- **Device identity.** "Per device" needs a client-held random id. It can be cleared or forged, so pair it with the client IP for bans and per-device caps, and say in the settings copy that a ban is best-effort.
- **Station day** for the minutes cap: use the same station-clock day the tag schedule uses, not UTC.
- **Multi-station:** Hotline settings, ledger and bans live in each station's own `state/`, like everything else.
