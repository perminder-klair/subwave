// Audience-source analytics — durable, aggregate-only.
//
// Answers "where do the listeners come from, and roughly where are they?" for
// the admin Stats page, without retaining any raw PII. Data arrives two ways,
// both off the same Cloudflare-fronted edge:
//   - the player POSTs a one-shot /beacon on first load carrying
//     document.referrer + any UTM param. The external referrer is ONLY visible
//     on the initial HTML navigation (which hits `web`, not the controller —
//     the API polls only ever see a same-origin referrer), so the browser has
//     to hand it to us.
//   - that same beacon request carries Cloudflare's Cf-Connecting-Ip +
//     Cf-Ipcountry, giving us geography and a distinct-session estimate.
//
// Privacy: a raw IP is NEVER stored. The IP is salted+hashed (the salt is
// process-random and never persisted) only to dedupe sessions within a day; we
// persist the resulting *count*, not the set. Everything written to disk is an
// aggregate count.
//
// Mirrors broadcast/listeners.ts: in-memory aggregate + periodic flush to a
// JSON file under config.stateDir, loaded on boot.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';

const STORE_FILE = join(config.stateDir, 'audience.json');
const RETAIN_DAYS = 60;          // how many day-buckets we keep on disk
const LIST_CAP = 40;             // max distinct keys kept per map (top by count)
const FLUSH_MS = 20_000;         // dirty-flag flush cadence

// Per-day (UTC) aggregate. `_seen` is the in-memory dedupe set — stripped on
// serialize (underscore key), so it never reaches disk.
interface DayBucket {
  date: string;                          // YYYY-MM-DD (UTC)
  sessions: number;                      // distinct hashed IPs counted that day
  referrers: Record<string, number>;     // normalized source → count
  countries: Record<string, number>;     // ISO country → count
  paths: Record<string, number>;         // landing path → count
  _seen: Set<string>;                    // hashed IPs — NOT persisted
}

const buckets = new Map<string, DayBucket>();
// Process-random salt: stable within a run (enough for same-day dedupe), never
// written anywhere, so a stored count can't be reversed to an IP.
const SALT = randomBytes(16).toString('hex');
let dirty = false;
let loaded = false;

function todayUtc(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function bucketFor(date: string): DayBucket {
  let b = buckets.get(date);
  if (!b) {
    b = { date, sessions: 0, referrers: {}, countries: {}, paths: {}, _seen: new Set() };
    buckets.set(date, b);
  }
  return b;
}

function hashIp(ip: string, date: string): string {
  return createHash('sha256').update(`${SALT}|${date}|${ip}`).digest('hex').slice(0, 24);
}

function inc(map: Record<string, number>, key: string | undefined | null) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

// Collapse a raw document.referrer (+ optional UTM) into a single source label.
// UTM wins when present; multi-host sources (Reddit web/app/old/android-app) are
// grouped; our own host and empty referrers are "direct".
export function normalizeReferrer(rawReferrer?: string, utmSource?: string): string {
  if (utmSource) return utmSource.toLowerCase().slice(0, 40);
  const raw = (rawReferrer || '').trim();
  if (!raw) return 'direct';

  // Reddit's Android app reports an android-app:// referrer that the URL parser
  // mangles — catch it before parsing.
  if (/^android-app:\/\/com\.reddit/i.test(raw)) return 'reddit';

  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return 'direct';
  }
  if (!host) return 'direct';
  host = host.replace(/^www\./, '');

  if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
  if (host === 'getsubwave.com' || host.endsWith('.getsubwave.com')) return 'direct';
  return host.slice(0, 60);
}

export interface RecordInput {
  ip?: string;
  country?: string;
  referrer?: string;
  utmSource?: string;
  path?: string;
}

