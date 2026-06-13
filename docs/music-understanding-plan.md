# Plan: richer acoustic analysis

## Why

SUB/WAVE's acoustic analysis is **scalar**. `analyze_worker.py` runs librosa and
emits one `bpm`, one `musicalKey`, one `introMs`, one `confidence`, plus an
optional CLAP audio vector (`analyzer.ts:20-30`); those land in the tracks table
and feed the picker's re-rank and the `slimTrack` projection
(`library.ts:150-166`). Mood/energy come from a *separate*, text-driven pipeline
(enrich → embed → seed → propagate → active-learn, `tag-library.ts`) and are
likewise coarse: a handful of mood strings plus a `low/medium/high` energy band.

The limitation that matters for a radio station: our analysis is
**whole-track, not time-ranged**. Music changes within a song; collapsing a
track to a single BPM or key or energy band throws away precisely the signal a
DJ uses to mix, talk, and sequence. The richer model is to analyse **over time
ranges** — key, pace, structure, and instrument activity that vary across the
song — and store those alongside the existing scalars. This doc captures that
plan so development can start later.

### The analysis dimensions

Six candidate result types, each computed on-device in our Linux Python sidecar
and storable as a nullable column:

| Analysis | Shape | What it carries |
|---|---|---|
| **Rhythm** | `beats: [ms]`, `bars: [ms]`, `bpm: float?` | per-beat + per-bar timestamps, plus tempo |
| **Key** | `[{startMs, endMs, tonic, mode}]` | tonic (enharmonic-preserving) + mode (major/minor) **over time ranges** |
| **Loudness** | integrated + optional peak | perceptual LUFS, ITU-R BS.1770 |
| **Pace** | `[{startMs, endMs, value}]` | perceptual energy/momentum, **decoupled from BPM** |
| **Structure** | `sections: [{startMs, endMs}]` | intro/verse/chorus-style boundaries |
| **Instrument activity** | `[{startMs, endMs}]` per stem | vocal / drum / bass / other activity ranges |

Two JSON shapes carry these: an **instant sample** (`{ms, value}` — a value at a
point, e.g. loudness samples, beat hits) and a **span value**
(`{startMs, endMs, value}` — a value that holds over a region, e.g. key, pace, a
structural section). Instantaneous things are timed; things that hold over a
region are ranged. If we add any of the below, adopt that split rather than
inventing ad-hoc array shapes — and version it with the existing
`ANALYSIS_VERSION` discipline.

## Scope

Six candidate features, each independently shippable and each degrading cleanly
to today's behaviour when its column is NULL (un-analysed library, or a backend
that doesn't compute it). Ordered by ROI **for radio**. Phases 1–3 are the
recommended near-term set; 4–6 are follow-ups.

Everything is computed in the existing heavy-DSP path. `analyze.ts` /
`analyzer.ts` already give us a resumable, batched, two-backend (tts-heavy
sidecar + local venv) pass with a one-ahead prefetch pipeline; we bolt new
outputs onto the same decode, exactly as the CLAP work did
(see `docs/audio-embeddings-plan.md`).

---

## Phase 1 — Integrated loudness (LUFS) → gain normalisation

**Highest ROI, lowest effort.** We have *no* perceptual loudness today, and
CLAUDE.md records that the Liquidsoap normaliser and bus-compressor were
deliberately removed because they "reshaped the masters" (broadcast bus is a
brick-wall limiter only, step 8). LUFS solves that the right way: measure, don't
reshape.

- **Worker** (`analyze_worker.py`): compute **integrated loudness** over the
  decoded window with `pyloudnorm` (ITU-R BS.1770 / EBU R128, ~10 lines on the
  audio we already decode). Emit `loudness_lufs` (a float) and optionally
  `peak_db`. Gate behind nothing — it's cheap; just add the fields.
- **Storage** (`library-db.ts`): a nullable `loudness_lufs` column on the tracks
  table, written alongside bpm/key in `upsertTrackAnalysis`
  (`analyze.ts:135-140`), under the same `ANALYSIS_VERSION` bump.
- **Playback** (`subsonic.ts:getAnnotatedUri`): translate LUFS to a per-track
  **gain offset** toward a target (e.g. −14 LUFS) and fold it into the
  `annotate:` string Liquidsoap already consumes. Quiet and loud tracks then
  play at consistent perceived loudness with **zero** changes to the master bus
  — no normaliser, no compressor, masters untouched. This is the cleanest win on
  the board and directly retires a known workaround.

**Done when:** a mixed-loudness library plays at even volume and the master bus
is still just the limiter.

## Phase 2 — Song structure (intro / outro / section boundaries)

We only have `introMs` today. Full structural time-ranges are, for radio, the
highest-value addition after loudness because they make two existing systems
*musical* instead of fixed.

- **Worker**: segment the decoded audio into structural boundaries with
  `librosa` (recurrence-matrix / spectral-clustering segmentation) or `msaf`.
  Emit at least `sections: [{startMs, endMs}]`; the leading and trailing
  sections give a far better intro/outro than the current single `introMs`.
- **Storage**: a `structure_json` column (typed — an array of
  `{startMs, endMs, kind?}` spans), versioned.
