# Track-change transitions for the five CSS-only skins

**Date:** 2026-07-24
**Status:** Design — awaiting review
**Scope:** `web/components/skins/{spool,drift,subamp,tty,platter}`

## Problem

Five of six player skins have no transition on the single most important event
in a radio player: the song changing. Cover art, title, artist and metadata all
swap instantly, mid-frame.

`classic` is the exception — it crossfades the cover and enters/exits the title
block through `AnimatePresence` (`classic/CenterStage.tsx:229`, `:291`). The
other five render the same facts with a hard cut.

This is not a missing dependency. `motion` v12.40.0 is already installed and
mounted app-wide (`app/layout.tsx:237` → `components/MotionProvider.tsx`). The
gap is that only `classic` ever used it.

| Skin | Uses motion | Track-change transition today |
|---|---|---|
| `classic` | 7 files | cover crossfade + title enter/exit |
| `spool` | — | none |
| `drift` | — | room color only (20s `--sw-drift-c`); type and cover cut |
| `subamp` | — | none (marquee re-keys, restarting its CSS scroll) |
| `tty` | — | none |
| `platter` | — | none |

## Non-goals

**Ambient loops stay CSS.** `platter-spin`, `drift-a/b/c`, `spool-vu`,
`spool-sheen`, `subamp-marquee`, `tty-blink` are infinite loops. They are
cheaper as composited CSS keyframes, and — load-bearing — `html.lite`'s global
kill (`globals.css:938`) already stops them for free. Porting them to motion
would break lite mode and cost performance. Do not.

**`classic` is untouched.** It already has this.

**No new skins, no layout changes.** Only the transition between one track's
facts and the next's.

## Constraints discovered in the code

These are facts about this codebase, not preferences. All five implementations
must satisfy them.

### 1. `LazyMotion` runs in `strict` mode

`MotionProvider.tsx:22` mounts `<LazyMotion features={domAnimation} strict>`.
`strict` throws at runtime on `<motion.div>` — use `<m.div>`. This keeps the
bundle at ~12 kB gzip instead of ~30 kB. ESLint will not catch a violation;
only a runtime render will.

### 2. Reduced motion is already handled — except for one case

`MotionProvider.tsx:24` sets `reducedMotion="user"`. Motion then drops
transform and layout animations globally and keeps opacity. No per-skin code is
needed for the slide/scale/lift variants.

**The exception is `subamp`.** Its idiom is an LCD flicker, which is *pure
opacity* — precisely what `reducedMotion="user"` preserves. A listener who asked
for reduced motion would still get a strobe. `subamp` must call
`useReducedMotion()` explicitly and fall back to a hard cut.

### 3. Lite mode is NOT free — this is the trap

`globals.css:938` is:

```css
html.lite *, html.lite *::before, html.lite *::after {
    backdrop-filter: none !important;
    animation: none !important;
}
```

That kills **CSS** animations. Motion's animations are JS-driven and pass
straight through it. Adding motion to a skin without a gate silently breaks lite
mode for that skin.

Every implementation must read `useLiteMode()` (`hooks/useLiteMode.ts`) and cut
instantly when `lite` is true.

The precedent and its reasoning are already written into
`drift/Drift.module.css:21-25`, which disables the 20s wash transition under
lite for exactly this reason.

**A zero-duration transition is NOT a cut.** This was found during
implementation, and it is the subtle half of the constraint. Given

```js
{ initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0 } }
```

motion still paints `initial` for one frame before the zero-duration animation
commits — so lite mode flashes the *hidden* state on every track change, which
is worse than the animation it was trying to suppress. The same applies on the
way out: an `exit: { opacity: 0 }` fades the outgoing node, however briefly.

The lite form of each variant must therefore be:

```js
{ initial: false, animate: { /* resting state */ }, exit: {}, transition: { duration: 0 } }
```

`initial: false` mounts straight at rest; `exit: {}` gives AnimatePresence
nothing to animate. For `tty`, whose `initial` is a full-width clip, the lite
path skips the motion element entirely and renders a plain `<span>`.

### 4. Key on a stable track identity, not on rendered text

`/state` polls every 5s. Keying an `AnimatePresence` child on a string that can
transiently go null or hydrate late (album, year, cover URL) re-fires the
transition on a poll, flashing the title.

