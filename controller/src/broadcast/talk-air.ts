// Resolve scheduled talk placement into TalkPlan.air. The withTalkAir scope defers scheduled
// speech; manual callers outside it remain immediate. #1485.

import { AsyncLocalStorage } from 'node:async_hooks';
import * as settings from '../settings.js';
import type { TalkAir } from './talk-scheduler.js';

const als = new AsyncLocalStorage<TalkAir>();

// Absent/non-boolean coerces false in settings.load(), so an older settings.json
// keeps the pre-existing placement.
export function talkOnlyBetweenTracks(): boolean {
  return settings.get()?.djTalkOnlyBetweenTracks === true;
}

// Always enters a scope, including for 'immediate': otherwise an enclosing scope
// would be inherited.
export function withTalkAir<T>(air: TalkAir, fn: () => Promise<T>): Promise<T> {
  return als.run(air, fn);
}

// 'immediate' outside any scope: manual triggers, track-tied links, request intros.
export function currentTalkAir(): TalkAir {
  return als.getStore() ?? 'immediate';
}

// Manual calls and scheduled rows can both resolve to `immediate`; presence of
// the scope is the discriminator policy gates use when manual actions must stay
// exempt.
export function inTalkAirScope(): boolean {
  return als.getStore() !== undefined;
}

export function suppressScheduledSpeechDuringHandoff(
  kind: string,
  handoffInProgress: boolean,
): boolean {
  return handoffInProgress && kind !== 'handoff' && inTalkAirScope();
}

// Snapshot for the admin /debug surface.
export function talkAirStatus() {
  return { onlyBetweenTracks: talkOnlyBetweenTracks() };
}