- **Crossfade** (`radio.liq`): the cross is currently a **fixed buffer**
  (CLAUDE.md step 3). Knowing where the final section/outro begins lets the
  controller pick a cross length and start point that land on a real boundary
  instead of blindly. Keep CLAUDE.md's rule — fade duration equals the buffer;
  vary the *buffer*, never the fade-within-buffer.
- **Talk timing** (`broadcast/queue.js` `announce()`): schedule station
  IDs / links to land over the **instrumental** intro/outro, never mid-section.

**Done when:** the DJ talks over intros, not vocals, and crossfades begin at
section boundaries.

## Phase 3 — Instrument activity (vocal presence)

Source separation splits audio into vocal / drum / bass / other activity over
time. The single most useful slice for us is **vocal-presence ranges**.

- **Worker**: run a source-separation model — **Demucs** (htdemucs) is the
  standard — and derive per-stem activity envelopes; at minimum a boolean/0–1
  **vocal-activity** track over time. This is the heaviest lift here (a real
  model in the sidecar), but it reuses the existing heavy-sidecar pattern and
  can stay gated behind an env flag like CLAP (`ANALYZE_AUDIO_EMBEDDING`).
- **Storage**: `vocal_ranges_json` (`[{startMs, endMs}]`), versioned; optionally
  full per-stem activity if cheap to keep.
- **Payoff (a):** the two-layer `smooth_add` ducking (CLAUDE.md step 5) gets a
  *content-aware* partner — talk-up only where there are no vocals.
- **Payoff (b):** a much better intro/outro detector than `introMs` ("leading
  region with no vocal activity") — overlaps with and sharpens Phase 2.

**Done when:** the DJ never talks over a vocal line, and intro detection comes
from vocal absence rather than a heuristic.

## Phase 4 — Pace (tempo-independent energy curve)

`energy` today is a coarse whole-track `low/medium/high` LLM tag
(`tag-library.ts`). Pace is a **continuous** perceptual energy curve, explicitly
decoupled from BPM (e.g. a high-BPM track reads *low* pace during a sparse
breakdown).

- **Worker**: approximate via onset-rate / spectral-flux energy over windows;
  emit `pace_curve: [{startMs, endMs, value}]` (span-shaped).
- **Storage**: `pace_json`, versioned.
- **Payoff**: energy-aware sequencing in `music/picker.ts` — build/release arcs,
  avoid stacking two peaks, match transitions on energy not just genre/mood.
  Complements the sonic-journey idea in `docs/audio-embeddings-plan.md` (audio
  KNN says "sounds like"; pace says "has the energy shape I want next").

## Phase 5 — Beat / bar grid (beatmatched crossfades)

Per-beat and per-bar timestamps, not just BPM — `librosa.beat` already gives us
these; we currently **discard** them and keep only the scalar.

- **Worker**: emit `beats: [ms]` and `bars: [ms]` (or downbeat positions)
  alongside the existing `bpm`.
- **Storage**: `beats_json` / `bars_json`, versioned.
- **Payoff**: align a crossfade to land on a **downbeat** and choose a
  bar-aligned cross length — a beatmatched mix instead of a blind fade. Pairs
  naturally with Phase 2's boundary-aware crossfade.

## Phase 6 — Structured key (tonic + mode) over time

`musicalKey` is one string today. Keep **tonic** (enharmonic-preserving) and
**mode** (major/minor) as separate structured fields, *over ranges*.

- **Worker**: chroma over windows → key per region; emit `key_ranges:
  [{startMs, endMs, tonic, mode}]`.
- **Storage**: structured columns / `key_ranges_json`, versioned. Keep the
  legacy scalar `musical_key` populated (dominant key) for back-compat.
- **Payoff**: harmonic / Camelot-wheel mixing — "mix into a key-compatible
  track." Lower priority for a personal station, but cheap to store correctly
  once we're already computing chroma.

---

## Cross-cutting notes

- **Schema discipline.** Every new output is a nullable column written by
  `upsertTrackAnalysis`, gated by `ANALYSIS_VERSION` so a bump re-targets tracks
  via `needsAnalysisIds` (`analyze.ts:72`) without a full `--re-analyze`. Same
  resumability and provenance the pipeline already has.
- **Graceful degradation is mandatory.** Mirror the CLAP precedent: a backend
  that doesn't compute a field simply omits it, the column stays NULL, and every
  consumer treats NULL as "no signal" — byte-for-byte today's behaviour. No new
  feature may make the analysis pass a hard failure.
- **Instant vs span shapes.** Adopt the two shapes as the convention for all
  time-aware columns: `{ms, value}` for instants, `{startMs, endMs, value}` for
  spans. Keeps the JSON columns self-describing and consistent.
- **What this is.** The deliverables live entirely in `analyze_worker.py`,
  `library-db.ts`, `subsonic.ts`, and `radio.liq`.

## Suggested order

**1 → 2 → 3** is the recommended near-term track: loudness retires a known
workaround immediately; structure and vocal-activity then combine to make
crossfades and talk-timing musical (they share the intro/outro payoff). 4–6 are
independent follow-ups that sharpen sequencing and mixing once the structural
foundation exists.
