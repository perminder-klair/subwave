# Web motion pass — plan

Add `motion` (the package formerly known as framer-motion) plus
`@use-gesture/react` to the listener-facing web app, in service of
making the player *feel* like a broadcast — soft crossfades, drawers
that exit as gracefully as they enter, transitions that mirror what
the audio is actually doing underneath. Not a redesign: every
existing V3 keyframe in `web/app/globals.css` stays, motion only
supplements.

## TL;DR

Ten targeted enhancements across the player surfaces, plus
swipe-to-dismiss on the right-side drawer for mobile. Two new deps
(`motion`, `@use-gesture/react`). One global wrapper (`LazyMotion` +
`MotionConfig reducedMotion="user"`). No changes to the landing page,
the admin shell, or the audio/controller layer.

## Why these and not others

The V3 design language is restrained — newsprint typography, single
vermilion accent, deliberate CRT-feeling cursor blink. The wrong
motion treatment here is "make everything bouncy and Material." The
right treatment is to use motion where the *absence* of animation
currently creates a tiny break in the illusion — most obviously,
audio crossfades smoothly between tracks but the cover and title
swap instantly.

Each item below was picked because it fixes one of those breaks, or
adds a piece of polish whose absence is felt even if not noticed.
Surfaces deliberately left untouched are listed at the bottom.

## Library choices

- **`motion`** — primary. React 19-compatible, tree-shakeable. Use
  `LazyMotion` + `domAnimation` to keep the additional JS payload
  small (~12 kB gzip vs ~30 kB for the full bundle).
- **`@use-gesture/react`** — drives swipe-to-dismiss on the Sheet
  drawer. Tiny (~3 kB gzip), works with motion's `useMotionValue` so
  the drag follows the finger pixel-for-pixel instead of going
  through React state.

No Lottie (heavy, off-brand), no confetti (gimmicky for a radio
station), no react-spring (overlaps motion).

## Global wiring (one-time)

In `PlayerApp.tsx`, wrap the root return in:

```tsx
<LazyMotion features={domAnimation} strict>
  <MotionConfig reducedMotion="user" transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}>
    {/* existing player tree */}
  </MotionConfig>
</LazyMotion>
```

- `reducedMotion="user"` makes every motion component honor the OS
  preference without per-component code. Matches the
  `@media (prefers-reduced-motion: reduce)` block already in
  `globals.css` (line ~355).
- Default transition mirrors the existing
  `cubic-bezier(0.2, 0.7, 0.2, 1)` used in `v3-slide-in-right` and
  `v3-modal-pop`, so motion-driven transitions feel like the same
  family as the existing CSS keyframes.
- `strict` mode forbids the non-lazy `motion` import — guards against
  someone accidentally pulling in the full bundle later.

The landing page (`/landing`) and admin shell (`/admin/*`) do *not*
get wrapped — they have their own visual language and don't need
motion. Bundle stays out of those routes entirely.

## The ten enhancements

### 1. CenterStage track transition — the biggest win

**File:** `web/components/CenterStage.tsx`

Today, when `nowPlaying` changes, the cover image, title, and artist
swap instantly. Liquidsoap is doing a multi-second audio crossfade
under the hood; the visuals should match.

- Wrap the cover `<img>` in `<AnimatePresence mode="popLayout">`
  keyed on `coverSrc`. Incoming cover: `opacity 0 → 1`, `scale 1.02 → 1`,
  280 ms. Outgoing: `opacity 1 → 0`, 220 ms. They overlap, producing
  a soft cross-dissolve.
- Wrap title + artist + album line in a sibling `AnimatePresence
  mode="popLayout"` keyed on `nowPlaying?.title`. Incoming text rises
  4 px from below as it fades in (`y: 6 → 0`, `opacity 0 → 1`);
  outgoing slides 4 px up and out. Mirrors how DJ liners feel when
  the next track is being introduced.
