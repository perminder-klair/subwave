import type { PreparationOccurrence } from '../schemas/show-preparation.js';
import type { ScheduleWeek } from '../schemas/schedule.js';
import type { ZonedParts } from '../time.js';

const MINUTE = 60_000;
const HORIZON = 8 * 24 * 60;

export function resolveShowOccurrence({ at, showId, schedule, override, parts }: {
  at: number; showId: string; schedule: ScheduleWeek;
  override: { showId: string | null; startedAt: number; expiresAt: number } | null;
  parts: (at: number) => ZonedParts;
}): PreparationOccurrence | null {
  if (override && at >= override.startedAt && at < override.expiresAt) {
    return override.showId === showId ? {
      id: `takeover:${showId}:${override.startedAt}`, showId, source: 'takeover',
      startsAt: override.startedAt, endsAt: override.expiresAt,
    } : null;
  }
  const slot = (ms: number) => { const p = parts(ms); return schedule[p.dow]?.[p.hour]; };
  if (slot(at) !== showId) return null;
  const wholeWeek = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => schedule[day]?.[hour] === showId)).flat().every(Boolean);
  const weekBoundary = (ms: number) => {
    const p = parts(ms);
    return p.dow === 0 && p.hour === 0 && p.minute === 0;
  };
  let startsAt = Math.floor(at / MINUTE) * MINUTE;
  for (let n = 0; n < HORIZON; n++) {
    if (wholeWeek && weekBoundary(startsAt)) break;
    if (slot(startsAt - MINUTE) !== showId) break;
    startsAt -= MINUTE;
  }
  let endsAt = Math.floor(at / MINUTE) * MINUTE + MINUTE;
  for (let n = 0; n < HORIZON; n++, endsAt += MINUTE) {
    if (slot(endsAt) !== showId || (wholeWeek && weekBoundary(endsAt))) break;
  }
  return { id: `scheduled:${showId}:${startsAt}`, showId, source: 'scheduled', startsAt, endsAt };
}
