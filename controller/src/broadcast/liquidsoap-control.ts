// Liquidsoap telnet client. radio.liq registers a "restart" command that calls
// shutdown(); the container restart-policy brings the mixer back with whatever
// settings files the controller just wrote.

import net from 'node:net';
import { cachedAsync } from '../util/ttl-cache.js';
import { parseDjQueueStatus, type DjQueueStatus } from './skip-policy.js';
import {
  parseResolveProbeOutcome,
  type ResolveProbeOutcome,
} from './resolve-probe.js';

// Liquidsoap shares the `broadcast` container with icecast2; the legacy
// `liquidsoap` hostname still works as a pinned .env override.
const HOST = process.env.LIQUIDSOAP_HOST || 'broadcast';
const PORT = parseInt(process.env.LIQUIDSOAP_PORT || '1234', 10);

export function sendCommand(cmd: string, timeoutMs = 3000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = net.createConnection({ host: HOST, port: PORT });
    let buf = '';
    let done = false;

    const finish = (err: Error | null, value?: string) => {
      if (done) return;
      done = true;
      try { sock.end('quit\n'); } catch {}
      try { sock.destroy(); } catch {}
      if (err) reject(err); else resolve(value as string);
    };

    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => finish(new Error('liquidsoap telnet timeout')));
    sock.on('error', err => {
      // ENOTFOUND usually means the controller is outside the compose network;
      // give the hint rather than the raw DNS error (#62).
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        finish(new Error(
          `liquidsoap host "${HOST}:${PORT}" did not resolve — set LIQUIDSOAP_HOST=localhost in controller/.env if the controller is running outside docker-compose (and ensure liquidsoap's port 1234 is exposed on the host)`
        ));
        return;
      }
      finish(err);
    });
    sock.on('connect', () => sock.write(`${cmd}\n`));
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      // Liquidsoap terminates responses with END\r\n
      if (/END\r?\n/.test(buf)) finish(null, buf.replace(/END\r?\n.*$/s, '').trim());
    });
    sock.on('close', () => finish(null, buf.trim()));
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// TCP liveness probe. A port that stops accepting is proof the shutdown landed;
// any connect error counts as down.
function isLiquidsoapReachable(timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.createConnection({ host: HOST, port: PORT });
    let settled = false;
    const done = (up: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(up);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export async function restartLiquidsoap() {
  // sendCommand resolving is NOT proof the restart landed — the telnet socket
  // can close cleanly with an empty buffer. Confirm by watching the port go
  // down, and resend if it doesn't.
  invalidateStreamStatus();
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendCommand('restart', 2000);
    } catch (err) {
      // A reset/timeout is expected as Liquidsoap tears the socket down;
      // anything else is a real failure.
      if (!/ECONNRESET|EPIPE|timeout/i.test(err.message)) throw err;
      lastErr = err as Error;
    }
    // shutdown() is async; a genuine restart drops within a couple of seconds,
    // so a port still accepting after the window means the command was dropped.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!(await isLiquidsoapReachable())) return; // confirmed down → restart took
      await sleep(250);
    }
  }
  throw new Error(
    `liquidsoap restart did not take effect after 3 attempts — telnet port stayed up${lastErr ? ` (last error: ${lastErr.message})` : ''}`,
  );
}

// Unlike restart, this returns a normal "OK" — Liquidsoap stays up.
export async function skipTrack() {
  return sendCommand('skip', 2000);
}

// What a skip would air next from dj_queue. 'unknown' covers a telnet failure
// and an older radio.liq without the command, so the commit-then-skip wait
// degrades to its grace path rather than throwing mid-skip.
export async function djQueueStatus(): Promise<DjQueueStatus> {
  try {
    return parseDjQueueStatus(await sendCommand('dj_queue_status', 2000));
  } catch {
    return 'unknown';
  }
}

