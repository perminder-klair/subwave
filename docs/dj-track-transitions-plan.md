# DJ track transitions — plan

Today there is exactly one move between tracks: a symmetric equal-amplitude
crossfade, `crossfade_duration` long, the same shape every time. This plan
gives the station a small **library of DJ-style transitions** in
`liquidsoap/radio.liq` and then lets the **LLM picker choose one per
transition**, alongside the track itself, reusing the `annotate:` URI
that already carries metadata into Liquidsoap. No new IPC channels, no
new model calls — one extra field on the existing picker output.

## TL;DR

Two phases on the `claude/dj-track-transitions-4zZow` branch:

1. **Phase 1 — instrument.** Add a library of 5–6 named transitions in
   `radio.liq` (`fade`, `long_blend`, `echo_tail`, `eq_swap`,
   `filter_sweep`, `hard_cut`). Pick the style randomly per transition,
   read from `next.metadata["transition"]` if present. Ship it on its
   own — the station already sounds better than the symmetric fade.
2. **Phase 2 — let the AI play it.** Add a `transition` field to
   `pickNextTrack`'s Zod schema in `controller/src/llm/dj.ts`, plumb it
   through `getAnnotatedUri()` in `controller/src/music/subsonic.ts`
   into the `annotate:` URI as `transition="…",liq_cross_duration="…"`,
   and let `dj_transition` in `radio.liq` dispatch off the metadata.
   The same call that already decides *which* track plays next now also
   decides *how* it lands.

Build the instrument before letting the AI play it. Phase 1 is shippable
on its own; phase 2 is a small additive layer on top.

## Why this slots in cleanly

Three properties of the existing pipeline make this almost-free:

- **`annotate:` URI already carries per-track metadata.** Liquidsoap's
  `cross` callback receives `next.metadata` and Liquidsoap honours
  `liq_cross_duration` as a per-track override of the cross buffer
  width. Anything we put into the annotate URI is readable inside
  `dj_transition(a, b)`.
- **`getAnnotatedUri()` is one function.** Every track that reaches
  Liquidsoap goes through `controller/src/music/subsonic.ts:263`. Add
  two fields there, done.
- **The picker already has the context.** `dj.pickNextTrack` already
  sees the outgoing track, mood, time-of-day, recent plays, candidate
  energy/mood tags. The transition decision is downstream of exactly
  the same context — energy delta, genre shift, narrative beat — so
  adding it is one more schema field, not a new agent call.

## Phase 1 — transition library in `radio.liq`

Replace the single `dj_transition` definition (`liquidsoap/radio.liq:149-154`)
with a dispatcher that picks one of several pre-built transition
functions. For Phase 1, pick at random; for Phase 2, read from
`b.metadata["transition"]` and fall through to random when absent.

Proposed styles (all sum to ~unity at midpoint — that invariant is
non-negotiable, see existing comment at radio.liq:117-129):

| Style          | Duration  | Shape                                                                 |
| -------------- | --------- | --------------------------------------------------------------------- |
| `fade`         | 8–10 s    | The current symmetric equal-amplitude fade. The floor.                |
| `long_blend`   | 12–16 s   | Same shape, longer buffer. For chill→chill, low-energy continuity.    |
| `quick_fade`   | 3–4 s     | Same shape, shorter buffer. For tight, talky, high-energy stretches.  |
| `echo_tail`    | 6 s       | Outgoing fades into an `echo(delay=0.25, feedback=0.4)`; incoming clean. |
| `filter_sweep` | 6 s       | Outgoing low-pass cutoff sweeps 20 kHz → 200 Hz over the fade.        |
| `hard_cut`     | 0 s       | `cross(duration=0)` for this transition. For "and now…" smash cuts.   |

`reverb_bloom` is a candidate sixth (lush hall on the outgoing tail);
parking it until we know whether the Phase 1 set covers enough range.

### IIR filter constraint

`filter_sweep` and `echo_tail` involve filters/effects on a
`request.queue`-backed source — the same pattern that triggered "Early
computation of source content-type" historically (see radio.liq:140-148
and the mic chain comment at radio.liq:264-266). Mitigations, in order
of preference:

1. **Apply the effect on the pre-cross `music_meta` handle** — same
   trick the on_metadata hook uses to dodge the post-cross
   double-fire. Run the effect on the full music bus and modulate its
   wet/dry from `dj_transition` via a getter-controlled ref, instead
   of instantiating fresh filters per transition.
2. **Use `chain` / pre-instantiated operators** with a ref-controlled
   gain rather than building the operator graph inside the transition
   callback.
3. If a style still trips the error in practice, drop it from the
   library and keep the working ones. The picker's enum is the source
   of truth, so removing a style is a one-line change.

This needs to be tried in the running broadcast container — predicting
which styles will compile is unreliable, the historical failure was
runtime, not parse-time.

### Picking randomly in Phase 1

Existing code in `radio.liq` already has `crossfade_duration` as a
ref, and the controller writes `liquidsoap_crossfade.txt` for the
default. Phase 1 keeps that as the floor: when no style is selected
(or the random roll lands on `fade`), behaviour is unchanged.

Random weighting: bias toward `fade` and `long_blend` (~60% combined)
so the station still feels like a station, with the more characterful
moves (`echo_tail`, `filter_sweep`, `hard_cut`) at ~10% each. Phase 2
lets the picker bias smarter.

## Phase 2 — let the picker choose

### Schema change

`controller/src/llm/dj.ts:392-395`, extend the picker's structured-output
schema:

```ts
schema: z.object({
  id: z.string().describe('the exact id of one candidate'),
  reason: z.string().describe('one short sentence on why this one'),
  transition: z.enum([
    'fade', 'long_blend', 'quick_fade',
    'echo_tail', 'filter_sweep', 'hard_cut',
  ]).default('fade').describe('how to mix from the outgoing track'),
  cross_seconds: z.number().min(0).max(16).default(8)
    .describe('cross buffer length in seconds; ignored for hard_cut'),
})
```

