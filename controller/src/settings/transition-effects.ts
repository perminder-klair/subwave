// Which DJ transition effects the station has switched on (#1565), the one
// place that rule lives — three independent callers (picker prompt in llm/, the
// agent's flag assignment and the drain-time enforcement in broadcast/) ask it.
// Lives under settings/ because `llm/` may not import `broadcast/`.

import { TRANSITION_EFFECTS, type TransitionEffect } from './vocab.js';
import { get } from './store.js';

/**
 * Absent or malformed settings read as ENABLED; only an explicit `false` turns
 * an effect off, so an upgrade is byte-identical. Deliberately NOT gated on
 * `effectsActive()` — the two compose at the call sites.
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
