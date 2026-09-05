// Banter scheduling policy — WHEN a guest-show exchange may air (#1419).
//
// Banter is the only spoken segment gated on a minimum QUIET GAP: it is the
// longest break we air, so it must not pile onto a talk break the listener
// just heard. That rule is right. What was wrong is that the gap was only ever
// evaluated at two instants an hour (a `20,50 * * * *` cron), and the things
// that set the gap don't land on the clock:
//
//   - a station ident is scheduled at :15/:45 but boundary-DEFERRED
//     (announceAtNextTrack), so it airs at the next track transition — :19:35
//     for a :15 ident is ordinary, not an edge case;
//   - the segment director ticks every 5 minutes, including :15 and :20, and
//     its own floor is ZERO on an aggressive station (skills/_agent.ts).
//
// Either one lands inside the 5-minute shadow of the fixed tick, the tick
// stands down, and the next chance is 30 minutes away — on `moderate`, which
// only has the :20 slot, the whole hour is gone. Observed as hours of eligible
// guest shows producing no banter at all.
//
// The fix is a WINDOW rather than an instant: the slot still opens at :20/:50,
// but the tick runs every minute for ten minutes and fires the first minute the
// gap is genuinely clear — so a :19:35 ident postpones the exchange to :24:35
// instead of cancelling it. One fire per slot, so a window can't turn into a
// stream of exchanges. The gap itself is untouched: classifying idents as "not
// real talk" would let banter stack right behind one, which is the thing the
// gap exists to prevent.
//
// This file is the NUMBERS and their reasoning. The window/gap/logging state
// machine they feed was generalised to every talk kind in talk-scheduler.ts
// (#1500) — banter is simply the row that already had all three fields, so the
// mechanism moved out and the policy stayed. The FREQUENCY ladder is
// deliberately in neither: it stays in dj-gate.ts with the other rungs, and
// asks this module only which slot a minute belongs to.

// Minute each banter window OPENS. Chosen because no other wall-clock talker
// owns them — the ident cron is :15/:30/:45 and the hourly check is :00 (issue
// #310) — so an exchange can't be SCHEDULED against another segment. What it
// can still collide with is a segment that AIRED off-clock, which is what the
// window below absorbs.
export const BANTER_SLOTS = [20, 50] as const;

// How long a slot stays open for. Twice the quiet gap: a talk break that landed
// anywhere inside the 5 minutes before the slot opened clears by the halfway
// point, leaving room for the exchange to render (several TTS calls) and still
// finish well clear of the next ident slot at :30/:00.
export const BANTER_WINDOW_MINUTES = 10;

// Minimum quiet gap before an exchange — every STANDALONE talk break counts
// (idents, hourly, handoff, banter and the segment director's spots), which is
// what queue.getLastTalkBreakAt() reports. Track-tied links are excluded there,
// or a chatty DJ-mode station would never banter.
export const BANTER_MIN_GAP_MS = 5 * 60_000;

// The window arithmetic these three numbers imply is NOT here: it is the talk
// slot table's, applied identically to every row (talk-scheduler.ts's
// `openMinuteFor`), and dj-gate's banter rung asks the table the same question
// the ident rung does. A second copy keyed to banter alone is exactly the drift
// this file's own history warns about.
