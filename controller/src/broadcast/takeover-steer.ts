// A steer and a takeover do not run together. Starting a steer ends a takeover
// (routes/steer.ts); this is the other direction, in one place for every route
// that saves a takeover: POST /schedule/override (routes/shows.ts) and the
// generic POST /settings (routes/settings/core.ts).
import * as settings from '../settings.js';
import { serialSteer } from '../music/steer.js';
import { queue } from './queue.js';

/**
 * `settings.update(patch)`, ending a running steer in the same write when the
 * patch puts a takeover in force, then taking back that steer's un-aired
 * opening tracks. In turn with Start, Clear and the janitor (`serialSteer`), so
 * it never acts on a steer another has just replaced. `endedSteer` says whether
 * one was ended.
 */
export function updateEndingSteer(patch: Record<string, unknown>) {
  return serialSteer(async () => {
    const steer = settings.activeSteer();
    const takeover = 'scheduleOverride' in patch
      && !!settings.getScheduleOverride(Date.now(), { ...settings.get(), ...patch });
    const endedSteer = !!steer && takeover;
    const result = await settings.update(endedSteer ? { ...patch, steer: null } : patch);
    if (endedSteer) {
      queue.log('scheduler', '[steer] cleared — takeover started');
      // The takeover and the cleared steer are saved: taking back a track the
      // mixer already holds is best-effort, never a reason to fail the save.
      await queue.removeSteerQueued(String(steer.startedAt))
        .catch(err => queue.log('error', `[steer] its opening tracks could not all be taken back: ${err?.message || err}`));
    }
    return { result, endedSteer };
  });
}