`classic/CenterStage.tsx:118` already solves this:

```js
const titleKey = offline ? 'offline' : has ? `t:${nowPlaying?.title}` : 'placeholder';
```

Offline and placeholder collapse to constant keys, so only a genuine track
change moves the key. Each skin derives its own equivalent, preferring
`subsonic_id` with a title fallback.

### 5. `initial={false}` on every `AnimatePresence`

Otherwise the transition plays on first paint and on every tune-in, which reads
as jank rather than intent. `classic` does this at `:229` and `:291`.

## Approach

**Bespoke per skin** — chosen deliberately over a shared `<TrackSwap>`
primitive. Each of the five skins hand-rolls its own `AnimatePresence` with its
own variants, because each skin's idiom calls for a genuinely different move and
a shared abstraction would either flatten them or grow a config surface wider
than the five implementations it replaces.

The accepted cost: constraints 1–5 above are implemented five times, and are
five chances to forget one. Mitigated by the test plan below, which checks each
one per skin rather than trusting the implementation.

**One shared carve-out:** a `useSkinMotion()` hook in `sharedHooks.ts` returning
a single boolean — "may I animate right now?" — folding the lite read. This is
not an abstraction over animation character; it is one policy fact that is
identical in all five skins and is the one constraint whose failure is silent.
Every animation stays fully hand-rolled in its own skin.

```ts
/** Whether a skin may run a JS-driven transition right now. Lite mode's
 *  global CSS kill (globals.css) does not reach motion, so each skin gates
 *  on this; reduced motion is handled globally by MotionConfig. */
export function useSkinMotion(): boolean {
  const { lite } = useLiteMode();
  return !lite;
}
```

## Per-skin design

Each skin's move follows from what the skin *is*. Durations are chosen so the
transition completes well inside the shortest realistic gap between tracks.

### `spool` — tape deck

**Idiom:** a cassette's printed index label. Tape moves; it does not dissolve.

**Move:** the title/artist block slides up and out as the incoming block slides
up in — an index card being pulled through. `y: 8 → 0`, exit `y: -8`, with
opacity. 240 ms, `mode="popLayout"`.

**Sites:** the cassette hero label (`SpoolSkin.tsx:395`) and the mobile
now-playing line (`:553`). Both render the same `title`; both animate.

**Untouched:** the reels already re-derive from `--reel-l` / `--reel-r`
(`:126-131`) and reset on their own.

### `drift` — ambient cover-wash poster

**Idiom:** already established in its own CSS — "the type waits; the color
arrives first" (`Drift.module.css:1-4`). The room crossfades over 20 s.

**Move:** slow dissolve, no movement at all. Pure opacity.

- Title (`DriftSkin.tsx:221`) and meta line (`:226`): `mode="wait"`, 900 ms
  each way. `wait` leaves a beat of emptiness between tracks, which suits the
  skin — nothing else on screen is in a hurry.
- Cover (`:209`): `mode="popLayout"`, 1200 ms, so the two covers stack and read
  as a true dissolve.

This is the one skin where slow is correct. Do not speed it up to match the
others.

### `subamp` — 1998 modular player

**Idiom:** a segment LCD re-latching. A 1998 player does not crossfade; the
readout blinks and the new value is there.

**Move:** opacity keyframe array `[1, 0.25, 1, 0.4, 1]` over 180 ms — a hard
two-blink latch, no transform. Cover (`SubampSkin.tsx:170`) gets a single 90 ms
flash, not a crossfade; the bitmap swaps.

**Sites:** the big readout title (`:335`) and the cover (`:170`).

**Reduced motion:** per constraint 2, gate on `useReducedMotion()` and cut with
no flicker. This is the only skin that needs the explicit check.

**Untouched:** the marquee already re-keys on `marqueeText` (`:179`),
restarting its CSS scroll. That is correct existing behaviour.

### `tty` — terminal

**Idiom:** a terminal prints. It does not fade, ever.

**Move:** reprint. The incoming title reveals left-to-right via
`clipPath: inset(0 100% 0 0) → inset(0 0 0 0)` with `ease: steps(n)`, where
`n` is the character count — a real per-character reveal with no per-character
DOM. Step duration is `min(14, 450 / n)` ms, so short titles print at a steady
14 ms/char and anything past ~32 characters compresses to fit a 450 ms ceiling
rather than holding the pane for a second.

