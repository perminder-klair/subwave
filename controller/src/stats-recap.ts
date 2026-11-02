// The admin Stats page's weekly recap ("This week") and most-played lists: the
// last seven complete UTC days against the seven before, read only from the
// durable records (audience day-buckets, listeners.jsonl, the request log and
// library.db plays), so unlike the /stats rings it survives a restart.
//
// A figure whose record does not reach back to the start of its window is
// null, not zero. A station a few days old has no week before to compare
// against, and a delta against a half-empty week would read as a surge.
//
// listeners.jsonl is read whole, so weekRecap() caches for a few minutes and the
// page polls it slowly. buildWeekRecap() is the pure part (stats-recap.test.ts).

import * as audience from './broadcast/audience.js';
import * as listeners from './broadcast/listeners.js';
import * as requestLog from './broadcast/request-log.js';
import * as db from './music/library-db.js';
import * as settings from './settings.js';
import { isNamedRequester } from './util/request-guard.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MOST_PLAYED_DAYS = 7;
const MOST_PLAYED_LIST = 6;
const CACHE_MS = 5 * 60_000;

export interface WeekTotals {
  sessions: number | null;
  countries: number | null;
  listeningHours: number | null;
  requests: number | null;
  tracks: number | null;
}

export interface WeekRecap {
  station: string;
  // UTC dates, both inclusive; `number` is the ISO week of `from`.
  week: { from: string; to: string; number: number };
  current: WeekTotals;
  previous: WeekTotals;
  // `at` is the start of the busiest clock hour, for the page to show in local time.
  busiestHour: { at: string; avg: number } | null;
  topArtist: { name: string; plays: number; requested: number } | null;
  topTrack: { title: string; artist: string | null; plays: number } | null;
  topRequester: { name: string; requests: number } | null;
  newSource: { source: string; sessions: number; firstSeen: string } | null;
  mostPlayed: {
    days: number;
    artists: { name: string; plays: number }[];
    tracks: { title: string; artist: string | null; plays: number }[];
  };
}

