# Native Audio Format Selection

## Goal

Bring the web player's explicit MP3, Opus, AAC, and FLAC selection to the SUB/WAVE Expo app. The app shows all four formats, enables only choices that are both live at the selected station and verified as reliable on the current native platform, and keeps MP3 as the safe default and fallback.

## User experience

The player's Back Panel gains an **Audio format** row alongside the existing output, timer, and theme controls. Its value is the active format. Selecting it drills into an Audio Format sheet using the same in-place sheet navigation as Sleep Timer and Theme.

The sheet always lists:

- MP3 — universal compatibility
- Opus — bandwidth-efficient compressed audio
- AAC — broadly compatible compressed audio
- FLAC — lossless processed broadcast audio

Each row has a selected state and a separate availability state. An unavailable row remains visible and disabled, with one specific reason:

- **Not enabled by station** when the station does not advertise the mount.
- **Not supported on this device** when the native capability policy does not approve that platform/format combination.
- **Playback failed this session** after a runtime failure caused an automatic fallback.

The first capability policy enables MP3 and AAC on both iOS and Android. Opus and FLAC remain visible but disabled on both platforms until their complete Icecast behavior, including chained-Ogg track transitions, has been verified with the app's React Native Track Player stack. The policy is a small isolated table so individual formats can be enabled per platform without changing UI or playback code.

## Station discovery and stream URLs

The native `NowPlayingResponse` type gains the controller's existing structured `stream` object, including `opusEnabled`, `aacEnabled`, and `flacEnabled`. MP3 is mandatory whenever the station is online. The current station feed retains this stream description and passes its enablement to the player.

`StationApi` exposes typed URLs for all four conventional sibling mounts. URL construction stays centralized beside the existing credential handling: `/stream.mp3`, `/stream.opus`, `/stream.aac`, and `/stream.flac` are built from the credential-free station base, while `streamHeaders()` continues to carry Basic authentication for every format.

No controller, Liquidsoap, or station-settings changes are required.

## Selection, persistence, and station changes

The initial target is MP3 unless AsyncStorage contains a valid preference for the selected station. Preferences are keyed by normalized station origin, matching the multi-station nature of the app.

A stored preference is applied only when both the station and device currently allow it. If it becomes unavailable, the player uses MP3 and leaves the stored preference unapplied so it can become valid again later. Choosing a format writes the explicit preference for that station.

Changing format while tuned out only changes the next playback target. Changing while tuned in reloads React Native Track Player with the new live URL and headers, preserves volume and tuned-in state, and reports `connecting` until playback resumes. Lock-screen metadata, remote controls, AirPlay, Cast, reconnect handling, and station switching continue to use the same player instance.

When the selected station changes, format state is rehydrated under the new station's preference key. Existing station-change teardown remains authoritative, so audio from the old station cannot continue during rehydration.

## Architecture

### Pure format policy

A focused native audio-format module owns:

- the `AudioFormat` union and display metadata;
- the static iOS/Android reliability table;
- station/device/runtime availability calculation;
- per-station preference keys and valid-preference resolution;
- format-to-stream-URL selection.

These decisions remain pure and independently testable. UI components do not construct stream URLs, inspect the platform, or decide fallback behavior.

### Player ownership

`usePlayer` remains the single owner of live playback and exposes the active format, availability map, selection callback, and optional failure format in addition to its current controls.

The hook mirrors the selected URL in a ref used by tune-in and every watchdog reconnect. This prevents a reconnect from silently reverting to MP3. Preference hydration finishes before a listener's first tune target is resolved; a rapid first tap must use the restored valid preference rather than the initial render's MP3 default.

### Presentation

Add a focused `AudioFormatDrawer` that receives resolved availability and callbacks. It contains no player operations or persistence. `BackPanelDrawer` gains the active-format label and an `onOpenAudio` callback. `PlayerScreen` adds `audio` to its existing sheet state and wires the drawer to `usePlayer`.

## Failure behavior

If an optional format fails to load or emits a React Native Track Player playback error, the player marks that format failed for the current app session, immediately switches the active target to MP3, and resumes using the existing exponential reconnect policy. The Audio Format sheet explains the fallback. The stored preference is retained so a future app session can try it again.

MP3 failure has no lower fallback; the existing retry, connectivity, and offline UI remain responsible.

Failures must be attributed to the active playback generation. A late error from the previous mount after a listener switches formats must not blacklist or replace the new selection.

## Accessibility

The Back Panel row exposes its current value. The drawer is presented as a labelled single-selection group. Every row exposes selected and disabled state, maintains an adequate touch target, and includes textual availability information rather than relying on color.

## Verification

Pure tests cover:

- platform reliability mapping;
- station enablement and disabled-reason precedence;
- per-station preference keying;
- valid preference restoration and MP3 fallback;
- standard mount URL selection.

Player-level tests or focused mocks cover:

- restored preference being used on the first tune-in;
- switching while tuned in preserving volume and reconnecting once;
- watchdog reconnects retaining the selected format;
- optional-format errors falling back to MP3 and blacklisting only that format for the session;
- stale errors not affecting the current playback generation;
- station changes rehydrating independently.

Manual verification on physical iOS and Android devices confirms the selector layout, MP3 and AAC playback across track transitions, live switching, persistence, fallback messaging, background audio, lock-screen controls, AirPlay/Cast continuity where available, and disabled Opus/FLAC explanations. `npm run lint` passes in `app/`.

## Out of scope

- Enabling or disabling station-side encoders
- Changing Liquidsoap mounts or codecs
- Automatically choosing a highest-quality or lowest-bandwidth format
- Runtime probing of disabled formats
- Enabling Opus or FLAC before physical-device transition testing establishes reliability
