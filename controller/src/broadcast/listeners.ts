// The station's listener count, and the gates that read it.
//
// TWO LEGS, one number. This file owns the ICECAST leg: it polls the broadcast
// mounts on an interval and caches the count so the DJ gates don't each hit
// Icecast. The HLS leg — listeners who hold no socket at all — is counted from
// the edge's playlist access log by broadcast/hls-listeners.ts and added here,
// in combineCounts() and combineGatedCounts(): the same two legs, two opposite
// failure directions, and the only two places they meet. An HLS-only audience
// used to read as an empty room, which silently disabled Last.fm.
//
// The Icecast count never keys on IP (a proxy collapses everyone onto one
// address, a NAT hides several listeners behind one). Every non-Safari socket is
// a listener; Safari/AppleCoreMedia opens two sockets per client and they are
// paired by user-agent + connect time off the admin feed (/admin/listclients).
// The public status-json.xsl supplies online/bitrate and the fallback sum when
// admin is unavailable. The HLS leg has no socket to count and keys differently
// — see hls-listeners.ts, which is where that trade-off is argued.
//
// Fail-open: an unreachable Icecast reads null and djCallsAllowed() treats the
// station as occupied, so a stats outage never silences the DJ.

import { appendFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { hlsListenerCount, refreshHlsListeners, startHlsListenerMonitor } from './hls-listeners.js';
import { hlsActive } from './hls-policy.js';

let icecastCount: number | null = null;        // null = unknown (not yet polled, or this poll failed)
let lastGoodIcecast: number | null = null;    // last count actually read from Icecast; null until the first success
let peakSeen = 0;                            // running max of the deduped count this process run
let consecutiveStatusFailures = 0;          // resets to 0 on every successful poll

// What one Icecast poll observed, cached so N listeners polling /now-playing
// every 5s cost one status fetch per 15s rather than one per request. Cached
// as-is: the HLS leg is added on the way out in getStreamStatus(), never folded
// in here, or statusAfterFailure would zero a count it never measured.
export interface IcecastStatus {
  online: boolean;
  listeners: { current: number; peak: number };
  /** Bitrate (kbps) of the primary (mp3) broadcast mount, null when offline. */
  bitrate: number | null;
  /** Sample rate (Hz) of the primary mount, null when offline/unknown. */
  sampleRate: number | null;
  /** Channel count of the primary mount, null when offline/unknown. */
  channels: number | null;
}

// What callers get. `listeners.current` is BOTH legs — that is what "how many
// people are listening" means, and every gate reads it. The split rides
// alongside it for the admin, never instead of it: `icecast` is sockets, `hls`
// is playlist polls, null only when that leg cannot be read at all (no access
// log — an edge that isn't writing one, which Doctor calls out).
export interface StreamStatus extends Omit<IcecastStatus, 'listeners'> {
  listeners: { current: number; peak: number; icecast: number; hls: number | null };
}

let lastStatus: IcecastStatus = {
  online: false,
  listeners: { current: 0, peak: 0 },
  bitrate: null,
  sampleRate: null,
  channels: null,
};

// Consecutive failed status polls before the last reading stops being trusted
// (both cached `online` and the gated count). Under the limit we hold the last
// known values so a transient stats timeout doesn't tear down a healthy
// listener (#461) or release the idle pause (#1256); at or above it a genuinely
// unreachable Icecast surfaces as offline/unknown. 4 polls ≈ 1 min at the 15s
// cadence, ≈20s while the idle monitor forces 5s polls.
const STALE_STATUS_LIMIT = 4;

// Deadline on the Icecast status fetch. Must stay inside the idle monitor's 5s
// tick so the ~20s fail-open budget while paused is unchanged.
const STATUS_TIMEOUT_MS = 3000;

// Next cached status after a status-fetch failure. Transient (< limit): hold
// the last known status, since a failed fetch is not a freshly-observed 0.
// Sustained (≥ limit): report offline, zero the count, drop bitrate, keep peak.
export function statusAfterFailure(
  prev: IcecastStatus,
  consecutiveFailures: number,
  limit: number,
  peak: number,
): IcecastStatus {
  if (consecutiveFailures >= limit) {
    return { online: false, listeners: { current: 0, peak }, bitrate: null, sampleRate: null, channels: null };
  }
  return { ...prev, listeners: { ...prev.listeners, peak } };
}

// The count the fail-open gates act on. Same transient-vs-sustained split as
// statusAfterFailure: a successful poll wins, a transient failure holds the last
// real reading, a sustained failure (or never polled) reads null.
export function gatedCount(
  raw: number | null,
  lastGood: number | null,
  consecutiveFailures: number,
  limit: number,
): number | null {
  if (raw !== null) return raw;
  if (consecutiveFailures >= limit) return null;
  return lastGood;
}

// The HLS leg as the combiners see it. `undefined` means THERE IS NO SECOND
// LEG — HLS is off (or held back by the stream password) — and then every
// figure below is exactly the Icecast leg, null included. That is what keeps a
// station that never turned HLS on byte-identical: folding a switched-off
// transport in as a measured 0 would turn one failed Icecast poll into a
// fabricated "0 listeners" on the sparkline instead of a gap.
function hlsLeg(): number | null | undefined {
  return hlsActive(settings.get()) ? hlsListenerCount() : undefined;
}

// The two legs into one count, for the fail-CLOSED presence check and for every
// surface that displays a number. `null` from a leg means UNKNOWN: it
// contributes nothing and the other leg stands alone, since an HLS-only
// audience is an audience and so is an mp3-only one. Two unknowns stay unknown
// rather than becoming 0 — nothing was measured, and a fabricated 0 would reach
// the sparkline and /now-playing as a fact. A leg reading 0 IS a measurement
// and counts as one. An absent HLS leg (`undefined`, see hlsLeg) leaves the
// Icecast figure exactly as it was.
export function combineCounts(icecast: number | null, hls: number | null | undefined): number | null {
  if (hls === undefined) return icecast;
  if (icecast === null && hls === null) return null;
  return (icecast ?? 0) + (hls ?? 0);
}

// The FAIL-OPEN counterpart, for the gates that treat unknown as "carry on".
// Here a single unreadable leg makes the whole figure unknown, because the
// listeners it would have counted are exactly the ones nobody can see — folding
// it to 0 would report an empty room the station never measured and silence the
// DJ on a stats outage. The two must NOT be unified: combineCounts serves the
// fail-CLOSED presence check, where an unreadable leg costs at most a skipped
// scrobble, and this one serves the opposite direction.
export function combineGatedCounts(icecast: number | null, hls: number | null | undefined): number | null {
  if (hls === undefined) return icecast;
  if (icecast === null || hls === null) return null;
  return icecast + hls;
}

// JSONL of {t, count}, one row per minute (not per 15s poll) — ~1440 rows/day.
const HISTORY_FILE = join(config.stateDir, 'listeners.jsonl');
let lastPersistedMinute = -1;

// Icecast exposes samplerate/channels either as top-level numeric fields or
// inside the semicolon-delimited `audio_info` string, depending on build and
// encoder. Try the direct field first, then the string.
function audioParam(src: any, key: 'samplerate' | 'channels'): number | null {
  const direct = Number(src?.[key]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const m = String(src?.audio_info || '').match(new RegExp(`${key}=([0-9]+)`, 'i'));
  return m ? Number(m[1]) : null;
}

// Coalesce overlapping polls into one in-flight run.
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    inFlight ??= run().finally(() => { inFlight = null; });
    return inFlight;
  };
}

