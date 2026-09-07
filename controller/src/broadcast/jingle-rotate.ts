// WHO draws the automatic jingle, and when (#1619).
//
// Liquidsoap used to decide on its own: `rotate(weights=[1, jingle_ratio()])`
// on the raw pre-cross music source, one stinger every N tracks, and the
// controller found out afterwards through `jingle-playing.json`. The collision
// guard built on that marker (#997, #1258, #1468) is a HOLD — spoken segments
// wait for the jingle's window to pass — which stops the station ident talking
// over the DJ but leaves the planner unable to plan around a jingle it never
// scheduled: a link written for the next boundary lands right behind a stinger,
// and a scheduled ident sits behind a jingle that took the same seam.
//
// So the count moves here. The controller already sees every track boundary
// (`now-playing.json` → `queue.onTrackStarted`), so it can count them itself
// and hand the jingle over through the existing single writer,
// `queue.playJingle()` → `jingle-now.txt`. The rotate then becomes a ROW in the
// talk table (`talk-scheduler.ts`), which is where every other claim on the
// listener's ear is arbitrated.
//
// I/O-free, and every decision function is pure: the settings object, a counter
// and a random source in, decisions out — the /debug reading of the handoff
// file is done by its caller and passed in. The one piece of module state is
// the owner-change subscriber list at the bottom, which exists for the same
// reason (and in the same shape as) time.ts's timezone listeners: it lets the
// queue learn about a switch without settings.ts importing the queue.
// Both the mixer handoff writer (`settings/liquidsoap.ts`) and
// the talk tick (`scheduler.talkTick`) resolve through the same functions, so
// "the mixer is rotating" and "the controller is rotating" can never disagree —
// they are two readings of one value.
//
// WHY THIS IS AN OPT-IN SETTING RATHER THAN THE ONLY MODE
// ------------------------------------------------------
// #1619 offered two upgrade shapes: opt in, or ship the controller rotate as
// the only mode with the mixer ratio pinned to 0 on the same release. The
// second is simpler to read but it cannot satisfy the rule it is written under
// — an upgraded station must not lose its jingles OR get them twice — because
// the controller and the broadcast image are separate containers that upgrade
// independently, and `liquidsoap_jingle_ratio.txt` is READ ONCE at mixer
// startup:
//
//   - Pinning the file to 0 for everyone means the mixer keeps rotating on the
//     operator's old ratio until its next start, which on a `up -d --build`
//     races the controller's own boot write. Every station that lost that race
//     would hear jingles MORE OFTEN THAN CONFIGURED, by default, on the
//     release, with both sides counting until the mixer next restarted.
//
//     "More often" rather than "twice": the magnitude is still unmeasured over
//     a long run. An on-air check of that state saw 2 jingles against 2
//     controller fires across three tracks — 1:1, not 2:1 — which radio.liq
//     explains, since its own rotate carries `not jingle_now_on_air()` and
//     `time() > voice_until()` and so stands down while a controller-handed
//     stinger feeds. Three tracks settles nothing, and nothing here depends on
//     the number: the objection to the only-mode shape is that its skew is
//     INVOLUNTARY and lands on an upgrade, not that it is exactly double.
//   - Pinning it in `radio.liq` instead (ignore the file, never build the
//     rotate) loses every jingle on a station whose CONTROLLER is still the old
//     image — the other skew direction, and the one the root CLAUDE.md's
//     "degrading must be silent" rule is written about.
//
// Opt-in has neither moment. Absent the key nothing is written differently and
// nothing new fires, which is the station's own rule (absent or malformed
// settings coerce to the pre-existing behaviour, so an upgrade is byte-
// identical). It also leaves `radio.liq` completely untouched: a new controller
// switches an OLD mixer's rotate off through the ratio file #997 already
// honours, and an old controller drives a NEW broadcast image exactly as today.
//
// The one cost is the read-once lifecycle itself: a station that flips the
// toggle and does not restart the mixer has both rotates running until it does.
// That is the existing contract for this exact file — the jingle-ratio control
// already carries "restart required" and "Save · needs restart" — and it is
// paid on an operator action rather than involuntarily on an upgrade, which is
// the whole difference between the two shapes.

