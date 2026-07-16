// Pure client-side derivations for the admin Stats "Audience" cards. Kept
// dependency-free and side-effect-free so they unit-test in isolation
// (audienceStats.test.ts) — the React panel just calls them and renders.

import { deviceLabel, type ListenerConnection } from './clientLabel';

// --- hour-of-day histogram ------------------------------------------------

export interface ListenerSample {
  t: string; // ISO timestamp
  count: number;
}

export interface HourBucket {
  hour: number; // 0–23, local time
  avg: number; // mean listener count across samples in this hour
  peak: number; // max listener count seen in this hour
  samples: number; // how many samples landed in this hour (0 = no data)
}

// Bucket the per-minute listener series by local hour-of-day and average each
// hour's counts — "what times of day is the station busiest?". Uses the
// runtime's local timezone via Date#getHours (the caller labels the axis as
// local time). Always returns all 24 hours in order; an hour with no samples
// has avg 0 / samples 0 so the caller can render it as an empty column.
export function bucketSamplesByHour(samples: ListenerSample[]): HourBucket[] {
  const acc = Array.from({ length: 24 }, () => ({ total: 0, peak: 0, n: 0 }));
  for (const s of samples) {
    const d = new Date(s.t);
    const ms = d.getTime();
    if (!Number.isFinite(ms)) continue; // skip an unparseable timestamp
    const c = Number.isFinite(s.count) ? s.count : 0;
    const a = acc[d.getHours()];
    if (!a) continue; // getHours() is always 0–23; guard satisfies strict indexing
    a.total += c;
    a.peak = Math.max(a.peak, c);
    a.n += 1;
  }
  return acc.map((a, hour) => ({
    hour,
    avg: a.n ? a.total / a.n : 0,
    peak: a.peak,
    samples: a.n,
  }));
}

// --- live device breakdown ------------------------------------------------

export interface DeviceGroup {
  device: string; // device/OS class from deviceLabel
  count: number; // distinct listeners on this device class right now
  avgSeconds: number; // mean connected-for across those listeners
  maxSeconds: number; // longest connected-for in the group
}

// Fold live listener connections into a per-device-class breakdown with
// connected-for stats. Input is already deduped to one row per listener
// (groupConnections on the server), so each row is one distinct listener.
// Sorted by listener count desc, then by average connected-for desc.
export function groupConnectionsByDevice(conns: ListenerConnection[]): DeviceGroup[] {
  const map = new Map<string, { count: number; total: number; max: number }>();
  for (const c of conns) {
    const device = deviceLabel(c.userAgent);
    const secs =
      Number.isFinite(c.connectedSeconds) && c.connectedSeconds > 0 ? c.connectedSeconds : 0;
    const g = map.get(device) ?? { count: 0, total: 0, max: 0 };
    g.count += 1;
    g.total += secs;
    g.max = Math.max(g.max, secs);
    map.set(device, g);
  }
  return [...map.entries()]
    .map(([device, g]) => ({
      device,
      count: g.count,
      avgSeconds: g.count ? g.total / g.count : 0,
      maxSeconds: g.max,
    }))
    .sort((a, b) => b.count - a.count || b.avgSeconds - a.avgSeconds);
}