// pollCount() commits module state and is driven from three cadences at once
// (15s monitor, the idle monitor's forced 5s refresh, POST /request's
// refresh()). Without the single-flight guard a slow doomed poll can commit
// after a younger successful one and overwrite its fresh state.
const fetchCount = singleFlight(() => pollCount(true));

async function pollCount(persistHistory: boolean) {
  let online = false;
  let bitrate: number | null = null;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  let rawCount = 0; // un-deduped status sum — the fallback when admin is unreachable
  try {
    const r = await fetchWithTimeout(config.icecast.statusUrl, { timeoutMs: STATUS_TIMEOUT_MS });
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
    // Describe the broadcast off the primary mount (/stream.mp3), not whichever
    // source Icecast listed first — Opus is a different encode and would
    // misreport the figures listeners actually receive.
    const primarySource =
      broadcastSources.find((s: any) => String(s?.listenurl || '').includes('/stream.mp3')) ??
      broadcastSources[0];
    const firstBitrate = Number(primarySource?.bitrate);
    bitrate = Number.isFinite(firstBitrate) ? firstBitrate : null;
    sampleRate = audioParam(primarySource, 'samplerate');
    channels = audioParam(primarySource, 'channels');

    // Dedupe off the admin per-connection feed. On any admin failure fall back
    // to the raw status sum rather than dropping the count.
    let current = rawCount;
    if (online && rawCount > 0) {
      try {
        current = dedupeListeners(await getConnections());
      } catch {
        /* admin unreachable / no password — keep the raw status sum */
      }
    }

    icecastCount = current;
    lastGoodIcecast = current;
    notePeak(combineCounts(current, hlsLeg()));
    lastStatus = { online, listeners: { current, peak: peakSeen }, bitrate, sampleRate, channels };
    consecutiveStatusFailures = 0;
  } catch {
    icecastCount = null;
    // A transient fetch failure means "unknown", not offline (#461).
    consecutiveStatusFailures += 1;
    lastStatus = statusAfterFailure(lastStatus, consecutiveStatusFailures, STALE_STATUS_LIMIT, peakSeen);
  }
  // One row per wall-clock minute, BOTH legs — the sparkline is the audience,
  // not the Icecast mount. Null samples are skipped so a stats outage leaves a
  // gap rather than a misleading "0 listeners" stripe.
  const combined = combineCounts(icecastCount, hlsLeg());
  if (persistHistory && combined !== null) {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60000);
    if (minute !== lastPersistedMinute) {
      lastPersistedMinute = minute;
      const line = JSON.stringify({ t: now.toISOString(), count: combined }) + '\n';
      appendFile(HISTORY_FILE, line).catch(() => {});  // best-effort
    }
  }
  return combined;
}