- The "scanning the dial _" placeholder participates in the same
  AnimatePresence — when the first track arrives, it gracefully
  yields.

**Risk:** none. CenterStage is purely presentational.

### 2. Drawer exit animation

**File:** `web/components/ui/sheet.tsx`

The Sheet comment literally reads "No exit animation." Today, the
`v3-slide-in-right` keyframe plays on mount, but on close the
Radix Dialog content is unmounted instantly — the drawer pops out of
existence. This is the most consistently noticeable rough edge.

- Wrap the `<Dialog.Content>` (and `<Dialog.Overlay>`) in
  `<AnimatePresence>` driven by the `open` prop. Use Radix's
  `forceMount` pattern so motion controls the exit before Radix
  unmounts.
- Entrance keeps the existing `v3-slide-in-right` CSS keyframe to
  avoid double-animating. Exit is motion: `x: 0 → 100%`, `opacity 1 → 0`,
  200 ms. Overlay fades out in parallel.
- Add a custom variant for the contained (landing-embedded) drawer
  — when `container` is set, exit translates by the parent width
  fraction rather than 100% of viewport.

**Risk:** medium. Radix Dialog + AnimatePresence requires the
`forceMount` + manually-controlled state pattern; the failure mode is
the drawer not unmounting at all. Will test the open/close cycle
explicitly, including back-to-back open of different drawers (Sheet
swaps `children` while open — exit should *not* play on a child
change).

### 3. DotRail active indicator with `layoutId`

**File:** `web/components/DotRail.tsx`

Today, the ink-filled active tab background is rendered conditionally
per-item — clicking a different tab causes the ink block to vanish
from the old position and reappear in the new one, instantly.

- Render the active background as an absolutely-positioned
  `<motion.div layoutId="dot-rail-active">` inside the active tab.
- Motion will automatically morph the block between positions when
  the active prop changes — same trick used in macOS Dock magnification
  and modern tabbed UIs.
- Keep the text-color contrast swap (`text-bg` when active) as a
  plain class toggle — motion only owns the background block.

**Risk:** low. `layoutId` is the most mature motion API.

### 4. DJ thinking line — graceful re-type

**File:** `web/components/DjThinkingLine.tsx`

The typewriter is currently a 42 ms `setInterval` over the text
string. It works, but mid-type interruption (new turn arrives while
the old one is still typing) cuts hard. Motion lets us treat each
character as a child with a stagger, which gives free interrupt
handling and an opportunity for a tiny blur-in.

- Replace the `setInterval` typewriter with characters mapped to
  `<motion.span>` children, parent uses
  `transition={{ staggerChildren: 0.042 }}`.
- Each character animates `opacity 0 → 1`, `filter blur(2px) → blur(0)`,
  120 ms.
- Wrap the whole line in `<AnimatePresence mode="wait">` keyed on
  `turnId` so a new turn exit-animates the old text before the new
  one begins typing (instead of the current behavior, which resets
  state mid-frame).
- Keep the existing `v3-blink` cursor — it's intentional CRT vibe,
  motion would smooth it and ruin the character.

**Risk:** low. Visual change only.

### 5. Tune-In overlay — dismiss like a physical dial

**File:** `web/components/TuneInOverlay.tsx`

Currently a `v3-fade-in` on mount and a CSS pulse on the play disc.
Dismiss is instant.

- Wrap the overlay button in `motion.button` with an `exit` variant:
  the play disc scales to 1.6× while opacity goes to 0, the rest of
  the overlay washes out 80 ms later. Feels like the dial engaging.
- Triggered by lifting the conditional render up to the parent
  (PlayerApp) inside `<AnimatePresence>` so the unmount is
  exit-animated.
- Keep the existing `v3-tunein-pulse` ring — that's the on-mount
  attention-getter, motion handles the dismount.

**Risk:** low.

### 6. Listener count + queue length — odometer

**Files:** `web/components/TopBar.tsx`, `web/components/DotRail.tsx`