export interface RecapInput {
  now: number;
  station: string;
  days: audience.AudienceDay[];
  samples: { t: string; count: number }[];
  requests: { t: string; requester: string | null }[];
  // Null when library.db is not open.
  plays: db.PlayTally[] | null;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
const round1 = (n: number) => Math.round(n * 10) / 10;

function isoWeek(ms: number): number {
  const d = new Date(startOfUtcDay(ms));
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // the Thursday of this ISO week
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
}

interface Window { from: number; to: number }

// A record covers a window when it reaches back into the window's first day.
const covers = (earliestMs: number | null, w: Window) => earliestMs != null && earliestMs < w.from + DAY_MS;

function earliest(times: number[]): number | null {
  let min: number | null = null;
  for (const t of times) if (Number.isFinite(t) && (min == null || t < min)) min = t;
  return min;
}

function tally<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, { row: T; count: number }> {
  const out = new Map<string, { row: T; count: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const hit = out.get(key);
    if (hit) hit.count++;
    else out.set(key, { row, count: 1 });
  }
  return out;
}

const ranked = <T>(m: Map<string, { row: T; count: number }>) =>
  [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

const artistKey = (p: db.PlayTally) => p.artist?.trim() || null;
const trackKey = (p: db.PlayTally) => (p.title?.trim() ? `${p.artist?.trim() ?? ''}\u0000${p.title.trim()}` : null);

function topArtists(plays: db.PlayTally[], n: number) {
  return ranked(tally(plays, artistKey)).slice(0, n).map(([name, g]) => ({ name, plays: g.count }));
}

function topTracks(plays: db.PlayTally[], n: number) {
  return ranked(tally(plays, trackKey)).slice(0, n).map(([, g]) => ({
    title: g.row.title!.trim(),
    artist: g.row.artist?.trim() || null,
    plays: g.count,
  }));
}

export function buildWeekRecap(input: RecapInput): WeekRecap {
  const today = startOfUtcDay(input.now);
  const week: Window = { from: today - 7 * DAY_MS, to: today };
  const prev: Window = { from: today - 14 * DAY_MS, to: week.from };
  const inWindow = (ms: number, w: Window) => ms >= w.from && ms < w.to;

  // Audience: UTC day-buckets, so a window is a date range.
  const audienceEarliest = input.days.length ? Date.parse(`${input.days[0]!.date}T00:00:00Z`) : null;
  const audienceTotals = (w: Window) => {
    const days = input.days.filter(d => inWindow(Date.parse(`${d.date}T00:00:00Z`), w));
    const countries = new Set<string>();
    for (const d of days) for (const [c, n] of Object.entries(d.countries)) if (n > 0) countries.add(c);
    return { sessions: days.reduce((a, d) => a + d.sessions, 0), countries: countries.size };
  };

  // Listening hours: one sample per minute, so a sample's count is listener-minutes.
  const samples = input.samples.map(s => ({ ms: Date.parse(s.t), count: s.count })).filter(s => Number.isFinite(s.ms));
  const samplesEarliest = earliest(samples.map(s => s.ms));
  const listeningHours = (w: Window) => {
    const inside = samples.filter(s => inWindow(s.ms, w));
    return inside.length ? round1(inside.reduce((a, s) => a + s.count, 0) / 60) : null;
  };

  const requests = input.requests.map(r => ({ ms: Date.parse(r.t), requester: r.requester })).filter(r => Number.isFinite(r.ms));
  const requestsEarliest = earliest(requests.map(r => r.ms));

  const plays = input.plays?.map(p => ({ ...p, ms: Date.parse(p.playedAt) })).filter(p => Number.isFinite(p.ms)) ?? null;
  const playsEarliest = plays ? earliest(plays.map(p => p.ms)) : null;

  const totals = (w: Window, needCoverage: boolean): WeekTotals => {
    const a = needCoverage && !covers(audienceEarliest, w) ? null : audienceTotals(w);
    return {
      sessions: a?.sessions ?? null,
      countries: a?.countries ?? null,
      listeningHours: needCoverage && !covers(samplesEarliest, w) ? null : listeningHours(w),
      requests: needCoverage && !covers(requestsEarliest, w) ? null : requests.filter(r => inWindow(r.ms, w)).length,
      tracks: !plays || (needCoverage && !covers(playsEarliest, w)) ? null : plays.filter(p => inWindow(p.ms, w)).length,
    };
  };

  // Busiest single clock hour of the week, by its mean per-minute count.
  const hours = new Map<number, { sum: number; n: number }>();
  for (const s of samples) {
    if (!inWindow(s.ms, week)) continue;
    const h = Math.floor(s.ms / HOUR_MS) * HOUR_MS;
    const g = hours.get(h) ?? { sum: 0, n: 0 };
    g.sum += s.count;
    g.n++;
    hours.set(h, g);
  }
  let busiestHour: WeekRecap['busiestHour'] = null;
  for (const [h, g] of hours) {
    const avg = g.sum / g.n;
    if (avg > 0 && (!busiestHour || avg > busiestHour.avg)) busiestHour = { at: new Date(h).toISOString(), avg };
  }
  if (busiestHour) busiestHour.avg = round1(busiestHour.avg);

  const weekPlays = plays?.filter(p => inWindow(p.ms, week)) ?? [];
  const artistTop = topArtists(weekPlays, 1)[0];
  const topArtist = artistTop
    ? {
        ...artistTop,
        requested: weekPlays.filter(p => artistKey(p) === artistTop.name && p.requestedBy?.trim()).length,
      }
    : null;

  const requesterTop = ranked(tally(
    requests.filter(r => inWindow(r.ms, week)),
    r => (isNamedRequester(r.requester) ? r.requester!.trim() : null),
  ))[0];

  // A referrer first seen this week. Needs audience history from before the
  // week, or every source would be "new".
  let newSource: WeekRecap['newSource'] = null;
  if (audienceEarliest != null && audienceEarliest < week.from) {
    const firstSeen = new Map<string, string>();
    for (const d of input.days) {
      for (const [src, n] of Object.entries(d.referrers)) if (n > 0 && !firstSeen.has(src)) firstSeen.set(src, d.date);
    }
    const weekFrom = isoDate(week.from);
    const weekTo = isoDate(week.to);
    for (const [src, first] of firstSeen) {
      if (src === 'direct' || first < weekFrom || first >= weekTo) continue;
      const sessions = input.days
        .filter(d => d.date >= weekFrom && d.date < weekTo)
        .reduce((a, d) => a + (d.referrers[src] ?? 0), 0);
      if (!newSource || sessions > newSource.sessions) newSource = { source: src, sessions, firstSeen: first };
    }
  }

  const recent = plays?.filter(p => p.ms >= input.now - MOST_PLAYED_DAYS * DAY_MS) ?? [];

  return {
    station: input.station,
    week: { from: isoDate(week.from), to: isoDate(week.to - DAY_MS), number: isoWeek(week.from) },
    current: totals(week, false),
    previous: totals(prev, true),
    busiestHour,
    topArtist,
    topTrack: topTracks(weekPlays, 1)[0] ?? null,
    topRequester: requesterTop ? { name: requesterTop[0], requests: requesterTop[1].count } : null,
    newSource,
    mostPlayed: {
      days: MOST_PLAYED_DAYS,
      artists: topArtists(recent, MOST_PLAYED_LIST),
      tracks: topTracks(recent, MOST_PLAYED_LIST),
    },
  };
}

let cache: { at: number; value: WeekRecap } | null = null;

export async function weekRecap(now = Date.now()): Promise<WeekRecap> {
  if (cache && now - cache.at < CACHE_MS && startOfUtcDay(cache.at) === startOfUtcDay(now)) return cache.value;
  const since = startOfUtcDay(now) - 14 * DAY_MS;
  const [samples, requests] = await Promise.all([
    listeners.history({ since: new Date(since) }),
    requestLog.readLog(),
  ]);
  let plays: db.PlayTally[] | null = null;
  try {
    plays = db.playsSince(new Date(since).toISOString());
  } catch {
    // library.db not open: the play-based figures report as unmeasured.
  }
  const value = buildWeekRecap({
    now,
    station: settings.get().station || 'SUB/WAVE',
    days: audience.days(),
    samples,
    requests,
    plays,
  });
  cache = { at: now, value };
  return value;
}
