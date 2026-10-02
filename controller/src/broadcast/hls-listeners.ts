// HLS listener counting — the second leg of the station's listener count, next
// to broadcast/listeners.ts's Icecast sockets.
//
// HLS is static files: Liquidsoap writes segments and a rolling playlist, the
// edge serves that directory, and a listener holds NO socket. Icecast therefore
// reads an HLS-only audience as an empty room — the DJ would pause for an empty
// room, the stream idle gate would freeze the programme on it, and Last.fm
// (whose gate fails CLOSED) would never see a listener to scrobble for.
//
// The one trace an HLS listener leaves is the MEDIA PLAYLIST: a client that is
// playing re-fetches it about once per segment for as long as it plays, because
// that is the only way it learns about the next segment. The edge (both
// docker/Caddyfile and docker/aio/Caddyfile) routes exactly those requests —
// `*.m3u8`, never segments — into their own JSON access log, and this module
// reads the tail of that log. Same shape as
// AzuraCast's nginx hls.log reader, and for the same reason: it is the only
// approach that also sees clients we did not write (Safari, VLC, a hardware
// player), since it asks for nothing from the client.
//
// Everything here is a bounded READ of one local file — no service to poll, no
// socket to hold — so the refresh runs every REFRESH_MS and a listener appears
// within one tick and drops out WINDOW_MS after their last playlist fetch.

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { hlsActive } from './hls-policy.js';
import type { ListenerConnection } from './listeners.js';

// Where Caddy's `log hls_access` writes: <state root>/edge/, the same file on
// both stacks (the compose edge bind-mounts that directory, docker-compose.yml).
// stateROOT, not stateDir: the edge serves one HLS directory and knows nothing
// about the per-station layout underneath it.
const LOG_DIR = join(config.stateRoot, 'edge');
const LOG_PATH = join(LOG_DIR, 'hls-access.log');
// Where radio.liq writes the segments and playlists (its state_root).
const HLS_DIR = join(config.stateRoot, 'hls');
// Caddy rolls to "<base>-<timestamp>.log" beside it, uncompressed by config, and
// the timestamp format sorts lexicographically — newest last.
const ROLLED_PREFIX = 'hls-access-';
const ROLLED_SUFFIX = '.log';
// How many rolled files the walk may fall back into. Two is already one more
// than a single roll can hide.
const ROLLED_LOOKBACK = 2;

// radio.liq's `segment_duration=4.` — fixed, like the ladder, so there is no
// setting to read. Keep in sync.
export const HLS_SEGMENT_SECONDS = 4;

// How long after their last playlist fetch a client still counts.
//
// A playing client reloads the media playlist about once per segment duration,
// so the window is a MULTIPLE of it, never a flat number: at 4s segments a
// 30s window would hold a listener who left half a minute ago, and at 10s a
// flat 12s would evict one who is still there. x3 is the slack for a client
// that just filled its buffer and polls late — one missed poll must not evict
// a listener, two in a row should.
export const HLS_WINDOW_FACTOR = 3;
const HLS_WINDOW_MIN_MS = 12_000;
const HLS_WINDOW_MAX_MS = 45_000;

export function hlsWindowMs(segmentSeconds: unknown): number {
  const s = Number(segmentSeconds);
  const derived = Number.isFinite(s) && s > 0 ? s * HLS_WINDOW_FACTOR * 1000 : HLS_WINDOW_MIN_MS;
  return Math.min(HLS_WINDOW_MAX_MS, Math.max(HLS_WINDOW_MIN_MS, derived));
}

// Read cadence. Bounds how long a NEW listener stays invisible; leaving is
// bounded by the window instead, because rows are filtered at read time.
const REFRESH_MS = 5_000;
// Past this, the last reading is not a count any more but a memory — the loop
// died or a read is wedged. Reported as UNKNOWN (null), never as a frozen
// number and never as 0: 0 is a measurement, and this isn't one.
const STALE_MS = REFRESH_MS * 4;

// Backwards read budget. One chunk covers minutes of a normal audience; the
// cap only exists so a pathological log can't turn a 5s tick into a long read.
const CHUNK_BYTES = 64 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;

// The MASTER playlist, per radio.liq's `playlist="live.m3u8"`. Deliberately not
// counted: it is fetched once at tune-in and never again, so counting it would
// put every link preview and every curl on the books for a whole window, while
// a real listener is already polling a rung by then. Keep in sync with radio.liq.
const MASTER_PLAYLIST = 'live';

export interface HlsHit {
  atMs: number;
  ip: string;
  userAgent: string;
  /** Playlist basename without the extension — the ladder rung this client settled on. */
  rung: string;
  /** Opaque per-session id from `?s=`, when the client sets one. */
  session: string | null;
}

