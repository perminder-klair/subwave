// Icecast listener-count monitor.
//
// Polls Icecast's status-json.xsl on an interval and caches the live listener
// count across both broadcast mounts (/stream.mp3 + /stream.opus), so the DJ
// gates can ask "is anyone listening?" without each one hitting Icecast.
//
// Fail-open: if Icecast is unreachable the count is null and djCallsAllowed()
// treats the station as occupied — a stats outage must never silence the DJ.

import { appendFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import * as settings from '../settings.js';

let lastCount: number | null = null;        // null = unknown (not yet polled, or Icecast down)

// Time-series file. JSONL of {t, count} rows, one per persisted sample.
// We persist every minute (not every 15s poll) — keeps the file at ~1440
// rows/day, easily tail-readable, and that resolution is plenty for the
// "is anyone here?" sparkline this is for.
const HISTORY_FILE = join(config.stateDir, 'listeners.jsonl');
let lastPersistedMinute = -1;

async function fetchCount() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(config.icecast.statusUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    const ic = ((await r.json()) as any)?.icestats;
    const sources = Array.isArray(ic?.source) ? ic.source : ic?.source ? [ic.source] : [];
    // Sum listeners across our two broadcast mounts. Anything else (e.g. an
    // /admin source) is ignored so stray test mounts don't inflate the count.
    const broadcastMounts = ['/stream.mp3', '/stream.opus'];
    lastCount = sources.reduce((sum: number, s: any) => {
      const url = String(s?.listenurl || '');
      return broadcastMounts.some(m => url.includes(m))
        ? sum + Number(s.listeners || 0)
        : sum;
    }, 0);
  } catch {
    lastCount = null;
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
