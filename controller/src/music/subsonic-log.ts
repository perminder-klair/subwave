// Ring buffer + aggregate tracker for Subsonic/Navidrome API calls, feeding the
// admin /debug surface. Its own module so subsonic.js can record without a cycle.

import { appendFile } from 'node:fs/promises';
import { statSync, renameSync } from 'node:fs';
import { STATE_DIR } from '../config.js';
import { logEvent } from '../observability/events.js';

const MAX_CALLS = 150;
export const recentCalls: any[] = [];

// endpoint -> { calls, errors, totalMs, songResults }
const endpointStats = new Map<string, any>();
// songId -> { id, title, artist, count }: how often each song has come back.
const songCoverage = new Map<string, any>();

// Durable append-only log; the maps above are lost on restart. Best-effort — a
// write failure must never break a request.
const CALLS_LOG = `${STATE_DIR}/logs/subsonic.log`;
// One .old backup is kept; older content is overwritten.
const CALLS_LOG_MAX_BYTES = 10 * 1024 * 1024;

// Rotate on module load and every ~1000 writes, so a long-uptime controller does
// not blow past the cap. Missing file or logs/ dir is fine.
function maybeRotateLog() {
  try {
    if (statSync(CALLS_LOG).size > CALLS_LOG_MAX_BYTES) {
      renameSync(CALLS_LOG, `${CALLS_LOG}.old`);
    }
  } catch {}
}
maybeRotateLog();
let _appendsSinceRotateCheck = 0;

export function record(entry: any) {
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

  // logEvent stamps the active traceId, linking this call to the DJ decision that
  // caused it, and carries the params CALLS_LOG drops.
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