import type { JingleRotateOwner } from '../schemas/settings.js';

export type { JingleRotateOwner };

// Who owns the rotate, from a settings object. Anything that is not the
// explicit opt-in reads as the mixer, so an absent key, a hand-edited typo and
// a settings.json from a older release all keep the pre-existing station.
export function jingleRotateOwner(
  s: { jingleRotate?: unknown } | null | undefined,
): JingleRotateOwner {
  return s?.jingleRotate === 'controller' ? 'controller' : 'mixer';
}

// The exact BYTES of `liquidsoap_jingle_ratio.txt`. 0 while the controller owns
// the rotate — already #997's documented "jingles off" value, which is why no
// radio.liq change is needed — and otherwise the operator's ratio rendered the
// way this file has always rendered it. Note the ratio itself is NOT zeroed in
// settings.json: it stays the operator's "1 jingle every N tracks" figure,
// which is exactly what the controller's own counter reads.
//
// A string rather than a number on purpose. The mixer-owned branch has to be
// byte-identical to the `String(s.jingleRatio)` it replaces, including for a
// value load() would never produce — coercing a malformed ratio to a NUMBER
// here would write `0` and silence the jingles, where the unparseable string
// radio.liq has always been handed makes it keep its own default. One
// function, so the file and the /debug reading of it cannot drift.
export function mixerJingleRatioFile(
  s: { jingleRatio?: unknown; jingleRotate?: unknown } | null | undefined,
): string {
  return jingleRotateOwner(s) === 'controller' ? '0' : String(s?.jingleRatio);
}

// Whether the controller owes the station a jingle this minute.
//
// `ratio` 0 keeps its existing meaning — jingles OFF (#997) — on this path too,
// so switching the rotate off is one setting whichever side is counting. The
// comparison is `>=` rather than `===` because the counter can overshoot: a
// due rotate that yields the minute to the segment director, or one held by the
// quiet gap, keeps counting boundaries while it waits.
//
// It deliberately does NOT ask whether the library has anything to draw. That
// question costs a readdir+stat sweep and this runs inside a synchronous
// per-minute resolver — but more to the point, the answer would not change what
// happens: a rotate that comes due and cannot be drawn is SKIPPED and the next
// one is N tracks away, which is what radio.liq's own rotate did whenever its
// `source.available` gate was shut ("skipping a jingle is the cheaper miss").
// queue.playRotateJingle() owns that, by spending the offer either way.
export function rotateJingleDue(p: {
  owner: JingleRotateOwner;
  ratio: number;
  tracksSinceJingle: number;
}): boolean {
  if (p.owner !== 'controller') return false;
  if (!(p.ratio > 0)) return false;
  return p.tracksSinceJingle >= p.ratio;
}

// Which jingle to draw. Liquidsoap's own source was
// `playlist(mode="randomize")`, so random is the behaviour being reproduced —
// with the one refinement a playlist gets for free and a bare `Math.random()`
// does not: the same stinger never airs twice running while another exists.
// The last filename is the whole memory deliberately; a longer no-repeat window
// on a two-jingle library would leave nothing to draw.
export function pickRotateJingle(
  filenames: readonly string[],
  last: string | null,
  rand: () => number = Math.random,
): string | null {
  if (!filenames.length) return null;
  const pool = filenames.length > 1 ? filenames.filter(f => f !== last) : filenames;
  const from = pool.length ? pool : filenames;
  return from[Math.min(from.length - 1, Math.floor(rand() * from.length))] ?? null;
}

