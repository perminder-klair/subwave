// When the music router is down, play the station's Navidrome directly (#692).
//
// The router is the default path, so a router outage — a crashed container, a
// third-party plugin that wedged it — would otherwise silence a station that a
// direct Navidrome connection would have kept playing. When the selection is
// the station's Navidrome alone with raw ids (the default), the direct
// connection publishes exactly the same track ids, so falling over and back is
// invisible downstream: likes, moods, the queue and stems all still match.
// Any other selection has nothing equivalent to fall back to and is left alone.
//
// The decision is pure (nextFailoverStep); the runner probes and applies it,
// in the main controller process. A maintenance run (the tagger's walk,
// analysis) takes the same decision once, at its start
// (setup/config.ts loadMaintenanceConnection). Both directions wait for two checks in
// a row: a router still starting at boot must not trip a switch, and a
// flapping one must not rebuild auto.m3u on every tick.

import { config } from '../config.js';
import { currentSelection, readRouterAuth, routerConnection, routerServing } from '../setup/music-source.js';
import { storedNavidrome } from '../setup/config.js';
import { isStationNavidromeOnly, type MusicSelection } from '../schemas/music-source.js';
import { clearServerCaches, pingWith } from './subsonic.js';
import { clearPoolCache } from './picker.js';
import { clearNavidromeCache } from '../doctor.js';
import { queue } from '../broadcast/queue.js';
import { refreshAutoPlaylist } from '../broadcast/scheduler.js';

const TICK_MS = 10_000;
/** Consecutive checks before a switch, in either direction. */
export const FAILOVER_STREAK = 2;

export type FailoverStep = 'activate' | 'restore' | 'hold';

export interface FailoverInputs {
  /** The selection is one the direct connection can stand in for. */
  eligible: boolean;
  active: boolean;
  /** Consecutive router checks that failed / passed, including this one. */
  downStreak: number;
  upStreak: number;
  /** Whether the direct Navidrome answers; only asked when it would decide. */
  directOk: boolean;
}

export function failoverEligible(sel: MusicSelection): boolean {
  return isStationNavidromeOnly(sel);
}

export function nextFailoverStep(i: FailoverInputs): FailoverStep {
  // The operator changed the selection while failed over: its own connection applies.
  if (i.active && !i.eligible) return 'restore';
  if (i.active) return i.upStreak >= FAILOVER_STREAK ? 'restore' : 'hold';
  return i.eligible && i.downStreak >= FAILOVER_STREAK && i.directOk ? 'activate' : 'hold';
}

export interface FailoverState {
  active: boolean;
  since: string | null;
  reason: string | null;
}

let state: FailoverState = { active: false, since: null, reason: null };
let downStreak = 0;
let upStreak = 0;

export function failoverState(): FailoverState & { eligible: boolean } {
  return { ...state, eligible: failoverEligible(currentSelection()) };
}

/** A save just applied its own connection; whatever the monitor had decided no longer stands. */
export function resetFailover(): void {
  state = { active: false, since: null, reason: null };
  downStreak = 0;
  upStreak = 0;
}

/** The router can serve (shared with maintenance runs, setup/config.ts loadMaintenanceConnection). */
export const probeRouter = routerServing;

async function probeDirect(): Promise<boolean> {
  const nav = await storedNavidrome();
  if (!nav.url || !nav.user || !nav.password) return false;
  return (await pingWith({ url: nav.url, user: nav.user, pass: nav.password, client: 'sub-wave-failover' })).ok;
}

// Everything that described the previous connection: cached server facts, the
// pick pool, and auto.m3u, whose URLs point at the connection being left.
function connectionChanged(): void {
  clearServerCaches();
  clearNavidromeCache();
  clearPoolCache();
  refreshAutoPlaylist().catch((err) => queue.log('error', `Failover playlist refresh failed: ${err.message}`));
}

export interface FailoverDeps {
  probeRouter: typeof probeRouter;
  probeDirect: () => Promise<boolean>;
  afterSwitch: () => void;
}

const DEFAULT_DEPS: FailoverDeps = { probeRouter, probeDirect, afterSwitch: connectionChanged };

/** One check. Exported for tests; the monitor calls it every TICK_MS. */
export async function failoverTick(deps: FailoverDeps = DEFAULT_DEPS): Promise<FailoverStep> {
  const sel = currentSelection();
  const eligible = failoverEligible(sel);
  if (!eligible && !state.active) {
    downStreak = 0;
    upStreak = 0;
    return 'hold';
  }
  const router = await deps.probeRouter();
  downStreak = router.ok ? 0 : downStreak + 1;
  upStreak = router.ok ? upStreak + 1 : 0;
  const wouldActivate = eligible && !state.active && downStreak >= FAILOVER_STREAK;
  const directOk = wouldActivate ? await deps.probeDirect() : false;
  const step = nextFailoverStep({ eligible, active: state.active, downStreak, upStreak, directOk });

  if (step === 'activate') {
    const nav = await storedNavidrome();
    Object.assign(config.navidrome, { url: nav.url, user: nav.user, password: nav.password });
    state = { active: true, since: new Date().toISOString(), reason: router.reason ?? 'unreachable' };
    queue.log('error', `Music router unreachable (${state.reason}) — playing Navidrome directly until it answers`);
    deps.afterSwitch();
  } else if (step === 'restore') {
    Object.assign(config.navidrome, sel.mode === 'router' ? routerConnection(readRouterAuth()) : await storedNavidrome());
    queue.log('scheduler', eligible ? 'Music router is back — Navidrome plays through it again' : 'Failover ended — the saved music source applies');
    resetFailover();
    deps.afterSwitch();
  }
  return step;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Main controller process only. */
export function startFailoverMonitor(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    failoverTick()
      .catch((err: unknown) => console.warn(`[failover] check failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref();
}