// Running max of the combined count. Updated wherever a combined count is
// formed, since the HLS leg moves between Icecast polls.
function notePeak(current: number | null): number {
  if (current !== null && current > peakSeen) peakSeen = current;
  return peakSeen;
}

// RAW reading, both legs: one failed Icecast fetch reads null on that leg. For
// reporting surfaces only; decision-making code reads gatedListenerCount().
export function getListenerCount() {
  return combineCounts(icecastCount, hlsLeg());
}

// The count the fail-open gates act on: the last real Icecast reading, held
// through transient poll failures and unknown only at STALE_STATUS_LIMIT, plus
// the HLS leg. djCallsAllowed(), the idle monitor and the analysis quiet gate
// must read this, never raw icecastCount — all fail OPEN on null, so one blip
// would release the idle pause (#1256). The hold applies to the Icecast leg
// only: HLS has no fetch to time out, and a transport that isn't served is no
// leg at all (hlsLeg), so an HLS null really does mean "cannot tell".
export function gatedListenerCount(): number | null {
  return combineGatedCounts(
    gatedCount(icecastCount, lastGoodIcecast, consecutiveStatusFailures, STALE_STATUS_LIMIT),
    hlsLeg(),
  );
}

// Fail-CLOSED presence check, the single definition of "someone is tuned in"
// for outbound side effects (scrobbles, gated track.play webhooks). Reads the
// RAW count on purpose: failing closed costs at most a skipped scrobble and
// needs no hysteresis. Don't unify it with the fail-open gates below.
//
// Both legs, which is the whole point: an HLS-only audience is an audience, and
// reading it as an empty room is what stopped every Last.fm submission.
export function presentListeners(): number | null {
  const count = getListenerCount();
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : null;
}

