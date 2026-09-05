// Talk PLACEMENT policy — whether a scheduled spoken segment ducks the song
// that is playing, or waits for the next track boundary (#1485 FR 5b).
//
// The station ident has always waited: `air: 'next-track'` in the talk-slot
// table, because an ident has no real-time constraint and at a transition the
// same words land like real radio instead of arriving over a vocal. The
// operator ask was to extend that to EVERY scheduled segment —
// `djTalkOnlyBetweenTracks`, off by default so an upgrade is byte-identical.
//
// Two halves live here, and they are deliberately different shapes:
//
//   - talkOnlyBetweenTracks() is the SWITCH. The talk tick reads it once per
//     minute and hands it to the pure planner, which resolves every row's `air`
//     to 'next-track' while it is on — including the fill row. Resolution lives
//     in the planner, beside the table it is resolving, because `TalkPlan.air`
//     is what the dispatcher acts on and a second resolver anywhere else would
//     be the duplicate-policy bug. This module owns the READ.
//   - withTalkAir()/currentTalkAir() is a SCOPE, not a parameter. Every runner
//     the tick dispatches to eventually reaches queue.announce() or
//     queue.announceExchange(), but the paths are long and forked: the segment
//     director alone speaks from four sites inside skills/_agent.ts, and
//     programme beats speak from two more in programme.ts. Threading a flag
//     through all of them would make the constraint a property of eight call
//     sites that a ninth could silently miss — the class of bug the policy
//     modules named in CLAUDE.md exist to prevent. A scope makes it a property
//     of the DISPATCH instead: anything spoken inside a scheduled talk fire
//     defers, including a skill written after this shipped.
//
// The scope is also what keeps MANUAL triggers exempt without a second rule.
// `/dj/segment`, `/dj/skill` and the programme runners call the same gate-free
// runners the tick does, but they call them from outside any scope — so
// currentTalkAir() reads 'immediate' and an operator press fires now, exactly
// as it already does for the voice switch, the clock switch and the frequency
// ladder.

import { AsyncLocalStorage } from 'node:async_hooks';
import * as settings from '../settings.js';
// Type only — the vocabulary belongs to the slot table, and importing it as a
// type keeps the pure planner free of any dependency on this module.
import type { TalkAir } from './talk-scheduler.js';

const als = new AsyncLocalStorage<TalkAir>();

// The switch itself. Absent/non-boolean coerces false in settings.load(), so a
// settings.json predating the key keeps the pre-existing placement.
export function talkOnlyBetweenTracks(): boolean {
  return settings.get()?.djTalkOnlyBetweenTracks === true;
}

// Run a scheduled talk fire with its resolved air mode in scope. Always enters
// a scope, including for 'immediate': a bare call would inherit an enclosing
// scope, and "immediate" has to mean immediate wherever it is asked from.
export function withTalkAir<T>(air: TalkAir, fn: () => Promise<T>): Promise<T> {
  return als.run(air, fn);
}

// How speech started here should reach air. 'immediate' outside any scope,
// which is every manual trigger, every track-tied link and every request intro
// — none of which this switch touches.
export function currentTalkAir(): TalkAir {
  return als.getStore() ?? 'immediate';
}

// Snapshot for the admin /debug surface, alongside clockStatus()/voiceStatus().
export function talkAirStatus() {
  return { onlyBetweenTracks: talkOnlyBetweenTracks() };
}
