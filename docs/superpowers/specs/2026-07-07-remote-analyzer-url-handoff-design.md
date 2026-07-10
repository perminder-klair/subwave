# Remote Analyzer URL Handoff Design

## Goal

Allow a controller running on one host to offload acoustic analysis to a remote analyzer host such as Odin when that host can fetch Navidrome/Subsonic stream URLs directly.

## Context

The controller already supports an HTTP analyzer backend via `ANALYZE_URL`. During analysis, it currently optimizes for the local compose sidecar by prefetching each track into `${STATE_DIR}/analyze-tmp` and sending the analyzer a local `path`. That path only works when the analyzer container shares the same state volume. A remote analyzer can instead use the existing `{ url }` request mode, where the analyzer worker downloads the audio stream itself.

## Design

Add `ANALYZE_HANDOFF` to the controller analyzer config with values:

- `auto`: default behavior, preserving the current one-ahead path prefetch pipeline.
- `path`: explicit local/shared-volume path handoff.
- `url`: skip controller prefetch and send each track ID through `analyzer.analyze(...)`, which posts `{ url }` to the sidecar.

For Odin, configure:

```env
ANALYZE_URL=http://odin:8080
ANALYZE_HANDOFF=url
```

The analyzer sidecar on Odin should run the heavy analyzer image when vocal/instrumental detection or CLAP sounds-like vectors are desired.

## Error Handling

URL handoff keeps existing per-track failure handling: if Odin cannot fetch or decode a track, the analysis loop records that track as failed and continues. Path handoff keeps the existing `NonAudioResponseError` behavior for stale Navidrome entries detected during local prefetch.

## Testing

Add a focused pure test for the handoff decision so the default remains path-prefetching and `ANALYZE_HANDOFF=url` disables it. Then wire the analysis loop through that helper. Run the targeted test and controller typecheck.
