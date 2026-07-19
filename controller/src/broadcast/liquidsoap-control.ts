// Liquidsoap server (telnet) client — sends commands to the running mixer
// via TCP. radio.liq enables this and registers a "restart" command that
// triggers shutdown(); the container's restart-policy brings it right back
// with whatever updated settings the controller just wrote to disk.
//
// Sub-station channels: every channel runs its own liquidsoap process inside
// the same broadcast container, each on its own telnet port (assigned in
// settings.channels[].telnetPort, 1235+; the main station keeps 1234). Every
// exported command takes an optional trailing `port` — omitted = the main
// mixer, so existing call sites are untouched. Channel processes are
// respawned by the supervisor's reconcile loop (not the container restart
// policy), so restartLiquidsoap(port) has the same down-then-back semantics.

import net from 'node:net';

// Liquidsoap shares a container with icecast2 under the `broadcast` service
// (see docker-compose.yml). The legacy `liquidsoap` hostname is still honoured
// for operators with a pinned override in their .env, but the default reflects
// the merged image.
const HOST = process.env.LIQUIDSOAP_HOST || 'broadcast';
const DEFAULT_PORT = parseInt(process.env.LIQUIDSOAP_PORT || '1234', 10);

export function sendCommand(cmd: string, timeoutMs = 3000, port = DEFAULT_PORT): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock = net.createConnection({ host: HOST, port });
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
      // ENOTFOUND means the controller can't resolve the liquidsoap hostname —
      // almost always because it's running outside the compose network. Surface
      // a hint instead of the raw DNS error so the next operator doesn't have
      // to dig (see issue #62).
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        finish(new Error(
          `liquidsoap host "${HOST}:${port}" did not resolve — set LIQUIDSOAP_HOST=localhost in controller/.env if the controller is running outside docker-compose (and ensure liquidsoap's port ${port} is exposed on the host)`
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

// Quick liveness probe — can we open a TCP connection to the telnet port?
// Used to confirm a restart actually took: Liquidsoap must drop before the
// container restart-policy brings it back, so a port that stops accepting
// connections is proof the shutdown landed. Any connect error (refused,
// timeout) counts as "down".
function isLiquidsoapReachable(timeoutMs = 800, port = DEFAULT_PORT): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.createConnection({ host: HOST, port });
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

export async function restartLiquidsoap(port = DEFAULT_PORT) {
  // The custom "restart" command in radio.liq calls shutdown(); the container
  // restart-policy (main mixer) or the supervisor's reconcile loop (channel
  // mixers) then brings Liquidsoap back with the freshly-written settings
  // files. We can't trust sendCommand resolving as proof the command landed:
  // the telnet socket can close cleanly with an empty buffer (e.g. it raced a
  // concurrent stream_status poll), which still resolves — so a bare "no
  // error" would let /restart-mixer report success while pending settings
  // silently never apply. Confirm by watching the port actually go down, and
  // resend if it doesn't.
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendCommand('restart', 2000, port);
    } catch (err) {
      // A reset/timeout is expected — Liquidsoap is tearing the socket down.
      // Anything else (e.g. an unresolved host) is a real failure to surface.
      if (!/ECONNRESET|EPIPE|timeout/i.test(err.message)) throw err;
      lastErr = err as Error;
    }
    // shutdown() is asynchronous; poll until the process actually drops. A
    // genuine restart goes down within a couple of seconds, so if the port is
    // still accepting after the window the command was dropped — retry it.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!(await isLiquidsoapReachable(800, port))) return; // confirmed down → restart took
      await sleep(250);
    }
  }
  throw new Error(
    `liquidsoap restart did not take effect after 3 attempts — telnet port ${port} stayed up${lastErr ? ` (last error: ${lastErr.message})` : ''}`,
  );
}

// Skip the currently playing track via the custom "skip" command in radio.liq.
// Unlike restart, this returns a normal "OK" response — Liquidsoap stays up.
export async function skipTrack(port = DEFAULT_PORT) {
  return sendCommand('skip', 2000, port);
}

// Force the auto.m3u fallback playlist to re-read from disk. The playlist
// (id="auto" in radio.liq) uses reload_mode="watch", but that inotify watch can
// silently orphan itself — the controller rewrites auto.m3u via atomic rename,
// which swaps the inode each time, and a single missed watch means Liquidsoap
// loops the last-loaded ~30-track snapshot forever until the container restarts
// (issue #874). Calling the playlist's built-in `auto.reload` telnet command
// after every write makes the reload deterministic instead of trusting inotify.
// Best-effort: swallow errors (telnet may be unreachable in dev or mid-restart)
// so a refresh never fails on the reload.
export async function reloadAutoPlaylist(port = DEFAULT_PORT): Promise<boolean> {
  try {
    await sendCommand('auto.reload', 2000, port);
    return true;
  } catch {
    return false;
  }
}

// Start / stop / query the broadcast. radio.liq registers stream_on /
// stream_off / stream_status server commands: stream_off shuts the Icecast
// output down so the /stream.mp3 mount disconnects (the station goes off
// air); stream_on recreates it. The mixer process keeps running throughout.
export async function startStream(port = DEFAULT_PORT) {
  return sendCommand('stream_on', 2000, port);
}

