# Stem-aware transitions — research & feasibility (Neural Mix study)

*Research notes, July 2026. Status: **proposal / not implemented.** This doc
captures what Algoriddim's Neural Mix actually is under the hood, what SUB/WAVE
already has that maps onto it, and ranked options for building a radio-grade
equivalent. Written to be the starting point when we pick this up.*

---

## TL;DR

**Neural Mix is real-time AI stem separation.** djay splits any song into
vocals / drums / instruments on the fly and builds its mixing features on top:
per-stem faders and EQ, instant acapella/instrumental, and stem-aware automatic
transitions. The hard engineering — a compressed neural net running with
near-zero latency on Apple's Neural Engine — exists only because a human DJ can
scratch or seek anywhere at any moment.

**SUB/WAVE doesn't need the hard part.** A radio station knows its next track
minutes in advance and transitions happen at one known window, so separation
can run *offline, on just the transition windows*, on CPU, with a bigger and
better model than a phone can afford. Roughly half the required stack already
exists in this repo: Demucs ships in the heavy analyzer image, and DJ-mode
transitions already do ending analysis, beat/bar grids, BPM/key compatibility,
and six live transition effects. The missing piece is keeping the stems (today
Demucs runs and then discards everything except vocal-activity timestamps) and
a playback path for a pre-rendered blend.

**Recommended sequence:** [Option A](#option-a--vocal-aware-transitions-ship-first)
(vocal-aware crossfades + talk-over gating — small, reuses every existing pipe)
→ [Option B](#option-b--pre-rendered-stem-transitions-the-flagship) (pre-rendered
stem transitions — the flagship). Options C/D are documented as rejected.

---

## Part 1 — What Neural Mix actually is, layer by layer

Neural Mix isn't one model — it's a four-layer stack. Worth separating because
SUB/WAVE already has equivalents for two of the layers.

### Layer 1: Source separation (the namesake)

Splits any track into three stems — vocals, drums ("beats"), and
instruments/harmonic — in real time, with no pre-processing or special encoding
(unlike Native Instruments STEMS, which needed specially-mastered files).

- **v1** (djay Pro AI, March 2020): per CDM's reporting, based on Deezer's
  open-source **Spleeter**, ported to Core ML.
- **v2** (djay Pro 5, Dec 2023): replaced with **AudioShake's** proprietary
  models after ~a year of joint engineering. AudioShake called fitting large
  separation models on-device in real time "a big technical challenge — one
  made particularly difficult with audio, where the sound needs to be separated
  in high resolution."
- Quality auto-scales in tiers (Medium 70% / High 80% / Maximum 100%) by
  hardware: Apple Silicon / A13+ gets the full model, older chips a smaller one.

### Layer 2: On-device inference optimization

Where most of Algoriddim's engineering went — and the layer a radio station can
skip entirely. Sample-accurate seeking and scratching means separation must be
computable at any playhead position instantly. They run on Core ML across
CPU + GPU + Neural Engine, claiming prediction "up to 40× faster than on modern
computers" and "virtually zero latency."

### Layer 3: Musical analysis

- **Fluid Beatgrid** (djay Pro 5): a dynamic beat grid that follows tempo
  fluctuations and interruptions, so stems from two decks stay aligned even on
  non-quantized music.
- Key detection, and **tempo Morph** — time-stretch beat-matching that holds
  the playing track's BPM when the incoming tempo is close.

### Layer 4: Transition intelligence

- **Automix AI** (djay Pro 2, 2017, refined since): trained on recordings of
  human DJs to pick the best intro/outro transition points, fade durations,
  and live EQ moves.
- **Crossfader Fusion** (djay Pro 5, patented): transition *presets* —
  automation curves binding stem gains + filters + effects to crossfader
  position. E.g. the "Neural Mix (Harmonic Sustain)" preset holds the outgoing
  track's harmonic stem while the incoming track's beat takes over. These
  presets run automatically in Automix mode — exactly the hands-off radio
  scenario.
- Automix transition types include: Automatic, Fade, Filter, EQ, Echo,
  Dissolve, Neural Mix.

The product features all fall out of these layers: per-stem faders/EQ, instant
acapella/instrumental extraction, per-stem colored waveforms recomputed live,
and vocal-clash-free automatic transitions.

---

## Part 2 — What SUB/WAVE already has

Mapped from the codebase as of July 2026 (branch `develop`). Load-bearing
facts:

### Separation already ships (but discards its output)

- `subwave-analyzer-heavy` bakes **Demucs `htdemucs`** (`WITH_DEMUCS=1`,
  `demucs==4.0.1`, CPU torch 2.6.0) — see `docker/Dockerfile.analyzer`.
- `controller/scripts/analyze_worker.py` → `VocalActivityDetector`: runs the
  **full 4-stem separation**, keeps only the vocals stem's RMS envelope as
  `vocal_ranges` timestamps, and **discards the drums/bass/other audio
  entirely**. It also only sees the first `ANALYZE_SECONDS` (default 40s) of
  each track — the outro window (last 20s, decoded separately for
  `analyze_outro`) never gets a vocals pass.
- No stem audio is cached anywhere; `state/analyze-tmp/<id>.audio` is deleted
  after each track.

### Layer 3/4 equivalents largely exist

- Per-track BPM, key (Camelot compat math in `controller/src/music/mix.ts`:
  `bpmCompat`, `keyCompat`, `mixCompat`), beat/bar grids (`beats_json`,
  `bars_json`), LUFS normalization (`gainForLoudness`, −14 LUFS target).
- **Ending-aware exit canvas** — the Automix-AI analog: `outro_json`
  (fade-vs-cold, tail LUFS/tempo/bars) → `endingCrossSecondsFor` stamps each
  DJ-mode track's own crossfade seconds (`queue.applyMixTransition`,
  `controller/src/broadcast/queue.ts`).
