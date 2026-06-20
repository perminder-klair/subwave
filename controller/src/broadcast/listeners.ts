// Icecast listener-count monitor.
//
// Polls Icecast on an interval and caches the live listener count across both
// broadcast mounts (/stream.mp3 + /stream.opus), so the DJ gates can ask "is
// anyone listening?" without each one hitting Icecast.
//
// The count *folds Safari's double connection* into one (see groupConnections /
// dedupeListeners): iOS/macOS Safari opens two identical sockets per client, so
// a raw sum double-counts every Apple listener. We can't key on IP — behind a
// reverse proxy (Caddy → Icecast) every connection carries the proxy's IP, not
// the listener's, and icecast-KH ignores X-Forwarded-For, so the real client IP
// never reaches Icecast. Instead we count every non-Safari socket as a listener
// and pair Safari's two near-simultaneous sockets by user-agent + connect-time.
// That dedup needs the per-connection admin feed (/admin/listclients); the
// public status-json.xsl still supplies online/bitrate and the fallback sum
// when the admin endpoint is unavailable.
//
// Fail-open: if Icecast is unreachable the count is null and djCallsAllowed()
// treats the station as occupied — a stats outage must never silence the DJ.

import { appendFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';

let lastCount: number | null = null;        // null = unknown (not yet polled, or Icecast down)
let peakSeen = 0;                            // running max of the deduped count this process run
let consecutiveStatusFailures = 0;          // resets to 0 on every successful poll

// Full cached stream status, refreshed by the same poll that maintains
// lastCount. `online` is true when at least one broadcast mount has a source
// attached; `peak` sums listener_peak across both mounts. Read by the public
// /now-playing route, which every listener polls every 5s — serving the
// cached value means N listeners cost one Icecast status fetch per 15s
// instead of one per request (and a wedged Icecast can no longer stall the
// route for its 1.5s timeout on every poll).
export interface StreamStatus {
  online: boolean;
  listeners: { current: number; peak: number };
  /** Bitrate (kbps) of the first attached broadcast mount, null when offline. */
  bitrate: number | null;
}
let lastStatus: StreamStatus = { online: false, listeners: { current: 0, peak: 0 }, bitrate: null };

// How many *consecutive* failed status polls before we stop trusting the last
// known `online` and report the broadcast as offline. Below this we hold the
// last good status so a transient stats-endpoint timeout never tears down a
// healthy listener (issue #461); at or above it a genuinely unreachable Icecast
// still surfaces as offline instead of being pinned "online" forever. 4 polls
// × 15s ≈ 1 min of sustained failure.
const STALE_STATUS_LIMIT = 4;

// Next cached status after a status-fetch failure. Pure (no I/O) so the
// transient-vs-sustained branching is unit-tested in isolation
// (scripts/listeners-status.test.ts).
//   • transient (failures < limit): hold the last known status — the count is
//     stale-but-best-known, not a freshly-observed 0. Keeps a healthy player
//     alive through a momentary stats blip.
//   • sustained (failures ≥ limit): the broadcast really looks gone — report
//     offline, zero the current count, drop bitrate; keep the run's peak.
export function statusAfterFailure(
  prev: StreamStatus,
  consecutiveFailures: number,
  limit: number,
  peak: number,
): StreamStatus {
  if (consecutiveFailures >= limit) {
    return { online: false, listeners: { current: 0, peak }, bitrate: null };
  }
  return { ...prev, listeners: { ...prev.listeners, peak } };
}

// Time-series file. JSONL of {t, count} rows, one per persisted sample.
// We persist every minute (not every 15s poll) — keeps the file at ~1440
// rows/day, easily tail-readable, and that resolution is plenty for the
// "is anyone here?" sparkline this is for.
const HISTORY_FILE = join(config.stateDir, 'listeners.jsonl');
let lastPersistedMinute = -1;

async function fetchCount() {
  let online = false;
  let bitrate: number | null = null;
  let rawCount = 0; // un-deduped status sum — the fallback when admin is unreachable
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(config.icecast.statusUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    const ic = ((await r.json()) as any)?.icestats;
    const sources = Array.isArray(ic?.source) ? ic.source : ic?.source ? [ic.source] : [];
    // Only our two broadcast mounts count. Anything else (e.g. an /admin
    // source) is ignored so stray test mounts don't inflate the numbers.
    const broadcastSources = sources.filter((s: any) =>
      BROADCAST_MOUNTS.some(m => String(s?.listenurl || '').includes(m))
    );
    online = broadcastSources.length > 0;
    rawCount = broadcastSources.reduce(
      (sum: number, s: any) => sum + Number(s.listeners || 0), 0);
    // Bitrate from the first attached mount — both share the same `radio` bus,
    // so one figure represents the broadcast. Comes free off this same poll.
    const firstBitrate = Number(broadcastSources[0]?.bitrate);
    bitrate = Number.isFinite(firstBitrate) ? firstBitrate : null;

    // Dedupe by IP+UA off the admin per-connection feed (Safari double-counts —
    // see dedupeListeners). Only worth a call when someone's actually attached;
    // on any admin failure fall back to the raw status sum rather than dropping
    // the count, so a missing admin password just degrades to the old numbers.
    let current = rawCount;
    if (online && rawCount > 0) {
      try {
        current = dedupeListeners(await getConnections());
      } catch {
        /* admin unreachable / no password — keep the raw status sum */
      }
    }

    lastCount = current;
    peakSeen = Math.max(peakSeen, current);
    lastStatus = { online, listeners: { current, peak: peakSeen }, bitrate };
    consecutiveStatusFailures = 0;
  } catch {
    lastCount = null;
    // Treat a transient Icecast status fetch failure as "unknown", not as proof
    // the broadcast went offline: hold the last known status so the listener UI
    // doesn't tear down a healthy audio element over a momentary stats timeout
    // (issue #461). Only once failures persist (STALE_STATUS_LIMIT) do we report
    // offline — a genuinely unreachable Icecast must still surface eventually.
    consecutiveStatusFailures += 1;
    lastStatus = statusAfterFailure(lastStatus, consecutiveStatusFailures, STALE_STATUS_LIMIT, peakSeen);
  }
  // Persist at most one row per wall-clock minute. Skip null samples — a
  // stats outage shouldn't leave a misleading "0 listeners" stripe in the
  // graph; the gap itself communicates the outage.
  if (lastCount !== null) {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60000);
    if (minute !== lastPersistedMinute) {
      lastPersistedMinute = minute;
      const line = JSON.stringify({ t: now.toISOString(), count: lastCount }) + '\n';
      appendFile(HISTORY_FILE, line).catch(() => {});  // best-effort
    }
  }
  return lastCount;
}

