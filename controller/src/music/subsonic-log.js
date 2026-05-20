// Ring buffer + aggregate tracker for Subsonic/Navidrome API calls — feeds the
// admin /debug surface so every request to the music server is inspectable.
// Mirrors llm/log.js. Lives in its own module so subsonic.js can record
// without an import cycle.

import { appendFile } from 'node:fs/promises';
import { statSync, renameSync } from 'node:fs';
import { STATE_DIR } from '../config.js';
import { logEvent } from '../observability/events.js';

const MAX_CALLS = 150;
export const recentCalls = [];

// endpoint -> { calls, errors, totalMs, songResults }
const endpointStats = new Map();
// songId -> { id, title, artist, count } — how often each song has come back,
// the evidence for "is the picker drawing from the whole library or a pool?"
const songCoverage = new Map();

// Durable append-only log. The in-memory structures above are lost on restart;
// this tab-separated file in the shared state volume survives, so pool
// patterns stay reviewable over days. Best-effort — a write failure must never
// break a request.
const CALLS_LOG = `${STATE_DIR}/logs/subsonic.log`;
// A busy station writes ~40 MB/month to this log. Rotate when it hits this
// cap; one .old backup is kept (older content is overwritten). Tuned tight
// because the in-memory ring + logEvent stream cover real observability —
// this file just provides a few days of audit history.
const CALLS_LOG_MAX_BYTES = 10 * 1024 * 1024;

// Rotate on module load (catches the cap across redeploys) AND every ~1000
// writes (catches it during long uptimes — a controller running a month would
// otherwise blow past the cap with only the startup check). Sync calls are
// fine: the startup check runs once, and the periodic check runs ~once an hour
// at typical pick rates. Missing file or missing logs/ dir is fine.
function maybeRotateLog() {
  try {
    if (statSync(CALLS_LOG).size > CALLS_LOG_MAX_BYTES) {
      renameSync(CALLS_LOG, `${CALLS_LOG}.old`);
    }
  } catch {}
}
maybeRotateLog();
let _appendsSinceRotateCheck = 0;

export function record(entry) {
  recentCalls.unshift(entry);
  if (recentCalls.length > MAX_CALLS) recentCalls.length = MAX_CALLS;

  let st = endpointStats.get(entry.endpoint);
  if (!st) {
    st = { calls: 0, errors: 0, totalMs: 0, songResults: 0 };
    endpointStats.set(entry.endpoint, st);
  }
  st.calls += 1;
  st.totalMs += entry.ms || 0;
  if (!entry.ok) st.errors += 1;
  st.songResults += entry.songIds?.length || 0;

  for (const s of entry.songIds || []) {
    const hit = songCoverage.get(s.id);
    if (hit) hit.count += 1;
    else songCoverage.set(s.id, { id: s.id, title: s.title, artist: s.artist, count: 1 });
  }

  const line = [
    entry.t,
    entry.endpoint,
    entry.ms,
    entry.ok ? 'ok' : 'err',
    entry.count,
  ].join('\t') + '\n';
  if (++_appendsSinceRotateCheck >= 1000) {
    _appendsSinceRotateCheck = 0;
    maybeRotateLog();
  }
  appendFile(CALLS_LOG, line).catch(() => {});

  // Durable, trace-correlated event — logEvent stamps the active traceId, so
  // this Navidrome call is linked to the DJ decision that caused it. Carries
  // the request params that the tab-separated CALLS_LOG above drops.
  logEvent('navidrome', {
    endpoint: entry.endpoint,
    params: entry.params || null,
    ms: entry.ms,
    ok: entry.ok,
    count: entry.count,
    error: entry.error || null,
    songIds: (entry.songIds || []).slice(0, 25),
  });
}

export function snapshot(libraryTotal = null) {
  const endpoints = [...endpointStats.entries()]
    .map(([endpoint, st]) => ({
      endpoint,
      calls: st.calls,
      errors: st.errors,
      avgMs: st.calls ? Math.round(st.totalMs / st.calls) : 0,
      songResults: st.songResults,
    }))
    .sort((a, b) => b.calls - a.calls);

  const songs = [...songCoverage.values()];
  const topSongs = songs
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  return {
    recentCalls,
    endpoints,
    coverage: {
      distinctSongs: songs.length,
      totalSongResults: songs.reduce((sum, s) => sum + s.count, 0),
      libraryTotal,
      topSongs,
    },
  };
}

export function reset() {
  recentCalls.length = 0;
  endpointStats.clear();
  songCoverage.clear();
}