// Snapshot for the admin /debug surface, beside voice/clock/talkAir. `owner`
// answers "why is the mixer not rotating" and "why is the controller not"; the
// counter pair answers "is it about to".
//
// TWO ratio figures, not one, and the difference between them is the whole
// point. `mixerRatioIntended` is what settings SAY the handoff file should
// hold; `onDisk` is what `liquidsoap_jingle_ratio.txt` actually holds, read by
// the caller and passed in (this module stays I/O-free). Reporting only the
// first would be a diagnostic that computes its own answer: it agrees with
// settings by construction and can never disagree with the mixer, which is the
// one thing an operator asking "why am I hearing two stingers" needs to see.
//
// They can genuinely differ, because `ensureLiquidsoapSettingsFile()` only
// writes when a file is MISSING. Hand-edit `jingleRotate: 'controller'` into
// settings.json and restart the controller and nothing rewrites the file: the
// mixer boots on the operator's old ratio, both sides count, and the station
// hears double jingles indefinitely. `mixerRatioMatches: false` is that state,
// visible. Pass `onDisk: null` when the file could not be read at all — absent
// is not the same claim as disagreeing, and neither is an error.
//
// Still NOT visible here: a mixer that has not restarted since a correct write
// and is therefore running on the previous contents. Nothing distinguishes it
// from a restarted one, which is why the control says "needs restart".
export function jingleRotateStatus(
  s: { jingleRatio?: unknown; jingleRotate?: unknown } | null | undefined,
  tracksSinceJingle: number,
  mixerRatioOnDisk: string | null = null,
) {
  const owner = jingleRotateOwner(s);
  const ratio = Number(s?.jingleRatio) || 0;
  const intended = mixerJingleRatioFile(s);
  return {
    owner,
    ratio,
    mixerRatioIntended: intended,
    mixerRatioOnDisk,
    // null rather than false when the file is unreadable: "we could not check"
    // and "we checked and it disagrees" are different operator instructions.
    mixerRatioMatches: mixerRatioOnDisk === null ? null : mixerRatioOnDisk === intended,
    tracksSinceJingle: owner === 'controller' ? tracksSinceJingle : null,
  };
}

// ---------------------------------------------------------------------------
// OWNERSHIP CHANGES
//
// The counter is a count of track boundaries since the controller last drew,
// and it runs whether or not the controller owns the rotate — `onTrackStarted`
// has no business branching on a setting. So a station that has been up for
// hours on the default 'mixer' is holding a large count, and the moment an
// operator flips to 'controller' the row is due on the very next tick: a
// stinger fires immediately, on top of the mixer's own rotate, which has not
// restarted yet. Zeroing on the transition is what makes the switch start a
// clean N-track cycle instead.
//
// A SUBSCRIBER rather than a call in POST /settings, for exactly the reason
// time.ts's setStationTimezone gives: `update()` is not the only writer — a
// backup restore reaches it directly — so the rule belongs at the ONE place the
// owner actually changes rather than being remembered at each new writer. And
// it has to be a subscriber rather than a direct call INTO the queue, because
// settings.ts already imports this module while broadcast/queue.ts imports
// settings.ts; this module imports nothing, so subscribers registering
// themselves is what keeps that acyclic.
//
// Everything above this line stays pure; this is the module's only state.
type OwnerListener = (owner: JingleRotateOwner) => void;
const ownerListeners = new Set<OwnerListener>();
let currentOwner: JingleRotateOwner = 'mixer';  // the default, so a boot into 'mixer' fires nothing

export function onJingleRotateOwnerChange(fn: OwnerListener): void {
  ownerListeners.add(fn);
}

// Fires on a real change only. load() and every successful update() push the
// owner in whether or not it moved, and zeroing the counter on every unrelated
// settings save would quietly hold the rotate off on a chatty admin session.
export function setJingleRotateOwner(owner: JingleRotateOwner): void {
  if (owner === currentOwner) return;
  currentOwner = owner;
  for (const fn of ownerListeners) {
    // One bad subscriber must not leave the change half-applied for the others.
    try { fn(owner); } catch { /* subscriber's problem */ }
  }
}
