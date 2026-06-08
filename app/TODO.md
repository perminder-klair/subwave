# TODO

- [x] visualizer: now matches the web bars (centre-anchored, slot-filling) and is driven by a synthesised *musical* spectrum (bass-heavy shape, correlated neighbouring bins, drifting beat pulse, breathing energy, fast-attack/slow-release) instead of flat per-bin random. Native can't tap the live MP3 for a real FFT (RNTP has no analyser; react-native-audio-api is HLS-only), so this mirrors what the web already does on iOS.
- [x] android media-control tap: react-native-track-player opens the app via a sentinel deep link (`trackplayer://notification.click`) that matched no route → "unmatched route" page. Added `app/src/app/+native-intent.tsx` (`redirectSystemPath`) to rewrite that sentinel to `/` (the player) on both cold and warm starts; all other links pass through.