// Record one beacon. First-touch dedupe: the first beacon from a given IP on a
// given day is counted; later ones (refreshes, retries, spam) are ignored. That
// bounds abuse and gives clean "distinct sessions" + first-touch attribution.
export function record(input: RecordInput): void {
  const ip = (input.ip || '').trim();
  if (!ip) return;
  const date = todayUtc();
  const b = bucketFor(date);
  const h = hashIp(ip, date);
  if (b._seen.has(h)) return;
  b._seen.add(h);

  b.sessions += 1;
  inc(b.referrers, normalizeReferrer(input.referrer, input.utmSource));
  const country = (input.country || '').toUpperCase().slice(0, 4);
  if (country && country !== 'XX') inc(b.countries, country);
  if (input.path) inc(b.paths, input.path.slice(0, 80));
  dirty = true;
}

// Sort a count map desc and cap to the top `n` as a {key,count}[] list.
function topList<K extends string>(
  map: Record<string, number>,
  keyName: K,
  n = LIST_CAP,
): (Record<K, string> & { count: number })[] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, count]) => ({ [keyName]: k, count }) as Record<K, string> & { count: number });
}

export interface AudienceSummary {
  sinceMinutes: number;
  sessions: number;
  referrers: { source: string; count: number }[];
  countries: { country: string; count: number }[];
  paths: { path: string; count: number }[];
  days: { date: string; sessions: number }[];
}

// Aggregate the day-buckets within the window into a single rollup.
export function summary({ sinceMinutes = 1440 }: { sinceMinutes?: number } = {}): AudienceSummary {
  const cutoff = new Date(Date.now() - sinceMinutes * 60 * 1000);
  const cutoffDate = todayUtc(cutoff);
  const referrers: Record<string, number> = {};
  const countries: Record<string, number> = {};
  const paths: Record<string, number> = {};
  let sessions = 0;
  const days: { date: string; sessions: number }[] = [];

  for (const b of [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    if (b.date < cutoffDate) continue;
    sessions += b.sessions;
    for (const [k, v] of Object.entries(b.referrers)) referrers[k] = (referrers[k] || 0) + v;
    for (const [k, v] of Object.entries(b.countries)) countries[k] = (countries[k] || 0) + v;
    for (const [k, v] of Object.entries(b.paths)) paths[k] = (paths[k] || 0) + v;
    days.push({ date: b.date, sessions: b.sessions });
  }

  return {
    sinceMinutes,
    sessions,
    referrers: topList(referrers, 'source'),
    countries: topList(countries, 'country'),
    paths: topList(paths, 'path'),
    days,
  };
}

// --- persistence -----------------------------------------------------------

interface StoredBucket {
  date: string;
  sessions: number;
  referrers: Record<string, number>;
  countries: Record<string, number>;
  paths: Record<string, number>;
}

// Trim a map to its top LIST_CAP keys so the file can't grow unbounded if an
// odd referrer/country long-tail accumulates.
function capMap(map: Record<string, number>): Record<string, number> {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, LIST_CAP);
  return Object.fromEntries(entries);
}

async function flush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  // Keep only the most recent RETAIN_DAYS buckets.
  const kept = [...buckets.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-RETAIN_DAYS);
  const days: StoredBucket[] = kept.map(b => ({
    date: b.date,
    sessions: b.sessions,
    referrers: capMap(b.referrers),
    countries: capMap(b.countries),
    paths: capMap(b.paths),
  }));
  try {
    await writeFile(STORE_FILE, JSON.stringify({ days }, null, 2));
  } catch {
    dirty = true; // retry on the next tick
  }
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  if (!existsSync(STORE_FILE)) return;
  try {
    const raw = await readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { days?: StoredBucket[] };
    for (const d of parsed.days || []) {
      if (!d?.date) continue;
      // _seen starts empty on load: an IP already counted earlier today can be
      // re-counted once after a restart. Acceptable session over-count; never
      // resurrected because nothing reverses the hash.
      buckets.set(d.date, {
        date: d.date,
        sessions: d.sessions || 0,
        referrers: d.referrers || {},
        countries: d.countries || {},
        paths: d.paths || {},
        _seen: new Set(),
      });
    }
  } catch {
    /* corrupt file — start fresh, the next flush overwrites it */
  }
}

export async function startAudienceMonitor(): Promise<void> {
  await load();
  setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
}