No exit animation — a terminal line does not fade out, it is overwritten. Use
`mode="wait"` with an instant exit.

**Sites:** the title (`TtySkin.tsx:150`) and the artist line (`:153`), the
artist printing after the title completes.

**Cover (`:190`): no animation.** It is labelled `cover.raw` — a raw bitmap
dump. It cuts.

**Precedent:** the existing `tty-bootline` keyframe (`Tty.module.css:13-20`)
plus its `html.lite` exception at `:33` establish both the print idiom and the
lite handling for content that only becomes visible through animation.

### `platter` — turntable

**Idiom:** a record change.

**Move:** the sleeve lifts and settles — `scale: 1.04 → 1`, `y: -6 → 0`, opacity
— over 320 ms on `cubic-bezier(0.22, 1, 0.36, 1)`. That curve is deliberately
the tonearm's existing easing (`Platter.module.css:70`), so the skin reads as
one mechanism rather than two.

The title block follows with `y: 10 → 0` + opacity, 280 ms, delayed ~60 ms —
"record down, then the label becomes legible."

**Sites:** the sleeve (`PlatterSkin.tsx:320`) and the now-spinning title block
(`:329-339`).

**Untouched:** the tonearm already tracks `--pf` with its own 1.1 s transition
and parks on tune-out (`Platter.module.css:64-73`). It needs nothing.

## Testing

No test runner exists in this repo; `npm run lint` (`eslint . && tsc --noEmit`)
is the merge gate.

**What was actually run.** Two throwaway Playwright harnesses drove a mocked
controller (route-intercepted `/now-playing`, `/state`, `/session`, `/like`,
`/cover/*`), flipped the track, and sampled the DOM every ~40ms for motion's
fingerprint — an *inline* `opacity` / `transform` / `clip-path`, which CSS
keyframe elements never carry, so the ambient loops don't pollute the signal.
Asserted per skin: caught mid-flight at least once normally, and never
mid-flight under `?lite=1`. Plus a reduced-motion pass asserting both
directions — `subamp` suppressed, `drift` still dissolving — so the subamp gate
can't be "proved" by a check that would pass with the gate missing.

All ten lite/normal checks and all three reduced-motion checks pass, stable
across repeat runs. Two harness bugs were themselves caught and fixed first
(the lite key is `subwave-lite` = `'1'`/`'0'`, and sampling a *child* of the
animated node misses opacity entirely), which is worth remembering if these are
ever rebuilt.

The checklist below remains the manual safety net for the bespoke duplication.

**Per skin, all five:**

1. **Lite gate** — enable lite mode, force a track change, confirm an instant
   cut. This is the constraint most likely to be missed and it fails silently.
2. **Reduced motion** — set `prefers-reduced-motion: reduce`; confirm no
   transform-based movement. For `subamp` specifically, confirm no flicker.
3. **First paint** — load the skin cold and tune in; confirm no transition
   fires on mount.
4. **Poll stability** — sit on one track through several 5 s `/state` polls;
   confirm the title never re-animates.
5. **Offline** — confirm the offline and scanning placeholders do not animate
   on reconnect.
6. **`<m.*>` not `<motion.*>`** — a rendered track change is the only check;
   `strict` throws at runtime, and lint will not catch it.

**Cross-cutting:** `npm run lint` in `web/`. Watch for the two known traps —
inline `style` attributes are ESLint-forbidden (use the existing
`useDynamicStyle` pattern), and motion's `initial`/`animate` props are fine (
`classic` already passes lint using them).

## Risks

- **Five copies of the lite gate.** Accepted with the bespoke approach.
  `useSkinMotion()` reduces it to one import and one boolean per skin, and test
  step 1 checks it per skin.
- **`subamp`'s flicker and photosensitivity.** Mitigated by the explicit
  `useReducedMotion()` fallback. If in doubt, soften the keyframe array rather
  than removing the idiom.
- **`tty`'s stepped reveal on very long titles.** Mitigated by the 450 ms total
  cap.
- **Contract version.** `SKIN_API_VERSION` (`types.ts:35`) does **not** need a
  bump: no `SkinProps` or core-context shape changes. Adding `useSkinMotion()`
  to `sharedHooks.ts` is additive.
