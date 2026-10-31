// Giving orphan stem dirs their names back.
//
// An orphan dir is named by its track id, and by the time a purge looks, that
// id is GONE from `tracks` (a refresh deletes rows for files the music server
// dropped) and usually gone from the music server itself. The name still
// exists in three places, each older than the last, so resolution walks them
// in order and takes the first hit:
//
//   1. a `.track-meta.json` sidecar — written into the dir when it is
//      quarantined (and read eagerly, so it also survives a controller
//      restart between report and press);
//   2. the library db — a row that came back (released edge), then the
//      `plays` table, which stores title/artist/album as air snapshots and
//      outlives the track;
//   3. `recent-plays.json`, then the rolling `logs/events-*.jsonl` files,
//      whose navidrome events embed {id,title,artist} triples — no album, and
//      only ~two weeks of retention, which is exactly why step 1 exists.
//
// The log scan is lazy (only ids nothing else resolved) and cached: the daily
// event files are tens of MB each, so it must never run per-row or on every
// panel paint. Every source is optional — a resolver that cannot read the db
// or the logs still answers, with fewer names.

import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { mapPool } from '../util/async-pool.js';
import { config } from '../config.js';
import { requireDb } from './library-db/handle.js';
import { SCAN_CONCURRENCY, stemsRoot, stemsRootStatus } from './stem-cache.js';
import { IN_FLIGHT_MS, QUARANTINE_DIR } from './orphan-purge-pure.js';

/** Sidecar written into a stem dir at quarantine time. Dot-prefixed so every
 *  existing walk that filters dot-entries keeps ignoring it. */
export const NAME_SIDECAR = '.track-meta.json';

export interface OrphanTrackName {
  title: string;
  artist?: string;
  album?: string;
  /** Which source answered — the UI does not show it, tests and logs do. */
  source: 'sidecar' | 'library' | 'plays' | 'recent' | 'log';
}

export interface ResolveOpts {
  stemsRootDir?: string;
  logDir?: string;
  stateDir?: string;
  now?: number;
  /** Skip the (lazy, expensive) event-log scan — used by the quarantine
   *  stamp path when the caller already accepted a coarse answer. */
  skipLogs?: boolean;
}

// ---- event-log scan ---------------------------------------------------------

const LOG_TTL_MS = 10 * 60_000;
let logCache: { at: number; map: Map<string, OrphanTrackName> } | null = null;

/** Drop the cached log-name map (tests; after anything that truncates logs). */
export function invalidateLogNames(): void { logCache = null; }

/** One `{id,title,artist}` triple as the navidrome event logger writes it.
 *  22-char ids only — the Subsonic id shape — so the regex never claims a
 *  random json field. */
const TRIPLE_RE = /\{"id":"([0-9A-Za-z_-]{22})","title":"((?:[^"\\]|\\.)*)","artist":"((?:[^"\\]|\\.)*)"\}/g;

function unjsonString(raw: string): string {
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
}

/** Pure: append every `{id,title,artist}` triple in one log line to `out`.
 *  With `wanted`, only those ids are recorded; without it, every triple is —
 *  which is how the cache is built (one scan serving all later lookups).
 *  First hit wins per id: names rarely change and any hit beats no hit. */
export function parseNameHits(line: string, out: Map<string, OrphanTrackName>, wanted?: ReadonlySet<string>): void {
  if (!line.includes('"title"')) return;
  TRIPLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRIPLE_RE.exec(line)) !== null) {
    const id = m[1];
    if (wanted && !wanted.has(id)) continue;
    if (!out.has(id)) out.set(id, { title: unjsonString(m[2]), artist: unjsonString(m[3]), source: 'log' });
  }
}

