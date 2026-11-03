// Pure derivations for the admin Stats "Audience" cards. Dependency-free and
// side-effect-free so they unit-test in isolation (audienceStats.test.ts).

import { deviceLabel, type ListenerConnection } from './clientLabel';

// hour-of-day histogram

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

// Buckets the per-minute listener series by local hour-of-day (Date#getHours,
// so the caller must label the axis local time). Always returns all 24 hours in
// order; an empty hour has avg 0 / samples 0 so it renders as an empty column.
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

// live device breakdown

export interface DeviceGroup {
  device: string; // device/OS class from deviceLabel
  count: number; // distinct listeners on this device class right now
  avgSeconds: number; // mean connected-for across those listeners
  maxSeconds: number; // longest connected-for in the group
}

// Input is already deduped to one row per listener (groupConnections on the
// server), so each row is one distinct listener. Sorted by listener count desc,
// then by average connected-for desc.
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

// listener trend chart

export interface TimedCount {
  ms: number; // epoch ms
  count: number;
}

// The chart places samples by time, not by index: the series has gaps wherever
// the controller was down, and an index axis would slide every later reading
// left of where it happened. Unparseable timestamps are dropped.
export function timedSamples(samples: ListenerSample[]): TimedCount[] {
  const out: TimedCount[] = [];
  for (const s of samples) {
    const ms = new Date(s.t).getTime();
    if (!Number.isFinite(ms)) continue;
    out.push({ ms, count: Number.isFinite(s.count) ? s.count : 0 });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

// Spans past this read as days: axis ticks fall on local midnights.
const DAY_AXIS_MS = 36 * 3_600_000;

export function isLongSpan(spanMs: number): boolean {
  return spanMs > DAY_AXIS_MS;
}

export interface AxisTick {
  ms: number;
  frac: number; // 0–1 across [t0, t1]
  label: string;
}

// Time-axis ticks on round local times: every 6 hours ("06:00") for a day-long
// span, every local midnight ("Tue") past that. Ticks hugging either edge are
// dropped so their centred labels are not clipped by the card.
export function timeTicks(t0: number, t1: number): AxisTick[] {
  const span = t1 - t0;
  if (!(span > 0)) return [];
  const long = isLongSpan(span);
  const d = new Date(t0);
  d.setMinutes(0, 0, 0);
  if (long) d.setHours(0);
  const step = long ? 24 : 6;
  // Advance to the first round boundary at or after t0.
  while (d.getTime() < t0 || d.getHours() % step !== 0) d.setHours(d.getHours() + 1);
  const ticks: AxisTick[] = [];
  for (; d.getTime() <= t1; d.setHours(d.getHours() + step)) {
    const ms = d.getTime();
    const frac = (ms - t0) / span;
    if (frac < 0.04 || frac > 0.96) continue;
    ticks.push({
      ms,
      frac,
      label: long
        ? d.toLocaleDateString('en-GB', { weekday: 'short' })
        : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    });
  }
  return ticks;
}

// History is one row per wall-clock minute, and the controller skips a minute
// it could not read so an outage stays a gap (broadcast/listeners.ts). The chart
// honours that by breaking the line wherever rows are further apart than this.
export const SAMPLE_GAP_MS = 5 * 60_000;

export function splitAtGaps(series: TimedCount[], gapMs = SAMPLE_GAP_MS): TimedCount[][] {
  const runs: TimedCount[][] = [];
  let run: TimedCount[] = [];
  for (const s of series) {
    const prev = run[run.length - 1];
    if (prev && s.ms - prev.ms > gapMs) {
      runs.push(run);
      run = [];
    }
    run.push(s);
  }
  if (run.length) runs.push(run);
  return runs;
}
