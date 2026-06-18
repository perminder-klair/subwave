// Icecast listener-count monitor.
//
// Polls Icecast on an interval and caches the live listener count across both
// broadcast mounts (/stream.mp3 + /stream.opus), so the DJ gates can ask "is
// anyone listening?" without each one hitting Icecast.
//
// The count is *deduped by IP+user-agent* (see dedupeListeners): Safari opens
// two identical connections per client, so a raw sum double-counts every Apple
// listener. That dedup needs the per-connection admin feed (/admin/listclients);
// the public status-json.xsl still supplies online/bitrate and the fallback sum
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
  } catch {
    lastCount = null;
    lastStatus = { online: false, listeners: { current: 0, peak: 0 }, bitrate: null };
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

// Collapse Safari/AppleCoreMedia's duplicate connections into one listener.
// iOS and macOS Safari open *two* identical sockets to a live Icecast mount per
// client (a fundamental AppleCoreMedia behaviour, confirmed upstream with no
// client-side fix — see react-native-track-player #2096), which Icecast counts
// as two listeners. Counting distinct IP+user-agent pairs folds those back into
// one. Two genuinely-distinct devices sharing both a public IP *and* an
// identical UA collapse too — rare, and a better failure mode than every Apple
// visitor doubling the tally.
export function dedupeListeners(conns: ListenerConnection[]): number {
  const seen = new Set<string>();
  for (const c of conns) seen.add(`${c.ip} ${c.userAgent}`);
  return seen.size;
}

// One row per distinct listener (IP+UA), matching the deduped count — for the
// admin connections table, so Safari's duplicate socket shows as a single
// listener rather than two rows. `connections` records how many raw sockets
// folded in (Safari → 2); connectedSeconds is the longest-held of the group and
// mount lists every mount the listener holds.
export function groupConnections(conns: ListenerConnection[]): ListenerConnection[] {
  const groups = new Map<string, ListenerConnection>();
  for (const c of conns) {
    const key = `${c.ip} ${c.userAgent}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { ...c, connections: 1 });
    } else {
      g.connections = (g.connections ?? 1) + 1;
      g.connectedSeconds = Math.max(g.connectedSeconds, c.connectedSeconds);
      if (!g.mount.split(', ').includes(c.mount)) g.mount = `${g.mount}, ${c.mount}`;
    }
  }
  return [...groups.values()];
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