export async function stopStream(port = DEFAULT_PORT) {
  return sendCommand('stream_off', 2000, port);
}

// Returns true when on air, false otherwise. `stream_status` replies "on" /
// "off".
export async function streamStatus(port = DEFAULT_PORT) {
  const res = await sendCommand('stream_status', 2000, port);
  return /\bon\b/i.test(res);
}

// Pause / resume / query the idle gate (radio.liq `idle_gate`). Unlike
// stream_off, the Icecast mounts stay up serving silence — new listeners
// connect normally, which is what lets the stream-idle monitor wake the
// programme when someone tunes in. Both commands are idempotent, so the
// monitor can re-assert the desired state after a mixer restart.
export async function idleOn(port = DEFAULT_PORT) {
  return sendCommand('idle_on', 2000, port);
}

export async function idleOff(port = DEFAULT_PORT) {
  return sendCommand('idle_off', 2000, port);
}

// Returns true when the idle gate is active. `idle_status` replies "on"/"off".
export async function idleStatus(port = DEFAULT_PORT) {
  const res = await sendCommand('idle_status', 2000, port);
  return /\bon\b/i.test(res);
}

interface DjQueueSnapshot {
  ids: Set<string>;
  // subsonic_id → Liquidsoap request id. First occurrence wins on the off
  // chance of a duplicate (queue.push dedupes by track id, so there shouldn't
  // be one).
  ridBySubsonicId: Map<string, string>;
}
interface DjQueueCache extends DjQueueSnapshot {
  timestamp: number;
}
// Keyed by telnet port — each channel's liquidsoap holds its own dj_queue.
const _djQueueCache = new Map<number, DjQueueCache>();
const _djQueueInflight = new Map<number, Promise<Set<string>>>();

// Query Liquidsoap's dj_queue using two telnet hops:
// 1. dj_queue.queue returns space-separated request IDs.
// 2. request.metadata <rid> returns metadata for each request ID.
async function fetchDjQueue(port = DEFAULT_PORT): Promise<DjQueueSnapshot> {
  const res = await sendCommand('dj_queue.queue', 2000, port);
  const rids = res.trim().split(/\s+/).filter(Boolean);
  const ids = new Set<string>();
  const ridBySubsonicId = new Map<string, string>();

  for (const rid of rids) {
    try {
      const meta = await sendCommand(`request.metadata ${rid}`, 2000, port);
      // A pending request that Liquidsoap hasn't prepared yet is `status=idle`
      // with no resolved top-level metadata — but its annotate URI is still
      // there as `initial_uri="annotate:...,subsonic_id=\"…\"..."`. So match the
      // id anywhere in the blob (tolerating the escaped quotes inside
      // initial_uri), not just an anchored top-level `subsonic_id=` line — the
      // furthest-out queued track (the one most likely to be cancelled) is
      // exactly the one that's still idle. See #? / queue-cancel.
      const match = /subsonic_id=\\?"([^"\\]+)/.exec(meta);
      if (match && match[1]) {
        ids.add(match[1]);
        if (!ridBySubsonicId.has(match[1])) ridBySubsonicId.set(match[1], rid);
      }
    } catch (ridErr: any) {
      console.warn(`[liquidsoap] request.metadata ${rid} failed: ${ridErr.message}`);
    }
  }

  return { ids, ridBySubsonicId };
}

// Returns a Set of subsonic_ids currently in the queue (cached ~4s).
export async function getDjQueueIds(port = DEFAULT_PORT): Promise<Set<string>> {
  const cached = _djQueueCache.get(port);
  if (cached && Date.now() - cached.timestamp < 4000) {
    return cached.ids;
  }
  const inflight = _djQueueInflight.get(port);
  if (inflight) {
    return inflight;
  }

  const fetching = (async () => {
    try {
      const snap = await fetchDjQueue(port);
      _djQueueCache.set(port, { timestamp: Date.now(), ...snap });
      return snap.ids;
    } finally {
      _djQueueInflight.delete(port);
    }
  })();
  _djQueueInflight.set(port, fetching);

  return fetching;
}

// Resolve the Liquidsoap request id for a queued track. Always a fresh read —
// cancel decisions can't ride a 4s-stale cache (the track may have gone on
// air since). Returns null when the track is no longer pending in dj_queue.
export async function resolveDjQueueRid(subsonicId: string, port = DEFAULT_PORT): Promise<string | null> {
  const snap = await fetchDjQueue(port);
  _djQueueCache.set(port, { timestamp: Date.now(), ...snap });
  return snap.ridBySubsonicId.get(subsonicId) ?? null;
}

// Remove a pending request from dj_queue via the custom "dj_queue_remove"
// command in radio.liq. Returns false when Liquidsoap replies NOT_FOUND —
// the request already left the queue (playing or played), so there is
// nothing left to cancel.
export async function removeFromDjQueue(rid: string, port = DEFAULT_PORT): Promise<boolean> {
  const res = await sendCommand(`dj_queue_remove ${rid}`, 2000, port);
  _djQueueCache.delete(port); // the queue just changed under the cache
  return res.trim() === 'OK';
}