When `listeners.current` changes from 3 to 4, or the queue length
goes from 5 to 6, the digit currently jumps. Tiny but the station
feels more alive when numbers visibly tick.

- Wrap the listener-count digit in `<AnimatePresence mode="popLayout">`,
  key on the value itself. New digit slides in from above (`y: -8 → 0`,
  `opacity 0 → 1`), outgoing slides down and out.
- Same treatment on the timeline count in DotRail. Skip when the
  count is an icon ReactNode (the History/Mic fallbacks) — only
  numeric values get the odometer.

**Risk:** low.

### 7. Suggestion chips — stagger on drawer open

**File:** `web/components/drawers/RequestDrawer.tsx`

Today, the chip row appears all at once when the Request drawer
opens.

- Parent chip container becomes `<motion.div>` with `staggerChildren:
  0.04` and `delayChildren: 0.12` (so the chips arrive *after* the
  drawer's slide-in finishes).
- Each chip is `<motion.button>` with `initial={{ opacity: 0, y: 4 }}`,
  `animate={{ opacity: 1, y: 0 }}`.
- On chip tap: `whileTap={{ scale: 0.96 }}` for haptic feel before
  the textarea fills.

**Risk:** low.

### 8. Request → Success card morph

**File:** `web/components/drawers/RequestDrawer.tsx`

Today, when the request is accepted, the form is replaced by the
SuccessCard in a hard swap. The drawer body height jumps.

- Wrap the conditional (`result?.success ? <SuccessCard /> : <Form />`)
  in `<AnimatePresence mode="wait">`. Each subtree animates
  `opacity` and a small `y` translate on enter/exit (120 ms each).
- Wrap the outer container in `<motion.div layout>` so the height
  change is springed instead of snapped.
- The pending → resolved transition *inside* SuccessCard (templated
  ack morphs into the real track) gets the same treatment: the
  "finding your track…" line is a `motion.div` with `layout` so when
  it's replaced by the resolved track title, the height eases.

**Risk:** medium. `layout` animations can fight with `overflow:
hidden` on the drawer scroll container; will verify the scroll
behavior on a tall success card doesn't get clipped mid-animation.

### 9. Booth feed — new-turn entry

**File:** `web/components/drawers/BoothDrawer.tsx`

New session turns currently appear at the top with no animation.
With the 5 s feed poll, this means batches of turns can suddenly
pop in.

- The filtered list becomes a `<motion.div>` containing
  `motion.div` children, each keyed on `turnKey(turn, i)`, with
  `layout` so existing entries push down when new ones insert.
- New entries enter with `opacity 0 → 1` and `y: -8 → 0` (slide down
  from above, mimicking a teletype line feeding in).
- Filter switches are not animated — feels like an admin gesture,
  shouldn't have weight.

**Risk:** low. List-layout animations are well-trodden in motion.

### 10. Volume cells — spring on keyboard adjust

**File:** `web/components/TransportBar.tsx`

The 12 volume cells light up correctly today but with no transition,
which is correct when dragging the invisible slider (the cells need
to track the finger). But when the user uses Arrow Up / Arrow Down
shortcuts (defined in `PlayerApp.tsx`, ±5%), the newly-lit cell could
spring-pulse to make the keyboard action feel responsive.

- Each cell becomes `<motion.span>` with a `key` that includes its
  `lit` state, and a `whileInView`-style scale pulse triggered by a
  `pulseTrigger` prop that changes only on keyboard-driven volume
  changes.
- Distinguishing keyboard vs slider: the slider's `onValueChange`
  doesn't set the pulse trigger; the keyboard handler does.
- Pulse is short and small (110 ms, scale 1 → 1.18 → 1) — barely
  visible, but the page *feels* responsive when you tap Arrow Up.

**Risk:** low.

## Swipe-to-dismiss on the Sheet drawer

**File:** `web/components/ui/sheet.tsx`

Mobile-only enhancement. The right-side drawer should dismiss with a
rightward swipe, the same gesture pattern iOS/Android users expect
from a side sheet.

- Use `useDrag` from `@use-gesture/react` on the Dialog.Content,
  binding to `useMotionValue('x')`.
- Threshold: 80 px or 0.4 viewport-width-velocity → call
  `onOpenChange(false)`. Below threshold, spring back to 0.
- Lock the gesture to horizontal-only — vertical drag must still
  scroll the drawer body.
- Disabled on the contained (landing-embedded) drawer — that one
  lives inside a card and shouldn't move independently of the page.
- Disabled with `prefers-reduced-motion: reduce` — the spring-back
  involves visible motion the user has opted out of.

**Risk:** medium. Gesture handlers and scrollable content compete;
need to ensure the drag only activates when the initial touch is on
the drawer chrome (header, padding) or when the body is scrolled to
the top.

## Things deliberately left untouched

- **`web/components/Waveform.tsx`** — already paints at 60 fps via
  `requestAnimationFrame` directly to DOM. Motion would add overhead
  for zero visual gain.
- **`web/components/TransportBar.tsx` hairline progress bar** — driven
  by a CSS variable updated every poll. Already smooth.
- **`web/app/globals.css` keyframes** — `v3-blink`, `v3-tunein-pulse`,
  `v3-connecting-pulse`, `v3-fade-in`, `v3-slide-in-right`,
  `v3-modal-pop` all stay. Some are referenced by motion-wrapped
  components (Tune-In overlay's pulse ring; drawer's entrance
  keyframe). The aesthetic CRT cursor blink must stay as `steps(1)`
  — motion would tween it.
- **Landing page (`web/components/Landing.tsx` and `landing/`,
  `what/`)** — broadsheet article aesthetic, not the place for
  motion polish. No `LazyMotion` wrapper means zero bundle impact
  on `/landing`.
- **Admin shell (`web/components/admin/*`)** — operator surface,
  needs to be fast and dense, not animated.
- **Theme toggle / topbar wordmark** — reference frames, should
  stay still.

## Performance notes

- `LazyMotion` + `domAnimation` keeps the additional player-route JS
  to about 12 kB gzip. The full motion bundle (`domMax`) would be
  ~30 kB; we don't need its extras (drag-and-drop reordering,
  3D transforms).