// Explicit completion state recorded by proto_subhttp for one controller
// handoff. This does not inspect dj_queue.queue(): that list includes idle /
// resolving requests and temporarily omits healthy boundary-prefetch work.
export async function subhttpProbeOutcome(probeId: string): Promise<ResolveProbeOutcome> {
  try {
    return parseResolveProbeOutcome(
      await sendCommand(`subhttp_probe_status ${probeId}`, 2000),
    );
  } catch {
    return 'unknown';
  }
}

// Force auto.m3u to re-read from disk. The playlist's reload_mode="watch"
// inotify watch orphans itself because the controller rewrites the file by
// atomic rename (new inode), and a missed watch loops the last snapshot forever
// (#874). Best-effort: errors are swallowed so a refresh never fails here.
export async function reloadAutoPlaylist(): Promise<boolean> {
  try {
    await sendCommand('auto.reload', 2000);
    return true;
  } catch {
    return false;
  }
}

// stream_off disconnects the Icecast mounts (station off air); stream_on
// recreates them. The mixer process keeps running throughout.
export async function startStream() {
  try {
    return await sendCommand('stream_on', 2000);
  } finally {
    invalidateStreamStatus();
  }
}

export async function stopStream() {
  try {
    return await sendCommand('stream_off', 2000);
  } finally {
    invalidateStreamStatus();
  }
}

// How long an on-air reading is reused. Each telnet take logs a client
// connect/disconnect pair in the mixer log, and /settings is polled every 3s
// per admin tab (#1300 bug 16b). A mixer that goes off air outside the
// controller invalidates nothing, so the badge can lag by up to the TTL;
// callers needing the live answer use streamStatusFresh().
const STREAM_STATUS_TTL_MS = 10_000;

const streamStatusCache = cachedAsync(
  async () => /\bon\b/i.test(await sendCommand('stream_status', 2000)),
  { ttlMs: STREAM_STATUS_TTL_MS },
);

// True when on air. Cached; a telnet failure still rejects (never cached, never
// served stale) so callers decide what an unreachable mixer means.
export async function streamStatus() {
  return streamStatusCache.get();
}

// Guaranteed real telnet round-trip: invalidating first drops any in-flight
// take too. Operator-triggered surfaces only (Doctor) — putting this on a poll
// reinstates the per-request connection the cache exists to remove.
export async function streamStatusFresh(): Promise<boolean> {
  streamStatusCache.invalidate();
  return streamStatusCache.get();
}

// Called by anything that changes what stream_status would report, so an
// operator toggle shows up immediately rather than after the TTL.
export function invalidateStreamStatus(): void {
  streamStatusCache.invalidate();
}

// Idle gate (radio.liq `idle_gate`). Unlike stream_off the Icecast mounts stay
// up serving silence, so new listeners still connect and can wake the
// programme. Idempotent, so the monitor can re-assert state after a restart.
export async function idleOn() {
  return sendCommand('idle_on', 2000);
}

export async function idleOff() {
  return sendCommand('idle_off', 2000);
}

// Returns true when the idle gate is active. `idle_status` replies "on"/"off".
export async function idleStatus() {
  const res = await sendCommand('idle_status', 2000);
  return /\bon\b/i.test(res);
}

interface DjQueueSnapshot {
  ids: Set<string>;
  // subsonic_id → Liquidsoap request id; first occurrence wins.
  ridBySubsonicId: Map<string, string>;
  // Pre-rendered transition clips carry the INCOMING track's subsonic_id and
  // sit earlier in dj_queue, so first-occurrence would bind that id to the
  // clip's rid and a cancel would remove the clip, not the track. Kept here
  // instead and excluded from ids/ridBySubsonicId.
  clipRidBySubsonicId: Map<string, string>;
  // Request ids in FIFO push order, so the entry immediately ahead of a track
  // (where a bed rides) can be found. dj_queue.queue lists oldest-first.
  orderedRids: string[];
  // Request ids whose annotate URI carries subwave_kind="bed" — beds have no
  // subsonic_id, so this is the only way to recognise them in the queue.
  bedRids: Set<string>;
}
interface DjQueueCache extends DjQueueSnapshot {
  timestamp: number;
}
let _djQueueCache: DjQueueCache | null = null;
let _djQueueInflight: Promise<Set<string>> | null = null;

