# DJ "dissolve" transition — reverb wash into the next track

**Date:** 2026-07-03
**Status:** design approved pending review
**Depends on:** nothing at runtime (engine-agnostic); developed stacked on the
Liquidsoap 2.4.4 upgrade branch (#784) because that is what the dev stack runs.

## What

The fourth DJ transition effect: the OUTGOING track dissolves into a diffuse,
beatless ambient wash while the incoming pick rises clean through it. The
club "reverb throw": where the existing washout leaves a *rhythmic*,
tempo-synced echo tail that still says "something is ending", the dissolve
erases the outgoing track's transients and pulse entirely — what remains is
tempo-agnostic atmosphere, which is why DJs reach for it to hand over between
tracks whose tempo or mood clash.

It completes the effect taxonomy as the smooth counterpart to the sweep:

|                       | Compatible tracks  | Clashing tracks           |
|-----------------------|--------------------|---------------------------|
| **Rhythmic gesture**  | blend (EQ handover)| washout (echo tail)       |
| **Textural gesture**  | sweep (filter choke — announces the change) | **dissolve (ambient wash — hides the change)** |

Naming: `dissolve` (agent enum, annotations, logs, admin). "Wash" was
rejected — too close to "washout" in the same enum; the LLM would mispick and
logs would be ungreppable.

## Decisions (made with the operator)

1. **Gate: clashing tracks only** — `effectAllowedFor('dissolve')` requires
   measured compatibility `< 0.4` (the exact mirror of blend's `>= 0.4`),
   following the same analysed-tracks precondition as the sweep. The agent
   picks WHICH clash deserves hiding; the data decides whether it IS a clash.
2. **Name: `dissolve`** — enum becomes
   `normal | blend | sweep | washout | dissolve`.

## Constraints (all inherited, all non-negotiable)

- **Proven primitives only.** Native `echo` is a bit-identical no-op and
  `filter.rc mode="high"` renders silence on BOTH v2.2.5 and v2.4.4 (verified
  by render this session). The working PCM kit inside a cross callback is:
  `comb` (getter-controlled feedback), `filter.rc mode="low"` (getter cutoff +
  wetness), `fade.in/out`, `amplify`, `add` — the same kit the washout and
  sweep are built from.
- **Per-branch, inside `dj_transition`.** No effect operators on the idle bus.
- **Envelopes are pure functions of `source.elapsed()`** on the transition
  branch — audio-time-accurate, no threads, no shared state.
- **The tail must be silent before the window closes** (the transition source
  is truncated at `d`) or it clicks off — same constraint the washout's
  feedback release already handles.
- **Fade == buffer invariant** holds: the dissolve manipulates the WET path;
  the dry path stays a standard `fade.out` shape so the summed cross can never
  hit the +6 dB doubling hazard.

## Architecture — who carries what

Exactly the sweep's pattern, because the intent is the same shape ("do
something to the track I'm taking over from"):

- **Flag rides the INCOMING pick's annotation**: `liq_dissolve="true"` on `b`.
  The agent says "dissolve the current track under my pick". No arming, no
  `remaining()` watcher, no race with a request jumping the queue.
- **Effect applies to the OUTGOING branch** (`a`) inside `dj_transition`.
- **No canvas stamp needed.** Like the sweep (and unlike the washout), the
  dissolve scales to whatever `d` it receives — the transition into the pick
  is already sized by `a`'s own `liq_cross_duration` stamp (now always
  present after #784's always-stamp change; on 2.2.5 the startup default
  applies — either way `d` is well-defined).
- **Precedence when both shape `a`'s exit**: if the outgoing track carries its
  own `liq_washout` flag (a previous pick's washout, or the length-cap
  auto-washout), the **washout wins** and the dissolve is ignored for that
  transition. Enforced in `radio.liq` (the `washing` branch is checked first);
  the controller does not need to coordinate across picks.

## DSP design (radio.liq)

Chosen approach — **Schroeder-style parallel comb cluster** (approach A below).

The `a` branch when `b.metadata["liq_dissolve"] == "true"` and not `washing`
(as tuned in Phase 1 — see "What the renders changed" below):

```
dry:  fade.out(duration=d, initial_metadata=a.metadata, a.source)
      — the STANDARD linear fade, deliberately NOT the washout's early exp
        drop: a real reverb throw is thrown while the track still plays and
        the fader comes down later. The still-hot dry continuously re-seeds
        the comb loops across the cross; an exp drop starved them after
        ~2 s and left a −44 dB mid-cross crater no feedback setting could
        fill without going near-unity-unstable.

wet:  PURE TAILS — for each tap, comb(src) + amplify(-1., src) isolates the
      feedback tail from the comb's dry pass-through (the twin-consumer
      null the blend already relies on), so the dry rides the faded path
      exactly once and the tails can be weighted hot (0.7 each).
      4 parallel combs, mutually prime delays 89 / 113 / 151 / 181 ms.
      Tail decay = feedback ÷ delay per second, so short taps need
      near-unity feedback — the design constraint that killed the first
      cut (43–101 ms at −2.5 dB/pass = 25–58 dB/s, inaudible).
      Shared feedback getter (dB):
        swell  −90 dB → −0.5 dB over the first 10% of d (must beat the fade)
        hold   to 80% of d
        release back to −90 dB by 93% of d      ← tail dead before truncation
      → damping: filter.rc lowpass ×2 cascaded on the wet sum,
        cutoff getter closing 7 kHz → 1.2 kHz across the cross (the tail
        darkens with "distance"), wetness ramping 0 → 1 over the first 10%
        of d (an RC engaged full-wet at cross start lands as an instant
        dulling — the sweep taught this on-air)
      → makeup: amplify getter 1.0 → 1.3 between 25% and 50% of d — mild;
        with continuous seeding the wash needs presence, not rescue.

mix:  add(normalize=false, [dry, wet])
b:    untouched — plain fade.in(d); the pick rises clean through the wash.
```

### What the renders changed (Phase-1 findings)

Three revisions, each driven by an RMS-over-time table against the dry
render of the same real track pair:

1. **43–101 ms taps at −2.5 dB/pass were inaudible** (render byte-near-dry):
   per-pass feedback divides by the tap length per second of decay. Moved to
   89–181 ms and −0.5 dB/pass.
2. **The washout's exp dry-fade starved the loops** — mid-cross fell to
   −44 dB against dry's −19 dB (an anti-effect: the dissolve read as "the
   music vanished early"). Switched the dry to the standard linear fade;
   the wash then rides 2–4 dB above the plain crossfade for the whole
   window and converges with it by ~80% of d.
3. **Summing whole combs forced a 0.25 weight** (dry ×4 otherwise), burying
   the tails 12 dB before they started. Pure-tail isolation
   (comb − input) freed the weights; makeup relaxed from 2.2 → 1.3 after
   the change (peak checks confirmed the wash adds no clipping — the test
   masters themselves peak at 0 dBFS).

### Approaches considered

- **A. Parallel comb cluster (chosen)** — same operator class already proven
  inside the callback on both engines by `fx-render-test.sh probe`; CPU cost
  is 4 combs + 2 RC filters per transition (transition-scoped, idle bus
  untouched). Risk: metallic ringing without allpass diffusion — mitigated by
  prime-spread delays, heavy damping, and the fact that the wash sits UNDER a
  rising track rather than exposed.
- **B. `ffmpeg.filter` aecho/reverb chain** — richer diffusion, but an
  unproven operator class inside the cross callback on a
  `request.queue`-backed source (the historical "Early computation of source
  content-type" crash family), heavier, and behaviour would need re-proving
  on both engine generations. Rejected for now; worth revisiting if A sounds
  too metallic.
- **C. Convolution with a pre-rendered impulse response** — no convolution
  operator exists in either build. Not viable.

## Controller changes

Small, and every one follows an existing pattern:

- **`music/mix.ts`** — `effectAllowedFor` gains `'dissolve'`: requires both
  tracks analysed and `mixCompat < 0.4` (mirror of blend; same analysed
  precondition as sweep). Comment the taxonomy table.
- **`broadcast/dj-agent.ts`** — add `dissolve` to the transition Zod enum +
  schema description: *"the track before your pick dissolves into a diffuse
  ambient wash as your pick rises clean through it — the SMOOTH way across a
  clash (sweep is the dramatic way); choose it for a tempo/mood mismatch you
  want to hide rather than announce; only fires when the tracks measurably
  clash"*.
- **Pool-picker effect path** (`music/picker.ts`, from #767's "transition
  effects on the pool pick path") — add `dissolve` wherever sweep is offered.
- **`broadcast/queue.ts`** — `applyMixTransition`: validate `dissolve` via
  `effectAllowedFor`, stamp `item.track.dissolve = true` on pass, and extend
  `stripEffect` (dj-mode-off, no-predecessor, rejected-flag paths) to clear it.
- **`music/subsonic.ts`** — `getAnnotatedUri` emits `liq_dissolve="true"`
  when `song.dissolve` (exactly the `liq_sweep` line).
- **Prompt layer** (`llm/internal/prompts/system.ts` TRANSITION EFFECTS
  block) — add the dissolve bullet; explicitly contrast with sweep (dramatic
  vs smooth across the same clash) and washout (rhythmic tail vs beatless
  wash) so the LLM picks between them deliberately.

## Testing

1. **Phase 0 (already satisfied)** — the probe proves `comb` + `filter.rc`
   instantiate inside the cross callback and touch audio on v2.2.5 AND
   v2.4.4. Four parallel combs are the same operator class; no new probe
   needed unless renders behave strangely.
2. **Phase 1 — render tuning**: add a `dissolve` mode to
   `scripts/fx-render-test.sh` (envelope logic mirrored from radio.liq, as
   for the other four modes). Render with two real library tracks on BOTH
   engine images; deliverables are the WAVs (by-ear listening) + RMS-over-time
   tables (no level hole deeper than the washout's, tail silent by 0.95 d).
3. **Live verification on the running dev stack** (2.4.4 worktree): push two
   deliberately clashing analysed tracks through `next.txt` with
   `liq_dissolve="true"` on the second, confirm the radio.log line
   (`DJ dissolve: …`) and capture the stream across the transition.
4. **Agent path**: leave the stack running; confirm the agent eventually
   proposes `dissolve` and the gate validates/strips it correctly
   (`[mix] dissolve armed` / `dropped` log lines).
5. **Lint** (`controller npm run lint`) — the merge gate.

## Out of scope

- Any change to the existing four transitions' envelopes.
- `ffmpeg.filter`-based diffusion (approach B) — future refinement.
- Admin UI surfacing beyond what effects already get (they appear via logs /
  djLog; no new settings — the effect obeys the existing persona `djMode`).
- Back-porting to a 2.2.5-only branch: the DSP is engine-agnostic, but the
  code lands stacked on #784.
