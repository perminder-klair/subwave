# Web Audio Format Selection

## Goal

Allow web listeners to choose the station's MP3, Opus, AAC, or FLAC stream from the player without changing the default listening experience. MP3 remains the default until the listener explicitly selects another format.

## User experience

The right-hand player rail gains a fifth item labelled **Audio** with a gear icon. The existing four-item group moves upward enough to fit the new item at its bottom while preserving the current spacing, responsive behavior, and contained-player layout.

Selecting Audio opens the same right-side sheet used by Schedule, Timeline, Booth, and Request. The sheet lists all four formats:

- MP3 — universal compatibility and the default selection
- Opus — bandwidth-efficient compressed audio
- AAC — broadly compatible compressed audio
- FLAC — lossless processed broadcast audio

Each row shows whether it is available. An optional format is selectable only when both of these conditions are true:

1. The station reports its mount as enabled through the public `/now-playing` response.
2. The browser reports that it can play the format.

Unavailable rows remain visible and disabled. Their status distinguishes “Not enabled by this station” from “Not supported by this browser.” MP3 is treated as the station's mandatory mount, but it may still be marked unsupported in the unlikely event that the browser rejects its MIME type.

The selected row is clearly identified and exposed through normal radio-group semantics for keyboard and screen-reader users.

## Selection and persistence

The initial format is MP3 unless a valid listener override is stored in `localStorage`. Preferences are scoped by station origin because the same player can target directory stations. Choosing AAC on one station must not change another station's default.

A stored override is applied only if the format remains enabled and browser-compatible. Otherwise the player uses MP3 and leaves the unavailable stored choice unapplied. Selecting a new available format replaces the stored override.

Changing format while tuned in immediately reconnects the existing audio element to the chosen mount and resumes playback. Changing format while tuned out updates the next tune-in target without starting playback. Volume, mute state, player controls, idle handling, media-session integration, and the waveform continue to use the same audio element.

## Architecture

### Stream descriptions

Extend `StationStreams` from MP3 and optional Opus URLs to include MP3, Opus, AAC, and FLAC URLs. Default and directory-station origins derive all standard mount paths from the station host. A non-standard `NEXT_PUBLIC_STREAM_URL` override remains pinned to its verbatim MP3 URL and cannot infer optional sibling mounts unless the URL follows the standard `/stream.mp3` shape.

Add typed stream-capability data to the existing `NowPlayingResponse` model and station feed. The controller already returns `stream.opusEnabled`, `stream.aacEnabled`, and `stream.flacEnabled`; no new endpoint or server-side setting is required.

### Player ownership

`usePlayer` remains the single owner of the audio element, active stream URL, reconnect behavior, and format failure handling. It will expose:

- the effective selected format;
- a format-selection function;
- browser support for each format;
- any runtime format failure needed by the Audio drawer.

The hook will no longer silently auto-upgrade MP3 to Opus. It starts with MP3, restores a valid explicit preference after hydration, and changes mounts only from a stored or current listener selection.

Browser support is determined with `HTMLMediaElement.canPlayType` using the appropriate MIME type for each format. Existing platform guards remain authoritative: iOS-family browsers and Firefox must report Opus unavailable because their Icecast chained-Ogg behavior can fail at track boundaries even when generic Opus decoding is advertised.

### Player rail and drawer

Extend the shared player drawer identifier with an `audio` value. `DotRail` renders the new gear item after Request and adjusts its vertical layout to move the five-item column upward rather than overflowing toward the transport bar. The active indicator and toggle behavior remain shared with the existing items.

Add a focused `AudioDrawer` component. It receives station enablement, browser support, current selection, failure state, and the selection callback. It owns presentation only; it does not construct URLs or control the audio element.

`PlayerApp` passes the public mount flags from `useStationFeed` into `usePlayer`, wires the returned selection state into `AudioDrawer`, and adds the drawer title and render branch.

## Failure behavior

If an explicitly selected optional stream emits an audio-element error, the player immediately falls back to MP3 and resumes the existing reconnect backoff. The failed optional format is unavailable for the remainder of the page session, preventing a retry loop. The Audio drawer explains that playback fell back to MP3 because the selected stream could not be loaded.

The stored preference is retained after a transient runtime failure so a future visit can try it again. A deliberate MP3 selection clears the optional override and stores MP3 as the listener's explicit choice.

If MP3 itself fails, the existing reconnect watchdog and offline UI remain responsible; there is no additional format fallback.

## Accessibility and responsive behavior

The gear rail button has an accessible name, pressed state, focus treatment, and the same touch target as the existing rail items. The format list uses a labelled radio group, disabled controls, visible selected state, and status text that does not depend on color alone.

The five-item rail must fit between the top and transport bars at supported viewport sizes. The contained showcase player uses the same control and drawer portal behavior without affecting first-run routing or station switching.

## Verification

Web-client tests or focused pure-function tests will cover preference-key scoping, MIME support mapping, station enablement, valid preference restoration, and fallback selection. Component-level verification will cover disabled reasons and selection semantics where the current test setup permits it.

Manual verification will confirm:

- MP3 is used on a clean browser profile.
- All four formats appear with accurate station and browser availability states.
- Selecting an enabled format switches the live audio immediately.
- Reloading restores the selection for that station only.
- A disabled or unsupported format cannot be selected.
- A failed optional mount falls back to MP3 and displays the reason.
- The rail and drawer remain usable on desktop, mobile, and contained player layouts.
- `npm run lint` passes in `web/`.

## Out of scope

- Changing which formats the station operator enables
- Adding or modifying Liquidsoap mounts
- Automatically choosing a “best” format
- Native iOS or Android player format selection
- Exposing FLAC or AAC through media-session-specific controls