// Two telnet hops: dj_queue.queue for the rids, request.metadata per rid.
async function fetchDjQueue(): Promise<DjQueueSnapshot> {
  const res = await sendCommand('dj_queue.queue', 2000);
  const rids = res.trim().split(/\s+/).filter(Boolean);
  const ids = new Set<string>();
  const ridBySubsonicId = new Map<string, string>();
  const clipRidBySubsonicId = new Map<string, string>();
  const bedRids = new Set<string>();

  for (const rid of rids) {
    try {
      const meta = await sendCommand(`request.metadata ${rid}`, 2000);
      // An unprepared request is status=idle with no top-level metadata, but
      // its annotate URI survives inside initial_uri with escaped quotes — so
      // match the id anywhere in the blob, not on an anchored top-level line.
      const match = /subsonic_id=\\?"([^"\\]+)/.exec(meta);
      if (match && match[1]) {
        // Clips masquerade as their incoming track; route to the clip map.
        if (/subwave_clip=\\?"1/.test(meta)) {
          if (!clipRidBySubsonicId.has(match[1])) clipRidBySubsonicId.set(match[1], rid);
        } else {
          ids.add(match[1]);
          if (!ridBySubsonicId.has(match[1])) ridBySubsonicId.set(match[1], rid);
        }
      }
      if (/subwave_kind=\\?"bed/.test(meta)) bedRids.add(rid);
    } catch (ridErr: any) {
      console.warn(`[liquidsoap] request.metadata ${rid} failed: ${ridErr.message}`);
    }
  }

  return { ids, ridBySubsonicId, clipRidBySubsonicId, orderedRids: rids, bedRids };
}

// Returns a Set of subsonic_ids currently in the queue (cached ~4s).
export async function getDjQueueIds(): Promise<Set<string>> {
  if (_djQueueCache && Date.now() - _djQueueCache.timestamp < 4000) {
    return _djQueueCache.ids;
  }
  if (_djQueueInflight) {
    return _djQueueInflight;
  }

  _djQueueInflight = (async () => {
    try {
      const snap = await fetchDjQueue();
      _djQueueCache = { timestamp: Date.now(), ...snap };
      return snap.ids;
    } finally {
      _djQueueInflight = null;
    }
  })();

  return _djQueueInflight;
}

// The rid for a queued track plus the bed queued immediately ahead of it.
// Always a fresh read — cancel decisions can't ride the 4s cache. A bed has no
// subsonic_id, so this is the only way an id-keyed cancel can find it.
export async function resolveDjQueueRidWithBed(
  subsonicId: string,
): Promise<{ rid: string | null; bedRid: string | null }> {
  const snap = await fetchDjQueue();
  _djQueueCache = { timestamp: Date.now(), ...snap };
  const rid = snap.ridBySubsonicId.get(subsonicId) ?? null;
  if (!rid) return { rid: null, bedRid: null };
  const prev = snap.orderedRids[snap.orderedRids.indexOf(rid) - 1];
  return { rid, bedRid: prev && snap.bedRids.has(prev) ? prev : null };
}

// Resolve the rid of a pending transition CLIP rendered for the given
// incoming track (stem-blend transitions). Fresh read like the helper above;
// null when no clip is pending for that id.
export async function resolveClipRid(subsonicId: string): Promise<string | null> {
  const snap = await fetchDjQueue();
  _djQueueCache = { timestamp: Date.now(), ...snap };
  return snap.clipRidBySubsonicId.get(subsonicId) ?? null;
}

// False when Liquidsoap replies NOT_FOUND: the request already left the queue
// (playing, played, or popped for prefetch), so there is nothing to cancel.
export async function removeFromDjQueue(rid: string): Promise<boolean> {
  const res = await sendCommand(`dj_queue_remove ${rid}`, 2000);
  _djQueueCache = null; // the queue just changed under the cache
  return res.trim() === 'OK';
}