// Offline + 0/0 until the first successful poll. The HLS leg is added here
// rather than in the cache so a listener who arrives or leaves between two
// 15s Icecast polls still shows up on the next /now-playing.
export function getStreamStatus(): StreamStatus {
  const icecast = lastStatus.listeners.current;
  const leg = hlsLeg();
  const current = combineCounts(icecast, leg) ?? icecast;
  return {
    ...lastStatus,
    // `hls` in the split: 0 with no HLS leg at all (nobody can be on a
    // transport that isn't served), null when it is served but can't be read.
    listeners: { current, peak: notePeak(current), icecast, hls: leg === undefined ? 0 : leg },
  };
}

// Force an immediate poll. Used by the request route so a listener who just
// connected isn't rejected on a stale cached value.
export async function refresh() {
  return fetchCount();
}

// One-shot probe for out-of-process callers (the analysis quiet gate, #1099,
// runs in the tagger child which has no monitor loop). Skips the history append
// — the server process is the only writer of that JSONL — and bypasses the
// single-flight guard, which would drop the skip-history flag. Returns the
// GATED count: the quiet gate fails open the OPPOSITE way, so a blip would
// start a heavy DSP pass while somebody is listening (#1256).
export async function probeListenerCount(): Promise<number | null> {
  // Both legs, explicitly: the child has no HLS read loop either, and a leg
  // nobody refreshed reads as unknown — which here would mean starting a heavy
  // DSP pass while an HLS audience is listening.
  await Promise.all([pollCount(false), refreshHlsListeners()]);
  return gatedListenerCount();
}

// Pushed in by stream-idle.ts rather than imported out, to avoid a cycle.
let streamIdle = false;

export function setStreamIdle(v: boolean) {
  streamIdle = v;
}

// True when autonomous DJ LLM work is allowed. Fails OPEN on an unknown count
// so a stats outage never takes the DJ off the air. An idle-paused stream
// blocks regardless of the toggle: the voice queues aren't being pulled, so any
// WAV written now would pile up and play back-to-back on resume.
export function djCallsAllowed() {
  if (streamIdle) return false;
  if (!settings.get()?.llm?.pauseWhenEmpty) return true;
  const count = gatedListenerCount();
  if (count === null) return true;
  return count > 0;
}

// How long boot waits on the first poll before starting anyway. Derived from
// STATUS_TIMEOUT_MS: the wait only buys anything if it outlasts one failing
// status fetch, so a flat number would silently give up before every slow poll.
const FIRST_POLL_WAIT_MS = STATUS_TIMEOUT_MS + 500;

// Starts the 15s monitor loop. The promise settles once the first poll lands
// (or the wait elapses) so boot takes a reading before the queue watcher can
// dispatch a pick — "never polled" fails open and used to buy the DJ one free
// agent pick per restart (#1256).
export function startListenerMonitor(): Promise<void> {
  // The HLS leg starts here rather than from server.ts, so there is one boot
  // call site for "the station now knows who is listening". Its first read is a
  // local file, so it is not part of the race below.
  const hlsFirst = startHlsListenerMonitor();
  const first = fetchCount().then(() => {}, () => {});
  setInterval(fetchCount, 15000);
  return Promise.race([
    Promise.all([first, hlsFirst]).then(() => {}),
    new Promise<void>(resolve => setTimeout(resolve, FIRST_POLL_WAIT_MS).unref()),
  ]);
}

// Listener history for the admin sparkline: rows newer than `since` (default
// 24h ago), oldest-first. Read whole and filtered in memory (~1440 lines/day).
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