async function namesFromLogs(missing: ReadonlySet<string>, logDir: string, now: number): Promise<Map<string, OrphanTrackName>> {
  if (missing.size === 0) return new Map();
  if (!logCache || now - logCache.at > LOG_TTL_MS) {
    const fresh = new Map<string, OrphanTrackName>();
    let files: string[] = [];
    try { files = (await readdir(logDir)).filter(f => f.startsWith('events-') && f.endsWith('.jsonl')).sort(); } catch { /* no logs dir: fine */ }
    let complete = true;
    for (const file of files) {
      // Line by line: a day's events file runs to tens of MB.
      try {
        const lines = createInterface({ input: createReadStream(path.join(logDir, file), 'utf8'), crlfDelay: Infinity });
        for await (const line of lines) {
          if (line) parseNameHits(line, fresh); // every triple: the cache serves later calls too
        }
      } catch { complete = false; }
    }
    // Only a scan that read every file is cached; a half-scanned one answers
    // this call and runs again next time.
    if (!complete) return pick(fresh, missing);
    logCache = { at: now, map: fresh };
  }
  return pick(logCache.map, missing);
}

function pick(map: ReadonlyMap<string, OrphanTrackName>, missing: ReadonlySet<string>): Map<string, OrphanTrackName> {
  const hit = new Map<string, OrphanTrackName>();
  for (const id of missing) {
    const n = map.get(id);
    if (n) hit.set(id, n);
  }
  return hit;
}

// ---- library db -------------------------------------------------------------

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** tracks-row hit (a dir whose id came back) then the `plays` air snapshot.
 *  Db closed/unavailable → empty map; names are a courtesy, not a guarantee. */
function namesFromDb(ids: readonly string[]): Map<string, OrphanTrackName> {
  const out = new Map<string, OrphanTrackName>();
  if (ids.length === 0) return out;
  let db: ReturnType<typeof requireDb> | null = null;
  try { db = requireDb(); } catch { return out; }
  for (const part of chunk(ids, 500)) {
    const ph = part.map(() => '?').join(',');
    try {
      for (const r of db.prepare(`SELECT id, title, artist, album FROM tracks WHERE id IN (${ph})`).all(...part) as Array<{ id: string; title: string | null; artist: string | null; album: string | null }>) {
        if (r.title) out.set(r.id, { title: r.title, artist: r.artist ?? undefined, album: r.album ?? undefined, source: 'library' });
      }
    } catch { /* keep what we have */ }
    try {
      // Newest play per id wins; ORDER BY id DESC on the rowid-ish key first,
      // so a later row only overwrites an id it has not already resolved.
      const rows = db.prepare(`SELECT track_id, title, artist, album, MAX(played_at) AS played_at FROM plays WHERE track_id IN (${ph}) GROUP BY track_id`).all(...part) as Array<{ track_id: string; title: string | null; artist: string | null; album: string | null }>;
      for (const r of rows) {
        if (r.title && !out.has(r.track_id)) out.set(r.track_id, { title: r.title, artist: r.artist ?? undefined, album: r.album ?? undefined, source: 'plays' });
      }
    } catch { /* keep what we have */ }
  }
  return out;
}

// ---- recent-plays sidecar ---------------------------------------------------

async function namesFromRecent(missing: ReadonlySet<string>, stateDir: string): Promise<Map<string, OrphanTrackName>> {
  const out = new Map<string, OrphanTrackName>();
  if (missing.size === 0) return out;
  let arr: unknown;
  try { arr = JSON.parse(await readFile(path.join(stateDir, 'recent-plays.json'), 'utf8')); } catch { return out; }
  if (!Array.isArray(arr)) return out;
  for (const e of arr as Array<Record<string, unknown>>) {
    const id = typeof e.id === 'string' ? e.id : '';
    if (!missing.has(id) || out.has(id) || typeof e.title !== 'string') continue;
    out.set(id, {
      title: e.title,
      artist: typeof e.artist === 'string' ? e.artist : undefined,
      album: typeof e.album === 'string' ? e.album : undefined,
      source: 'recent',
    });
  }
  return out;
}