// The fields of one Caddy JSON access-log row this module reads. Everything is
// optional because it is parsed out of a file, not received from a contract.
interface CaddyAccessRow {
  ts?: unknown;
  status?: unknown;
  request?: {
    uri?: unknown;
    client_ip?: unknown;
    remote_ip?: unknown;
    headers?: Record<string, unknown>;
  };
}

// Timestamp only, for the backwards scan's "have we reached far enough back"
// probe — cheaper than building a hit for a row we are about to discard.
export function rowTimestampMs(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const ts = Number((JSON.parse(trimmed) as CaddyAccessRow | null)?.ts);
    return Number.isFinite(ts) ? Math.round(ts * 1000) : null;
  } catch {
    return null;
  }
}

// One Caddy JSON access row → one playlist fetch, or null for anything that is
// not one. Defensive throughout: this parses a log, and a half-written last
// line is normal, not an error.
export function parseHlsLogLine(line: string): HlsHit | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let row: CaddyAccessRow | null;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return null; // a torn final line, or a rolled file's first fragment
  }
  const ts = Number(row?.ts);
  if (!Number.isFinite(ts)) return null;
  // A 404 is a client asking for a rung that isn't there — a request, not a
  // listener. 200 and 206 delivered the playlist; 304 is a client revalidating
  // an unchanged one (the edge sends no-cache, which invites exactly that), and
  // it is still a client polling.
  const status = Number(row?.status);
  if (status !== 200 && status !== 206 && status !== 304) return null;

  const rawUri = String(row?.request?.uri || '');
  if (!rawUri) return null;
  const [path, query = ''] = rawUri.split('?', 2);
  if (!path.endsWith('.m3u8')) return null;
  const rung = path.slice(path.lastIndexOf('/') + 1, -'.m3u8'.length);
  if (!rung || rung === MASTER_PLAYLIST) return null;

  // client_ip is what Caddy resolved (X-Forwarded-For when a trusted proxy is
  // configured, the socket address otherwise); remote_ip is the fallback.
  const ip = String(row?.request?.client_ip || row?.request?.remote_ip || '');
  const uaHeader = row?.request?.headers?.['User-Agent'];
  const userAgent = String((Array.isArray(uaHeader) ? uaHeader[0] : uaHeader) || '');

  return { atMs: Math.round(ts * 1000), ip, userAgent, rung, session: sessionParam(query) };
}

// `?s=<id>` — an opaque session id a client may set to be counted as itself.
// Length-capped so a junk query string can't become a distinct listener per
// request. Nothing we ship sets it yet; it exists because it is the only way
// off the ip+ua key below for clients we do control.
function sessionParam(query: string): string | null {
  if (!query) return null;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== 's') continue;
    // The log is public input: a malformed escape must read as "no session id",
    // never throw out of the read loop and freeze the count.
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1)).trim().slice(0, 64);
    } catch {
      return null;
    }
    if (value) return value;
  }
  return null;
}

// What makes two fetches the same listener.
//
// The Icecast count deliberately never keys on IP — every socket is a listener
// there, so it doesn't have to. HLS has no socket: a session id if the client
// offers one, otherwise ip+ua is all a request carries. The cost is honest and
// bounded: two clients on one NAT with the identical user-agent read as one
// listener, which UNDERSTATES the audience and can never invent one.
export function hlsListenerKey(hit: HlsHit): string {
  return hit.session ? `s:${hit.session}` : `a:${hit.ip}|${hit.userAgent}`;
}

export interface HlsListenerRow {
  key: string;
  ip: string;
  userAgent: string;
  rung: string;
  firstHitMs: number;
  lastSeenMs: number;
  hits: number;
}

// Hits (any order) → one row per distinct listener inside the window. The
// newest hit wins for the rung, so the row shows where a client that stepped
// down the ladder is NOW.
export function foldHits(hits: HlsHit[], cutoffMs: number): HlsListenerRow[] {
  const rows = new Map<string, HlsListenerRow>();
  for (const hit of hits) {
    if (hit.atMs < cutoffMs) continue;
    const key = hlsListenerKey(hit);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        key,
        ip: hit.ip,
        userAgent: hit.userAgent,
        rung: hit.rung,
        firstHitMs: hit.atMs,
        lastSeenMs: hit.atMs,
        hits: 1,
      });
      continue;
    }
    row.hits += 1;
    row.firstHitMs = Math.min(row.firstHitMs, hit.atMs);
    if (hit.atMs >= row.lastSeenMs) {
      row.lastSeenMs = hit.atMs;
      row.rung = hit.rung;
    }
  }
  return [...rows.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}

interface ScanResult {
  /** Complete lines held, oldest first. */
  lines: string[];
  /** True when a row older than the cutoff was seen — this file covers the whole window. */
  covered: boolean;
  bytesRead: number;
}