// Last known listener count — a number, or null when it couldn't be read.
export function getListenerCount() {
  return lastCount;
}

// Last known stream status, from the same 15s poll. Returns offline + 0/0
// until the first successful poll — same shape /now-playing always exposed.
export function getStreamStatus(): StreamStatus {
  return lastStatus;
}

// Force an immediate poll. Used by the request route so a listener who just
// connected isn't rejected on a stale cached value.
export async function refresh() {
  return fetchCount();
}

// True when autonomous DJ LLM work is allowed right now. When the pause toggle
// is off, always true. When on, allowed only if at least one listener is
// counted — an unknown count (Icecast unreachable) is treated as occupied so a
// stats outage can never take the DJ off the air.
export function djCallsAllowed() {
  if (!settings.get()?.llm?.pauseWhenEmpty) return true;
  if (lastCount === null) return true;
  return lastCount > 0;
}

export function startListenerMonitor() {
  fetchCount();
  setInterval(fetchCount, 15000);
}

// Read the recent listener history for the admin sparkline. Returns rows
// newer than `since` (defaults to 24 h ago), oldest-first.
//
// JSONL is read whole and filtered in-memory — fine because the file caps
// at ~1440 lines/day. If retention ever grows past a few MB, swap to a
// streaming tail; until then, the simple read is enough.
export interface ListenerSample {
  t: string;
  count: number;
}

