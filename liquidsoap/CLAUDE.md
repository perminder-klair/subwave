# CLAUDE.md — `liquidsoap/`

`radio.liq` is the whole mixer, and its comments carry the reasoning and the measured numbers behind most rules below; where a rule has no comment in it, this file is its only home. Read the comment at a block before changing it, and keep it true when you do. The controller↔mixer file contract (who writes which file, at what poll) is in the root `CLAUDE.md`. Liquidsoap 2.4.6 is the minimum runtime; a "measured on 2.4.5" in a comment is history.

## Pipeline, in order

1. `music` = `fallback([dj_queue, auto_slot])`: controller requests first, else the `auto.m3u` coast. `auto_slot` is a `source.dynamic`. The `auto.reload` telnet command reloads the on-air playlist in place or replaces an off-air one, and `auto.ready` reports whether it has a track. One radio.liq-owned file watch reloads in place only contents no reload has read yet; it never replaces the instance.
2. No cut stage: `liq_cue_in`/`liq_cue_out` (the length cap, the silence trim, the show-boundary fade, a stem blend's cut) apply at request resolution. `cue_cut` is a deprecated no-op on 2.4.x, so the script does not call it.
3. `music_meta`: the pre-cross capture that `on_meta` (`now-playing.json`, the ICY title) and the starve guard read.
4. The automatic jingle `rotate` (built only when `jingle_ratio` > 0), then the track-sensitive `music_with_jingle_now` switch, with the on-demand `jingle_now_queue` as its first choice.
5. Per-track `liq_amplify`, then `cross_stamps`, then `cross(dj_transition)`.
6. The dead-air guard `fallback(id="music_safety", [music, emergency])`.
7. The studio bed `add` (off: `bed_enabled = false`).
8. The `smooth_add` ducks: `voice_queue` (`duck_voice`), `intro_queue` (`duck_intro`), `sfx_queue`. The voice and intro chains (`edge_fade`, `liq_amplify`, `mic_chain`) are parallel inputs that join here. The intro chain's innermost stage is the over-music ID's gain gate, `amplify(override=null, intro_overlay_gain, intro_queue)`, which is 1 for every ordinary clip.
9. `idle_gate` (silence while idle, mounts stay up), then the limiter (20:1 at −1 dBFS) and the ICY metadata strip/insert.
10. `make_stream_outputs()`: `/stream.mp3` always; Opus, FLAC and AAC each behind its own `liquidsoap_*_enabled.txt` (off by default); the hourly archive behind `archive_enabled` (off by default). Encoders need parse-time bitrates, so there is one branch per value in `SETTINGS_*_BITRATES` (`controller/src/schemas/settings.ts`): keep them in sync.

## Rules

Each one records a measured failure.

**Placement**
- `on_meta` hangs off `music_meta`. Post-cross it would fire twice, and an `on_track` there is swallowed by source switches.
- The rotate stays on the raw pre-cross source. Below `cross` everything is one endless track, so a rotate there plays one jingle and then sticks on music. `jingle_ratio` 0 must keep meaning "rotate not built", because that is how the controller takes the rotate over (#1619).
- `jingle_now_queue` is the switch's first choice and joins below the `music_meta` capture. Inside the rotate a due jingle would beat a press; inside `dj_queue` the press would wait behind tracks already sent; above `music_meta` an upload's ID3 tags would reach `now-playing.json`.
- The dead-air guard sits above every `add` (the bed and the ducks) and below `music_meta` and the rotate. `add` is ready if any input is (`smooth_add`'s `blank()` fallthrough, the bed's `mksafe`), so a guard below one never fires. Keep one guard, never a decorative second one at the bottom, and no `blank.skip`, which spins a core when the chain is empty (#660).

**Jingles**
- A jingle's gate decides whether it starts, never whether it continues. The press gate is the switch's predicate (`not bed_on_air()`, `not pause_talk_on_air()`, `time() > voice_until()`), asked only at a track boundary. The rotate's `source.available` is held open while a rotate clip airs, released by the playlist's own synchronous `on_track` (that release is load-bearing), and yields to `music_starved()`. Residual: a rotate clip can hand straight to the next rotate clip while music is momentarily unready.
- Every `on_meta` branch clears `jingle_now_on_air`, or it latches and starves the rotate.
- On the controller-owned rotate, dropping the `not music_starved()` gate is safe only because the controller counts boundaries from `now-playing.json`, which comes from `music_meta`, above the rotate: a starved chain stops the count, so at most one stinger airs into a starve. Re-base that count below `music_meta` and `jingle_now` needs the starve gate.
- `jingle-playing.json` has two writers. Between-song jingles: an `on_track` on the switch's output, filtered on `subwave_jingle`. Never write it on a jingle source (request sources fire hooks as they pre-start the next clip, which stamped jingles N tracks early) or on the rotate's output (which fired 43 s before the feed). An over-music ID never reaches that switch, so `voice_marker` writes it (`placement: "over"`), from its own temp dir. That hook is safe where a jingle source's is not: `intro_queue` sits directly under its duck, so its next request starts as it airs.
- Both writers stamp `durationSec` through `jingle_duration` (try/catch → `0.` = unmeasured), never `voice_marker`'s 30 s gate fallback. The controller can only measure RIFF, and an upload made without ffmpeg keeps its original container.
- An over-music ID (`subwave_jingle_overlay`) rides the ordinary `intro_queue` path. `poll_intro` drops it unless the running `jingle_ratio` is 0 and its `subwave_overlay_track_at` matches the song `on_meta` last stamped, so a skip between polls cannot move it onto another song. The ID and its lead-in carry one cancellation generation, which every idle and off-air command bumps before it changes either gate, so a paused ID never resumes over speech queued during the pause. It never touches `now-playing.json` or the ICY title.
- An over-music ID's per-frame gate (`jingle_overlay_live_safe`, read by `intro_overlay_gain` on the streaming thread) reads refs and queues only, never a file, and ignores manual presses: a press waits for a track boundary and the ID's own `voice_until`, so cutting the ID for it only lost the ID. Presses and the handoff files are checked once, when `poll_intro` consumes the offer (`jingle_overlay_safe`). The inner `amplify` passes `override=null`; the default override applies a clip's `liq_amplify` stamp a second time.
- Back-to-back jingles carry `queuedSec`; only a jingle shorter than the crossfade holds the next one back. Presses queued together do not burst (`request.queue` resolves one ahead); it bites on back-to-back rotate jingles and on a gated press with another one resolved behind it.
- The `jingles` playlist keeps `id="jingles"` and the stdlib server commands. Renaming it or setting `register_server_commands=false` makes the controller's `jingles.reload` answer "unknown command", which the controller silently reads as "no rotate".
- On a jingle seam the incoming gestures stand down (`not jingle_out`), and a jingle is never blended: the seam is a `sequence`, the one exception to the full-buffer blend.

**Transitions**
- Fade duration equals the buffer (`d` is what is actually buffered); shorter fades in a fixed buffer sum to +6 dB. There are two measured exceptions: the chop's incoming fade runs on `chop_dd`, and a stem-blend clip seam fades both sides over the cue lead.
- The equal-power crossfade (`transitions.equalPowerCrossfade`, default off → linear) applies to plain song-to-song seams only (`equal_power_seam`): cos out and sin^1.5 in, so in² + out² stays within 0.9 dB of 1, because two uncorrelated songs add in power and a linear seam dips −3 dB. The incoming is sin^1.5, not sin, so it rises no faster than linear: a quiet ending into a loud start is a fade-in from silence, and plain sin made it abrupt. Liquidsoap's `fade type="sin"` is sin², not equal-power. A stem-blend clip seam stays linear (equal-power over two aligned copies of the same audio sums +3 dB). Read once at startup; `scripts/fx-render-test.sh eqpower` and `controller/scripts/equal-power-seam.test.ts` pin it.
- `cross_stamps` is the only translator of a track's `liq_cross_duration` into end/start durations, and `strip_cross_stamps` removes them from `dj_transition`'s output. Keep the controller's contract: one stamp per track, governing that track's own end.
- A clip seam aligns on its cue lead by delaying the incoming side. That is sample-accurate on 2.4.6 only (`scripts/stem-seam-test.sh`).
- A `liq_cue_in` lands on the next codec frame at or after the cue, not on it. Only clip → Y compensates: the drain stamps `liq_clip_cue_late` on Y and `dj_transition` shifts Y by it, reading the stamp only when the outgoing side is the clip (#2003). A late landing delays Y. An MP3's early one (its encoder delay) is negative, and Y starts sooner out of `clip_seam_slack` (#2077). The per-codec rules are measurements of this decoder, so a decoder-priority change or an image bump re-runs `scripts/stem-seam-test.sh cuein`.
- A show-boundary cut (`liq_show_fade`) is a plain crossfade. Every arming line carries `not boundary_fading`, and `controller/scripts/show-boundary-drain.test.ts` checks it.
- Loop: apply `loop_gain` after the comb cascade and never add global makeup; snap `bar` to the frame and hold the dry gate one extra frame.
- Dissolve: sum the four combs and subtract the dry once, never per tap. Everything runs on one streaming thread (#1565). A host that still can't afford it switches off `transitions.effects.dissolve` rather than thinning the wash.
- A track shorter than the crossfade is eaten by the buffer and never airs, and the resolve probe cannot see it. The controller logs a `crossfade` booth line for a request (`swallowedByCrossfade`) and never declines it, and this is why `settings.minTrackSeconds` is `max(30, 2 × crossfade)`.

**Dead air and robustness**
- The emergency branch fades in over `EMERGENCY_FADE_SEC` and takes two fades (`switch` applies no transition to its first selection). Never delay the switch itself, and keep the return to music instant.
- Nothing in a `thread.run` callback may raise: an exception kills that thread for good, freezing the dead-air guard.
- Every `file.write(atomic=true)` carries a `temp_dir=` from its own `ensure_tmp_dir` line, one per writer. Without it the rename crosses devices on Docker and silently goes non-atomic.
- Pause voice acknowledgement: `poll_voice` writes `pause-talk-voice-accepted.json` only after `voice_queue.push`, `voice_marker` alone writes `pause-talk-voice-started.json`, and each has its own temp dir.
- `proto_subhttp` never judges a download by curl's exit code alone: Navidrome answers a missing file with 200 + JSON, so it also refuses json/xml/text bodies and files under 4 KiB. It records `ready`/`failed` under the handoff's probe id and redacts stream query strings in every log.
- The controller calls radio.liq's telnet commands by name over port 1234 (`restart`, `skip`, `auto.reload`, `auto.ready`, `jingles.reload`, `jingle_overlay_status`, `stream_*`, `idle_*`, `dj_queue_status`, `dj_queue_remove`, `subhttp_probe_status`), so renaming one breaks `broadcast/liquidsoap-control.ts`.

**Ducking**
- Use `smooth_add` only: an RMS follower drove the music to silence (`f38a9af`). `p` is the fraction of the music left up, so smaller is deeper. Never convert it to dB at a call site, and keep the shipped `duck_intro` default above `duck_voice` (a link should duck less than a solo ident). An operator may set them either way, so don't enforce the order. Both depths are read once at startup and bounds-checked here too, because a hand-edited file reaches the mixer directly.

**Outputs**
- The Opus encoder is hard CBR (`vbr="none"`), never VBR or DTX (#2138). Icecast's `<burst-size>` is a byte count sized from the bitrate, and constrained VBR coded idle silence at 1.6 kbps, so after an idle pause a new listener's burst reached back past the pause into stale music: on the rig (Opus 96k, 22 s buffer), live music arrived 51.9 s after connecting following a 30 s pause, and 140.2 s after a 120 s one. CBR brought both to ~23 s, as MP3's. Ogg framing adds ~1%, so the burst runs a little under `bufferSeconds`. `controller/scripts/opus-cbr.test.ts` pins every branch.

## Testing

`scripts/fx-render-test.sh` (`xchain`, `loopcheck`, `loopgaps`, `jingledry`, `jingleseam`) and `scripts/stem-seam-test.sh` render lifted copies of this file's blocks in Docker. A harness that has drifted from `radio.liq` proves nothing: `controller/scripts/dissolve-wash-shape.test.ts` and `transition-mixer-seams.test.ts` pin the mirrored harness copies to it, and `stem-seam-cues.test.ts` covers the stem-seam harness. `jingle-play.test.ts` pins radio.liq's jingle code directly. A harness that tests the dead-air guard must build the duck and bed `add`s; `output.dummy` on the bare rotate is how a false claim shipped once.