// Size of the persisted history file, for the admin debug view.
export async function historyBytes(): Promise<number> {
  try {
    const st = await stat(HISTORY_FILE);
    return st.size;
  } catch {
    return 0;
  }
}

// Per-connection breakdown from Icecast's /admin/listclients, which is
// Basic-auth gated — unlike the aggregate count off the public status JSON.
export interface ListenerConnection {
  ip: string;
  mount: string;
  userAgent: string;
  connectedSeconds: number;
  /** Raw sockets folded into this row by groupConnections (Safari opens 2). */
  connections?: number;
}

const BROADCAST_MOUNTS = ['/stream.mp3', '/stream.opus', '/stream.flac', '/stream.aac'];
let cachedAdminPassword: string | null = null;

// Env wins, else the shared icecast-secrets.env the broadcast container writes
// on boot (both containers mount /var/sub-wave).
async function resolveAdminPassword(): Promise<string | null> {
  if (process.env.ICECAST_ADMIN_PASSWORD) return process.env.ICECAST_ADMIN_PASSWORD;
  if (cachedAdminPassword) return cachedAdminPassword;
  try {
    const raw = await readFile(join(config.stateRoot, 'icecast-secrets.env'), 'utf8');
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

// Decode the XML entities Icecast escapes in text fields. &amp; is undone last
// so "&amp;lt;" survives.
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

// listclients XML is flat and machine-generated, so a block scan is enough. The
// opening tag carries an id attribute, so the match must allow attributes.
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

// Max gap (seconds) between Safari's two sockets' Connected times for them to
// count as one listener's double. Absorbs poll jitter without bridging two
// genuinely separate joins.
const DOUBLE_WINDOW_S = 6;

// True for real Safari / AppleCoreMedia, the only clients that open two
// identical sockets per listener. Chrome-on-Mac carries a "Safari" token but is
// Blink and opens one socket, so it must NOT match: gate on "Version/" +
// "Safari" and exclude the Chromium-family tokens.
function isSafariDouble(ua: string): boolean {
  if (/AppleCoreMedia/i.test(ua)) return true;
  if (!/Safari/i.test(ua) || !/Version\//i.test(ua)) return false;
  return !/(Chrome|CriOS|Chromium|Android|Edg|OPR)/i.test(ua);
}

// Headline count. Shares groupConnections with the admin table so the two
// can't drift apart.
export function dedupeListeners(conns: ListenerConnection[]): number {
  return groupConnections(conns).length;
}

// One row per distinct listener. Every non-Safari socket is its own listener
// (two listeners behind one proxy IP with the same UA both count); Safari's two
// near-simultaneous sockets pair into one row. `connections` records how many
// raw sockets folded in.
export function groupConnections(conns: ListenerConnection[]): ListenerConnection[] {
  const singles: ListenerConnection[] = [];
  const safari: ListenerConnection[] = [];
  for (const c of conns) (isSafariDouble(c.userAgent) ? safari : singles).push(c);

  const out: ListenerConnection[] = singles.map(c => ({ ...c, connections: 1 }));

  // Pair Safari sockets per mount: sort by Connected, greedily merge an
  // adjacent socket within the window. Groups cap at 2 — Safari only doubles.
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

// Returns [] when nobody's connected; throws only on auth/transport failure so
// the admin route can show the operator why the table is empty.
export async function getConnections(): Promise<ListenerConnection[]> {
  const password = await resolveAdminPassword();
  if (!password) throw new Error('Icecast admin password unavailable');
  const auth =
    'Basic ' + Buffer.from(`${config.icecast.adminUser}:${password}`).toString('base64');

  const rows: ListenerConnection[] = [];
  for (const mount of BROADCAST_MOUNTS) {
    const r = await fetchWithTimeout(`${config.icecast.adminUrl}?mount=${encodeURIComponent(mount)}`, {
      headers: { Authorization: auth },
      timeoutMs: 2000,
    });
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