// ---- sidecars ---------------------------------------------------------------

async function readSidecar(dir: string): Promise<OrphanTrackName | null> {
  try {
    const v = JSON.parse(await readFile(path.join(dir, NAME_SIDECAR), 'utf8')) as Record<string, unknown>;
    if (typeof v.title !== 'string') return null;
    return {
      title: v.title,
      artist: typeof v.artist === 'string' ? v.artist : undefined,
      album: typeof v.album === 'string' ? v.album : undefined,
      source: 'sidecar',
    };
  } catch { return null; }
}

/** Best-effort stamp into a quarantine dir; the name is a courtesy and never
 *  fails a quarantine that already moved. */
export async function writeNameSidecar(dir: string, name: OrphanTrackName | undefined, now: number): Promise<void> {
  if (!name?.title) return;
  try {
    await (await import('node:fs/promises')).writeFile(path.join(dir, NAME_SIDECAR), JSON.stringify({
      title: name.title,
      ...(name.artist ? { artist: name.artist } : {}),
      ...(name.album ? { album: name.album } : {}),
      orphanedAt: now,
    }));
  } catch { /* unresolved stays unresolved */ }
}

// ---- the resolver -----------------------------------------------------------

/** Resolve display names for stem dir ids (orphans at the cache root and/or
 *  quarantine entries). Missing names are simply absent from the map. */
export async function resolveOrphanNames(ids: readonly string[], opts: ResolveOpts = {}): Promise<Map<string, OrphanTrackName>> {
  const now = opts.now ?? Date.now();
  const root = opts.stemsRootDir ?? stemsRoot();
  const logDir = opts.logDir ?? path.join(config.stateDir, 'logs');
  const stateDir = opts.stateDir ?? config.stateDir;
  const out = new Map<string, OrphanTrackName>();
  if (ids.length === 0) return out;

  // 1. Sidecars — live dir first, then quarantine (a dir exists in exactly one).
  for (const id of ids) {
    const n = (await readSidecar(path.join(root, id))) ?? (await readSidecar(path.join(root, QUARANTINE_DIR, id)));
    if (n) out.set(id, n);
  }

  // 2. Library db (rows that came back; then plays snapshots).
  let missing = ids.filter(id => !out.has(id));
  if (missing.length > 0) {
    for (const [id, n] of namesFromDb(missing)) out.set(id, n);
  }

  // 3. recent-plays.json.
  missing = ids.filter(id => !out.has(id));
  if (missing.length > 0) {
    for (const [id, n] of await namesFromRecent(new Set(missing), stateDir)) out.set(id, n);
  }

  // 4. Event logs — the lazy, cached, expensive tail.
  missing = ids.filter(id => !out.has(id));
  if (!opts.skipLogs && missing.length > 0) {
    for (const [id, n] of await namesFromLogs(new Set(missing), logDir, now)) out.set(id, n);
  }
  return out;
}

/** Orphan dir names at the cache root (not known ids, not dot dirs, not
 *  written within IN_FLIGHT_MS). Shares the purge's walk rules, the in-flight
 *  grace included, so the list and the report never disagree. */
export async function listOrphanDirNames(knownIds: ReadonlySet<string>, now = Date.now()): Promise<string[]> {
  const status = await stemsRootStatus({ readOnly: true });
  if (!status.online) return [];
  const root = stemsRoot();
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !knownIds.has(e.name)).map(e => e.name);
  } catch {
    return [];
  }
  const ages = await mapPool(names, SCAN_CONCURRENCY,
    name => stat(path.join(root, name)).then(st => st.mtimeMs, () => null));
  return names.filter((_, i) => ages[i] != null && now - ages[i]! >= IN_FLIGHT_MS);
}

export async function listQuarantineDirNames(): Promise<string[]> {
  try {
    const entries = await readdir(path.join(stemsRoot(), QUARANTINE_DIR), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
}
