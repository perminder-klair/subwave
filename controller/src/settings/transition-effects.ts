// Which DJ transition effects an operator has left switched on (#1565).
//
// The station-wide "may this gesture air at all" decision, kept apart from the
// two questions that already have homes: `effectsActive()` (persona.ts) answers
// "is this persona a DJ at all" — one switch for the whole kit — and
// `music/mix.ts` `effectAllowedFor` answers "does THIS pair earn this gesture"
// from analysis alone. Neither can express "this station cannot afford the
// dissolve", which is the gap #1565 was raised about: the only lever narrower
// than the kit was turning `djMode` off, and that takes sweep, chop, washout
// and loop with it.
//
// Its own module rather than a check at each call site, because the answer is
// reached independently from three places — the pool picker's prompt and enum
// (llm/), the agent's flag assignment and the drain-time enforcement pass
// (broadcast/) — and adding a second copy of this rule is the bug. It sits
// under settings/ rather than broadcast/ for a structural reason: `llm/` must
// not import from `broadcast/`, and the picker prompt is one of the three.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { TRANSITION_EFFECTS, type TransitionEffect } from './vocab.js';
import { get } from './store.js';

/**
 * Is `kind` switched on for this station?
 *
 * Absent or malformed settings read as ENABLED, which is what makes an upgrade
 * byte-identical: a station that has never seen this block behaves exactly as
 * it did before the block existed. Only an explicit `false` turns an effect
 * off — the same posture as every other switch here, and the reason a
 * half-written `settings.json` cannot silently mute the kit.
 *
 * Deliberately NOT gated on `effectsActive()`. The two answers compose at the
 * call sites (a non-DJ persona has no effects regardless), and folding the
 * persona check in here would make an operator's per-effect choice read as
 * having been reset every time a non-DJ persona took the mic.
 */
export function effectEnabled(kind: TransitionEffect, s: unknown = get()): boolean {
  const block = (s as { transitions?: { effects?: Record<string, unknown> } } | null | undefined)
    ?.transitions?.effects;
  return block?.[kind] !== false;
}

/** The subset of the kit that is switched on, in `TRANSITION_EFFECTS` order. */
export function enabledEffects(s: unknown = get()): TransitionEffect[] {
  return TRANSITION_EFFECTS.filter(k => effectEnabled(k, s));
}