// The oldest COMPLETE line inside one chunk, for the reach-back probe. Above
// the file start the leading fragment belongs to a line whose head is still
// unread, so it is skipped.
function oldestCompleteLine(buf: Buffer, atFileStart: boolean): string | null {
  const firstNl = buf.indexOf(0x0a);
  if (!atFileStart && firstNl < 0) return null;
  const start = atFileStart ? 0 : firstNl + 1;
  const end = buf.indexOf(0x0a, start);
  const slice = end < 0 ? buf.subarray(start) : buf.subarray(start, end);
  const line = slice.toString('utf8').trim();
  return line || null;
}

// Reads a log file backwards in chunks until it reaches past the cutoff, the
// file start, or the budget. Chunks are kept as BUFFERS and decoded once at the
// end — decoding each chunk on its own splits multi-byte characters at the
// boundary and corrupts the line that straddles it.
async function scanBackwards(path: string, cutoffMs: number, budgetBytes: number): Promise<ScanResult> {
  const fh = await open(path, 'r');
  try {
    let pos = (await fh.stat()).size;
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let covered = false;
    while (pos > 0 && bytesRead < budgetBytes) {
      const len = Math.min(CHUNK_BYTES, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      bytesRead += len;
      chunks.unshift(buf);
      const probe = oldestCompleteLine(buf, pos === 0);
      const at = probe ? rowTimestampMs(probe) : null;
      if (at !== null && at < cutoffMs) {
        covered = true;
        break;
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let usable = text;
    if (pos > 0) {
      const firstNl = text.indexOf('\n');
      usable = firstNl < 0 ? '' : text.slice(firstNl + 1);
    }
    return { lines: usable.split('\n').filter(l => l.length > 0), covered, bytesRead };
  } finally {
    await fh.close();
  }
}

// Rolled siblings, newest first. Caddy's backup time format sorts
// lexicographically, so the name is the ordering.
async function rolledLogFiles(): Promise<string[]> {
  try {
    const names = await readdir(LOG_DIR);
    return names
      .filter(n => n.startsWith(ROLLED_PREFIX) && n.endsWith(ROLLED_SUFFIX))
      .sort()
      .reverse()
      .slice(0, ROLLED_LOOKBACK)
      .map(n => join(LOG_DIR, n));
  } catch {
    return [];
  }
}

// Every playlist fetch inside the window, or null when there is no log to read
// at all — an image whose edge predates the hls_access logger must read as
// UNKNOWN, so the Icecast leg alone decides, exactly as before.
async function collectHits(cutoffMs: number): Promise<HlsHit[] | null> {
  const hits: HlsHit[] = [];
  let budget = MAX_READ_BYTES;
  let sawLog = false;
  for (const file of [LOG_PATH, ...(await rolledLogFiles())]) {
    let scan: ScanResult;
    try {
      scan = await scanBackwards(file, cutoffMs, budget);
    } catch {
      continue; // absent, or rolled away between readdir and open
    }
    sawLog = true;
    for (const line of scan.lines) {
      const hit = parseHlsLogLine(line);
      if (hit && hit.atMs >= cutoffMs) hits.push(hit);
    }
    budget -= scan.bytesRead;
    // Only walk into a rolled file when the current one did not reach back far
    // enough — which is exactly the moment a roll would otherwise zero the count.
    if (scan.covered || budget <= 0) break;
  }
  return sawLog ? hits : null;
}

interface HlsReading {
  atMs: number;
  rows: HlsListenerRow[];
}

let reading: HlsReading | null = null;
// key → first hit of the client's CURRENT unbroken run of polls. There is no
// connection to age here, so this is measured from first sighting: it resets
// when a client drops out of the window, and on a controller restart.
const firstSeen = new Map<string, number>();
let inFlight: Promise<number | null> | null = null;

function hlsTransportEnabled(): boolean {
  return hlsActive(settings.get());
}

function currentWindowMs(): number {
  return hlsWindowMs(HLS_SEGMENT_SECONDS);
}

function noteFirstSeen(rows: HlsListenerRow[]) {
  const live = new Set(rows.map(r => r.key));
  for (const key of [...firstSeen.keys()]) if (!live.has(key)) firstSeen.delete(key);
  for (const row of rows) {
    const known = firstSeen.get(row.key);
    firstSeen.set(row.key, known === undefined ? row.firstHitMs : Math.min(known, row.firstHitMs));
  }
}

async function readNow(): Promise<number | null> {
  const nowMs = Date.now();
  // HLS switched off IS a measurement, not an unknown: nobody can be listening
  // through a transport that isn't running. (listeners.ts goes further and
  // drops the leg entirely while HLS is off — see its hlsLeg() — so this 0 is
  // what the debug and Doctor surfaces show, never folded into the count.)
  if (!hlsTransportEnabled()) {
    reading = { atMs: nowMs, rows: [] };
    firstSeen.clear();
    return 0;
  }
  const cutoff = nowMs - currentWindowMs();
  let hits: HlsHit[] | null;
  try {
    hits = await collectHits(cutoff);
  } catch {
    return hlsListenerCount(); // hold the last reading; STALE_MS decides when it stops counting
  }
  if (hits === null) return hlsListenerCount();
  const rows = foldHits(hits, cutoff);
  noteFirstSeen(rows);
  reading = { atMs: nowMs, rows };
  return rows.length;
}

// Coalesces overlapping ticks: a slow read must not commit after a younger one.
export function refreshHlsListeners(): Promise<number | null> {
  inFlight ??= readNow().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// Rows still inside the window RIGHT NOW. Filtered here rather than at read
// time so a listener drops out the moment their window closes, instead of
// lingering until the next tick.
function liveRows(nowMs = Date.now()): HlsListenerRow[] | null {
  if (!reading) return null;
  if (nowMs - reading.atMs > STALE_MS) return null;
  const cutoff = nowMs - currentWindowMs();
  return reading.rows.filter(r => r.lastSeenMs >= cutoff);
}

// The HLS leg of the listener count. A number is a measurement, including 0
// (nobody polling, or the transport is switched off); null means UNKNOWN — no
// access log to read, or the reading went stale — and the callers in
// listeners.ts treat that differently depending on which way their gate fails.
export function hlsListenerCount(): number | null {
  const rows = liveRows();
  return rows === null ? null : rows.length;
}

// One row per HLS listener for the admin table, shaped like an Icecast
// connection. `connectedSeconds` is measured from the first playlist fetch of
// the current run (see firstSeen) — real, but not comparable to an Icecast
// socket's age across a controller restart.
export function hlsConnections(nowMs = Date.now()): ListenerConnection[] {
  const rows = liveRows(nowMs);
  if (!rows) return [];
  return rows.map(r => ({
    ip: r.ip,
    mount: `/hls/${r.rung}`,
    userAgent: r.userAgent,
    connectedSeconds: Math.max(0, Math.round((nowMs - (firstSeen.get(r.key) ?? r.firstHitMs)) / 1000)),
    connections: 1,
  }));
}

// How long ago the mixer last wrote an HLS playlist, in seconds, or null when
// there is no HLS directory to read (switched off, or never written).
//
// Read off the VARIANT playlists, NEVER `live.m3u8`: Liquidsoap writes the
// master once at startup and never touches it again — it only lists the rungs,
// which never change — so its mtime is the mixer's start time, and a perfectly
// healthy stream would look dead within seconds of booting. The variants are
// rewritten once per segment, which is the actual heartbeat.
export async function hlsPlaylistAgeSec(nowMs = Date.now()): Promise<number | null> {
  const newest = await newestVariantMtimeMs(HLS_DIR).catch(() => 0);
  if (newest <= 0) return null;
  return Math.max(0, Math.round((nowMs - newest) / 1000));
}

// The HLS mount's state for an operator surface: switched on (and not held back
// by the stream password — see hls-policy.ts), writing segments (a variant
// playlist rewritten within three segments), and the counted audience. One
// definition, read by /debug and Doctor. A null count is "not counted", never 0.
export async function hlsStatus(): Promise<{
  enabled: boolean;
  live: boolean;
  listeners: number | null;
  ageSec: number | null;
}> {
  const enabled = hlsActive(settings.get());
  const ageSec = enabled ? await hlsPlaylistAgeSec() : null;
  return {
    enabled,
    live: enabled && ageSec !== null && ageSec <= HLS_SEGMENT_SECONDS * 3,
    listeners: hlsListenerCount(),
    ageSec,
  };
}

// Throws when the directory cannot be read, so the caller can fall through to
// the other one; a directory with no variant playlists yet returns 0.
async function newestVariantMtimeMs(dir: string): Promise<number> {
  const variants = (await readdir(dir)).filter(
    n => n.endsWith('.m3u8') && n !== `${MASTER_PLAYLIST}.m3u8`,
  );
  const times = await Promise.all(
    variants.map(n => stat(join(dir, n)).then(s => s.mtimeMs, () => 0)),
  );
  return Math.max(0, ...times);
}

// Starts the read loop. Resolves once the first reading has landed, so boot can
// take a count before anything gates on one.
export function startHlsListenerMonitor(): Promise<void> {
  const first = refreshHlsListeners().then(
    () => {},
    () => {},
  );
  setInterval(() => {
    void refreshHlsListeners();
  }, REFRESH_MS);
  return first;
}