export async function history({
  since,
}: { since?: Date } = {}): Promise<ListenerSample[]> {
  if (!existsSync(HISTORY_FILE)) return [];
  let raw = '';
  try {
    raw = await readFile(HISTORY_FILE, 'utf8');
  } catch {
    return [];
  }
  const cutoffMs = (since || new Date(Date.now() - 24 * 60 * 60 * 1000)).getTime();
  const out: ListenerSample[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const tMs = new Date(row.t).getTime();
      if (!Number.isFinite(tMs) || tMs < cutoffMs) continue;
      if (typeof row.count !== 'number') continue;
      out.push({ t: row.t, count: row.count });
    } catch {}
  }
  return out;
}

// Size of the persisted history file, for the admin debug view. Useful to
// notice if the operator left the station running for a year and the file
// grew unexpectedly.
export async function historyBytes(): Promise<number> {
  try {
    const st = await stat(HISTORY_FILE);
    return st.size;
  } catch {
    return 0;
  }
}

// ── Per-listener connections (admin only) ──────────────────────────────────
// The aggregate count above comes from Icecast's public status JSON. The
// per-connection breakdown (IP, user-agent, how long they've been connected)
// lives behind Icecast's admin interface (/admin/listclients), which is
// Basic-auth gated — so this path needs the admin password, unlike the count.

export interface ListenerConnection {
  ip: string;
  mount: string;
  userAgent: string;
  connectedSeconds: number;
  /** Raw sockets folded into this row by groupConnections (Safari opens 2). */
  connections?: number;
}

const BROADCAST_MOUNTS = ['/stream.mp3', '/stream.opus'];
let cachedAdminPassword: string | null = null;