- **Six transition effects** — the Crossfader-Fusion analog, minus stems:
  washout / loop (exit-side) and sweep / dissolve / blend / chop (entry-side),
  synthesized live per-frame inside `dj_transition` (`liquidsoap/radio.liq`),
  driven by per-track `annotate` flags (`liq_washout`, `liq_sweep`, …) built in
  `subsonic.getAnnotatedUri`. The DJ agent proposes the effect; `effectAllowedFor`
  disposes.
- **Liquidsoap 2.4.5** supports per-track cross duration (`liq_cross_duration`,
  already used on every track) and cue points (`liq_cue_out` already used for
  the length cap; `liq_cue_in` is currently unused but is a small `radio.liq`
  change — `cue_cut` at the top of the chain takes both labels).

### Constraints to design within

- Analyzer is **CPU-only** (no CUDA build), **single-request-at-a-time**
  (`StdioWorker` lock in `docker/analyzer/server.py`), 120s per-request budget
  (`ANALYZE_REQUEST_TIMEOUT_MS`), 6 GB memory cap, heavy image is amd64-only.
- No scheduled background analysis — passes run via `npm run tag`,
  `npm run analyze`, or admin buttons, single-flight via pidfile lock.
- **The #749 problem** (`queue.ts`, `applyMixTransition` step 1): a *pair-sized*
  crossfade can't be stamped at annotate time because `liq_cross_duration`
  governs the stamped track's own end and the successor is unknown when the
  track is annotated. `crossSecondsFor` (the pair-adaptive blend) is computed
  but deliberately never applied. Any stem-transition design must solve this —
  Option B does, structurally.

---

## Part 3 — Options, ranked

### Option A — Vocal-aware transitions (ship first)

Extend vocal detection to the **outro window**: the tail is already downloaded
and decoded for `analyze_outro`; run the existing Demucs vocals pass on it too
(a few seconds of extra compute per track, heavy tier only). Store tail vocal
ranges alongside `outro_json`. Then:

1. **Avoid vocal-over-vocal clashes** — in `mix.ts`, when the outgoing tail has
   vocals *and* the incoming intro has vocals (intro `vocal_ranges` already
   exist), tighten or shift the crossfade window.
2. **Gate DJ talk-over links** — `announce({kind:'link'})` → `intro.txt` rides
   *over the incoming track's intro*; hold or shorten links when the intro is
   vocal, using the stored `vocal_ranges`.