- All transitions are GPU-friendly (`opacity`, `transform: translate
  / scale`). No animated `height`, `width`, `top`, `left`, or
  `box-shadow` except where `layout` is involved, and there only on
  small surfaces (success card body, booth list).
- `useStationFeed` polls every 5 s — none of these animations
  depend on poll cadence; they're driven by value changes, so a
  steady-state station shows no churn.

## Rollout

One PR, one branch (`claude/framer-motion-interactions-i7q2M`,
already checked out). Ordered commits so each one is independently
reviewable:

1. Deps + global wrapper (`LazyMotion` / `MotionConfig`).
2. CenterStage track transition.
3. Sheet drawer exit + swipe-to-dismiss together (they share the
   forceMount refactor).
4. DotRail layoutId.
5. DjThinkingLine motion typewriter.
6. TuneInOverlay exit.
7. Listener / queue odometer.
8. RequestDrawer chips + form↔success morph.
9. BoothDrawer list layout.
10. Volume keyboard pulse.

Each commit message names the V3 keyframe it interacts with (if any),
so future archaeology on the animation system is easy.

## Open questions

- Should the DotRail `layoutId` background animate the *first* mount
  (i.e. when there's no previous active tab to morph from), or just
  subsequent switches? Default behavior is the former, which may look
  busy on initial paint — will set `initial={false}` on the
  AnimatePresence parent if it does.
- For the contained-player on `/landing`: the drawer is scoped to a
  card, but the listener-count odometer and CenterStage transition
  still run inside the embedded mount. Should the embedded variant
  opt out of motion entirely to keep the landing page lightweight?
  Leaning toward no — the embed should look like the real player —
  but worth confirming.