// Resolve the Icecast admin password: explicit env wins, otherwise read the
// shared icecast-secrets.env that the broadcast container writes on boot (both
// containers mount /var/sub-wave, so no cross-container handshake is needed).
async function resolveAdminPassword(): Promise<string | null> {
  if (process.env.ICECAST_ADMIN_PASSWORD) return process.env.ICECAST_ADMIN_PASSWORD;
  if (cachedAdminPassword) return cachedAdminPassword;
  try {
    const raw = await readFile(join(config.stateDir, 'icecast-secrets.env'), 'utf8');
    const m = raw.match(/^ICECAST_ADMIN_PASSWORD=(.*)$/m);
    if (m) {
      cachedAdminPassword = m[1].trim().replace(/^["']|["']$/g, '');
      return cachedAdminPassword;
    }
  } catch {
    /* file absent until broadcast boots — caller surfaces the null */
  }
  return null;
}

// Decode the XML entities Icecast escapes in text fields. User-agents routinely
// contain & and occasionally <>. &amp; is undone last so "&amp;lt;" survives.
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function tagText(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : '';
}

// listclients XML is flat and machine-generated — one <listener> block per
// client — so a scan over those blocks is enough; no XML dependency pulled in.
// The opening tag carries an id attribute (`<listener id="33">`), so the match
// allows attributes rather than a bare tag.
function parseListClients(xml: string, mount: string): ListenerConnection[] {
  const out: ListenerConnection[] = [];
  const re = /<listener\b[^>]*>([\s\S]*?)<\/listener>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    out.push({
      ip: tagText(block, 'IP'),
      mount,
      userAgent: tagText(block, 'UserAgent'),
      connectedSeconds: Number(tagText(block, 'Connected')) || 0,
    });
  }
  return out;
}

// Max gap (seconds) between Safari's two sockets' Connected times for them to be
// treated as the same listener's double. They open within the same second and
// stay within ~1s of each other for the connection's life; 6s absorbs poll
// jitter without bridging two genuinely separate joins.
const DOUBLE_WINDOW_S = 6;

// True when the user-agent is real Safari / AppleCoreMedia — the only clients
// that open *two* identical sockets per listener (a fundamental AppleCoreMedia
// behaviour, no client-side fix — see react-native-track-player #2096).
// Chrome-on-Mac also carries the "Safari/537.36" token but is Blink and opens a
// single socket, so it must NOT match: gate on "Version/" + "Safari" and exclude
// the Chromium-family tokens.
function isSafariDouble(ua: string): boolean {
  if (/AppleCoreMedia/i.test(ua)) return true;
  if (!/Safari/i.test(ua) || !/Version\//i.test(ua)) return false;
  return !/(Chrome|CriOS|Chromium|Android|Edg|OPR)/i.test(ua);
}

// Number of distinct listeners — the headline count. Folds Safari's double
// back into one (see groupConnections) without keying on IP, which is useless
// behind a reverse proxy (every socket carries the proxy's IP). Single source of
// truth with the admin table: both derive from groupConnections so they can't
// drift apart.
export function dedupeListeners(conns: ListenerConnection[]): number {
  return groupConnections(conns).length;
}

// One row per distinct listener — for the admin connections table and the
// headline count. Every non-Safari socket is its own listener (Chrome, Firefox,
// Android, Sonos and hardware radios open exactly one socket each, so two
// distinct listeners sharing the proxy IP — and even the same UA — both
// count). Safari's two near-simultaneous sockets are paired into one row by
// user-agent + connect-time. `connections` records how many raw sockets folded
// in (Safari → 2); connectedSeconds is the longest-held of the group and mount
// lists every mount the listener holds.
export function groupConnections(conns: ListenerConnection[]): ListenerConnection[] {
  const singles: ListenerConnection[] = [];
  const safari: ListenerConnection[] = [];
  for (const c of conns) (isSafariDouble(c.userAgent) ? safari : singles).push(c);

  const out: ListenerConnection[] = singles.map(c => ({ ...c, connections: 1 }));

  // Pair Safari sockets per mount: sort by Connected, greedily merge an adjacent
  // socket within the window. Each real Apple listener is exactly two sockets, so
  // for any even count this yields N/2 listeners regardless of pairing order; an
  // odd leftover stands alone. Cap each group at 2 — Safari only ever doubles.
  const byMount = new Map<string, ListenerConnection[]>();
  for (const c of safari) {
    const arr = byMount.get(c.mount) ?? [];
    arr.push(c);
    byMount.set(c.mount, arr);
  }
  for (const arr of byMount.values()) {
    arr.sort((a, b) => b.connectedSeconds - a.connectedSeconds);
    for (let i = 0; i < arr.length; i++) {
      const cur = arr[i];
      const next = arr[i + 1];
      if (next && cur.connectedSeconds - next.connectedSeconds <= DOUBLE_WINDOW_S) {
        out.push({ ...cur, connections: 2 });
        i++; // consume the paired socket
      } else {
        out.push({ ...cur, connections: 1 });
      }
    }
  }
  return out;
}

// Live per-listener connections across both broadcast mounts. Returns [] when
// nobody's connected; throws only on auth/transport failure so the admin route
// can show the operator why the table is empty.
export async function getConnections(): Promise<ListenerConnection[]> {
  const password = await resolveAdminPassword();
  if (!password) throw new Error('Icecast admin password unavailable');
  const auth =
    'Basic ' + Buffer.from(`${config.icecast.adminUser}:${password}`).toString('base64');

  const rows: ListenerConnection[] = [];
  for (const mount of BROADCAST_MOUNTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    let r: Response;
    try {
      r = await fetch(`${config.icecast.adminUrl}?mount=${encodeURIComponent(mount)}`, {
        headers: { Authorization: auth },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    // A wrong password fails the same way on every mount — surface it.
    if (r.status === 401) {
      cachedAdminPassword = null; // re-read the file next time in case it rotated
      throw new Error('Icecast admin auth rejected');
    }
    // A disabled mount (e.g. Opus off by default) returns 400 — just skip it.
    if (!r.ok) continue;
    rows.push(...parseListClients(await r.text(), mount));
  }
  return rows;
}