System prompt addition (kept short, the picker prompt is already
long): one paragraph describing when each style fits. Energy delta is
the load-bearing signal — `hard_cut` for big rises, `long_blend` for
flat low-energy continuity, `filter_sweep`/`echo_tail` for
characterful gear-changes.

### Plumbing

`controller/src/music/picker.ts:281-285`, return the transition along
with the song:

```ts
return {
  song: chosen,
  reason: pickRaw.reason || null,
  source: chosen._source,
  transition: pickRaw.transition,
  crossSeconds: pickRaw.cross_seconds,
};
```

`controller/src/broadcast/dj-agent.ts` — pass `transition` /
`crossSeconds` through into the queue item. `controller/src/broadcast/queue.ts`
(the queue's track-item shape) carries it onto the item.

`controller/src/music/subsonic.ts:263-273`, extend
`getAnnotatedUri(song, opts?)`:

```ts
export function getAnnotatedUri(song, opts: { transition?: string; crossSeconds?: number } = {}) {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
  ];
  if (song.year) fields.push(`year="${escAnnotate(song.year)}"`);
  if (song.genre) fields.push(`genre="${escAnnotate(song.genre)}"`);
  if (opts.transition) fields.push(`transition="${escAnnotate(opts.transition)}"`);
  if (opts.crossSeconds != null) fields.push(`liq_cross_duration="${opts.crossSeconds}"`);
  return `annotate:${fields.join(',')}:${getPlayableUri(song)}`;
}
```

`drainToLiquidsoap()` in `queue.ts:307` becomes:

```ts
const uri = subsonic.getAnnotatedUri(item.track, {
  transition: item.transition,
  crossSeconds: item.crossSeconds,
});
```

### Liquidsoap dispatcher

In `radio.liq`, `dj_transition(a, b)` reads `b.metadata["transition"]`
and dispatches. `liq_cross_duration` is honoured by `cross` natively —
no glue needed for the duration field; the per-track value overrides
the buffer width for that one transition.

Fallback chain: unknown / missing transition → `fade`. Whatever the
LLM emits, the station never breaks.

### Fallbacks and validation

- Pool picker's hard fallback path (`controller/src/music/picker.ts:262-267`,
  the `LLM failed outright` branch) returns no `transition`, which
  falls through to the random Phase 1 picker. Good — failure mode is
  "Phase 1 station", not "broken station".
- Zod default keeps old picker outputs valid even if a provider strips
  the field. No migration needed.
- Schema is small (one enum + one number), so the structured-output
  reliability risk is minimal; this is the same surface area as the
  request matcher's existing fields.

## What we're explicitly NOT doing

- **Real beatmatching.** Liquidsoap can theoretically time-stretch on
  BPM metadata, but every track would need pre-analysis (BPM +
  downbeat), the catalogue isn't mastered for it, and the failure
  modes are ugly. Not worth it for a one-listener-at-a-time station.
- **Loudness-aware fade scaling inside a fixed buffer.** Already tried,
  already in the git log (caused the audible "slap-back echo /
  doubling" — see radio.liq:117-129). Vary the *buffer length*
  (`cross_seconds`), never the fade duration inside a fixed buffer.
- **Adding a second LLM call.** The picker already has the full
  context. Doubling the LLM cost per transition for a stylistic
  choice would be wasteful — and worse, would split the decision
  across two prompts that don't share state.
- **RMS sidechain ducking.** Killed before (see f38a9af). The
  voice-ducking layer is untouched by this work — `smooth_add` stays
  exactly as it is. The transitions are about music-to-music handoff,
  not voice handoff.
- **New IPC files.** Everything rides the annotate URI we already
  write to `next.txt`. The `liquidsoap_crossfade.txt` global still
  exists as the floor / default; per-transition overrides come in via
  `liq_cross_duration` annotation, no new poller.

## Open questions

- **Which transition styles compile.** `filter_sweep` and `echo_tail`
  are the IIR-adjacent ones. Needs to be tried in a running
  `broadcast` container. Worst case: ship Phase 1 with only the
  amplitude-based styles (`fade`, `long_blend`, `quick_fade`,
  `hard_cut`) and add filter-based ones later if the constraint can
  be worked around.
- **Whether `hard_cut` is bearable at 0 s without beat alignment.**
  Probably yes for genre shifts and on `:00`/`:30` boundaries; maybe
  no inside a coherent mood block. The picker can learn to use it
  sparingly via prompt tuning; Phase 1 weights it low.
- **Per-style mic chain interaction.** Voice ducking (`smooth_add`)
  fires on the music bus regardless of which transition is running.
  If a DJ link starts mid-`filter_sweep`, the filter is on the music
  going into the duck, which should be fine — the duck is amplitude,
  not spectral. Verify in practice.

## Rollout

- **Phase 1 commit on the branch:** transition library + random
  picker in `radio.liq` only. Test by listening to the dev stack for
  an hour with a wide mood mix. Adjust style weights, drop any
  styles that don't compile or sound bad.
- **Phase 2 commit on the same branch:** schema + plumbing changes,
  picker prompt update. The dispatcher in `radio.liq` flips from
  "random" to "read metadata, fall back to random."
- **Open the PR after both phases land** so the change is reviewable
  as one DJ-transitions feature, not two half-features.

No DB migration, no settings.json change, no Liquidsoap restart
mechanism beyond the existing rebuild flow (`docker compose up -d
--build broadcast` for prod; dev hot-reloads the bind-mounted
`radio.liq` with `docker compose -f docker-compose.dev.yml restart
broadcast`).
