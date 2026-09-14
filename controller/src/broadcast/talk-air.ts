// Talk PLACEMENT policy: whether a scheduled spoken segment ducks the song or
// waits for the next track boundary (#1485). `djTalkOnlyBetweenTracks` is the
// switch, read once per minute by the talk tick and resolved into TalkPlan.air
// by the pure planner. withTalkAir() is a SCOPE rather than a threaded flag, so
// anything spoken inside a scheduled fire defers, and manual triggers — which
// call the same runners from outside any scope — stay 'immediate'.

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