Cheap, reuses every existing pipe, and fixes the most audible amateur-DJ
artifact — which is most of what Automix AI's live EQ moves are protecting
against.

### Option B — Pre-rendered stem transitions (the flagship)

When the DJ agent picks track B while A is still playing (minutes of lookahead),
kick off a render job on the analyzer:

1. **Get window stems** for A's tail (~30s) and B's head (~30s) — from the
   [stem cache](#the-stem-cache-analyzer-change) when present; on a miss,
   fetch the window (the byte-capped ranged download machinery exists —
   `downloadCapped` / worker `fetch_audio`) and separate it on the spot.
2. **Separate** any uncached window with Demucs 4-stem. ~60s of audio on CPU is
   roughly real-time-comparable with `htdemucs` — inside the 120s budget, and
   the lookahead absorbs it; with warm cache this step is skipped entirely and
   the job is a fast mix. (New worker op, reusing the already-loaded model
   from `VocalActivityDetector`; better: a single `transition-render` op that
   does separate + align + mix server-side and returns a WAV path on the shared
   volume, so no stem audio ever crosses a boundary.)
3. **Align** using the stored beat/bar grids. Gate on `bpmCompat` — only
   stem-mix when tempos are within a few percent or a clean half/double.
   (Rubberband micro-stretch is a later enhancement, not a prerequisite.)
4. **Render a blend** from a preset — e.g. *harmonic sustain* (hold A's "other"
   stem while B's drums enter), *beat carry* (A's drums loop under B's intro),
   *acapella out* (A's vocal rides alone over B's intro) — normalize to
   −14 LUFS, small overlap fades at the seams, write one WAV.
5. **Queue** through the existing single-writer (`queue.push` →
   `drainToLiquidsoap`): A with `liq_cue_out` at the blend start, the rendered
   clip as its own queue item, B with `liq_cue_in` past the pre-mixed head,
   near-zero `liq_cross_duration` at the clip seams. The clip must not fire
   now-playing as its own track (annotate it to carry B's metadata, or suppress
   and let B's cue-in metadata land).

Why this shape is right:

- **Skips djay's Layer 2 entirely** — no real-time model, no latency
  engineering, and the model can be *better* than a phone's: current
  open-source SOTA (BS-RoFormer / Mel-Band RoFormer, ~11–12 dB vocal SDR vs
  htdemucs' ~9) is available via ZFTurbo's MSST repo as a future quality tier.
- **Structurally solves #749** — the render job runs after *both* tracks are
  known, so the pair-sized transition becomes a file and the
  annotate-time-successor-unknown problem disappears.
- **Degrades the house way** — any render failure/timeout falls back to the
  normal `dj_transition` path, exactly like TTS falls back to Piper. Gate on
  the heavy analyzer's capability flag + DJ mode + an admin toggle (the
  `archive_enabled` opt-in pattern).

Open design points when implementing:

- `liq_cue_in` support in `radio.liq`'s `cue_cut` (currently only
  `liq_cue_out`).
- Whether rendered *clips* (as opposed to stems) are worth caching at all —
  they're pair+preset-specific, so hits are rare; probably delete after air
  like TTS WAVs.
- Preset selection: let the pick agent propose (like `transition:` today),
  data disposes (`effectAllowedFor`-style gate on tempo/key/vocal facts).

### The stem cache (analyzer change)

The separation cost mostly disappears if the analyzer stops throwing its work
away. Two facts make this cheap:

1. **The head stems are already computed.** When vocal detection runs at tag
   time (heavy tier), Demucs produces all four stems for the first 40s — the
   track's *head*, exactly the window Option B needs from the incoming track —
   and then discards everything except the vocals RMS envelope. Writing those
   stems to disk as a side effect of the existing pass is near-zero extra
   compute.
2. **The tail audio is already downloaded.** Outro analysis decodes the last
   ~20s of every complete file; running Demucs on that window too is an
   incremental step (~+50% separation time per track, heavy tier only, and
   only on complete downloads — the same rule outro analysis follows).

With both windows cached, the pick-time render drops from "separate two
windows, then mix" (~a minute of CPU) to "mix cached stems" (seconds), and the
single-in-flight analyzer worker stops being a contention concern — the heavy
step moved into the one-time analysis pass.

**What we deliberately do NOT keep: the raw download.** It's byte-capped at
12 MiB (often incomplete), Navidrome can serve it again anytime, and fetching
is the cheap step. `state/analyze-tmp/<id>.audio` keeps its delete-after-track
behaviour. Stems only.

**Disk math** (why the cache is capped/opt-in, not unconditional):

| Storage | Per track (2 windows × 4 stems, ~60s) | 5k-track library |
| --- | --- | --- |
| Raw WAV | ~42 MB | ~210 GB — no |
| FLAC | ~25 MB | ~125 GB — no |
| Opus 160–192k per stem | ~6–8 MB | ~30–40 GB — viable opt-in |

Lossy stems are fine here: they get remixed and re-encoded to the stream codec
anyway.

**Recommended shape:** an LRU cache under `state/stems/<id>/`, size-capped in
settings. Populated two ways: opportunistically at tag time (head stems free,
tail stems the +50% increment, gated on the same heavy-tier opt-in as vocal
detection) and lazily on first use (a cache miss at render time separates on
the spot and stores the result). A radio station replays a mood-shaped subset
of the library heavily, so even a few-GB cache hits constantly. Backfill works
like the existing `--vocal` backfill: already-analyzed tracks get stems on a
re-analysis pass or lazily on first use.

The cache changes the render job's *cost*, not its existence — the blend is a
pair artifact and the pair is only known at pick time.

### Option C — Live per-stem buses in Liquidsoap (rejected)

djay's actual architecture: pre-separate whole tracks, cache 4 stems per song,
play 4 sample-aligned sources per deck with stem-gain automation in
`dj_transition`. Rejected: 4× library disk, full-file separation cost, fragile
multi-queue sample alignment in Liquidsoap — for no audible benefit over
Option B in a non-interactive stream.

### Option D — Real-time separation on the live bus (rejected)

The part of Neural Mix that only exists because a human can scratch. CPU-only
Docker can't do it, and radio lookahead makes it pointless.

---

## Naming / IP note

Algoriddim holds patents on Neural Mix and Crossfader Fusion, and both names
are trademarked. An open-source, server-side, offline-rendered implementation
is a materially different approach — but the feature needs its own name
(working candidates: "stem blends", "deep transitions"). Don't ship their
trademarks in UI copy.

---

## Sources

- [Algoriddim — Neural Mix](https://www.algoriddim.com/neural-mix)
- [CDM — djay Pro adds real-time AI separation](https://cdm.link/djay-pro-ai-stem-separation/) (Spleeter/Core ML reporting)
- [Algoriddim — djay Pro 5 press release](https://www.algoriddim.com/press_releases/447-algoriddim-unveils-djay-pro-5-with-next-generation-neural-mix-crossfader-fusion-and-fluid-beatgrid-)
- [AudioShake — Neural Mix collaboration](https://www.audioshake.ai/post/algoriddim-djaypro-neural-mix)
- [Algoriddim support — Neural Mix device compatibility & quality tiers](https://help.algoriddim.com/topic/using-djay/neuralmix-compatibility)
- [Algoriddim support — Automix settings & transition types](https://help.algoriddim.com/user-manual/djay-pro-mac/settings/automix)
- [DJ TechTools — djay Pro 2 Automix AI](https://djtechtools.com/2017/12/12/algoriddim-releases-djay-pro-2-mac-ai-automix-voiceover-accessibility/)
- [Demucs (facebookresearch)](https://github.com/facebookresearch/demucs)
- [HT-Demucs ONNX/CPU benchmarks](https://stemsplit.io/blog/htdemucs-ft-onnx-export)
- [Demucs on Apple Silicon MLX (34× real-time)](https://medium.com/@andradeolivier/i-ported-demucs-to-apple-silicon-it-separates-a-7-minute-song-in-12-seconds-6c4e5cffb5c3)
- [BS-RoFormer paper](https://arxiv.org/pdf/2309.02612) · [Mel-Band RoFormer paper](https://arxiv.org/abs/2310.01809)
- [ZFTurbo — Music Source Separation Training (SOTA models & benchmarks)](https://github.com/ZFTurbo/Music-Source-Separation-Training)
