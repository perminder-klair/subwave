// Unified event log — a durable, append-only JSONL timeline of everything the
// DJ does: LLM calls, agent tool calls, and Navidrome/Subsonic API calls.
//
// The in-memory ring buffers (llm/log.js, music/subsonic-log.js) feed the live
// /debug surface but are lost on restart and can't be correlated. This module
// writes one JSON line per event to ${STATE_DIR}/logs/events-YYYY-MM-DD.jsonl
// so the whole thing survives restarts and is analysable with `jq`.
//
// Correlation: `withTrace` wraps each logical DJ decision (a track pick, a
// request, a scheduled segment) in an AsyncLocalStorage scope carrying a
// traceId. Every LLM/tool/Navidrome call made anywhere inside that scope —
// however deep the await chain — is stamped with the same traceId, so a
// decision and the calls it triggered can be read back as one trace.
//
// Best-effort everywhere: a write failure or a logging bug must never break a
// broadcast. logEvent swallows its own errors and never throws into callers.

import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from '../config.js';

type TraceStore = { traceId: string; kind: string; seq: number };
const als = new AsyncLocalStorage<TraceStore>();

// Ensure the logs dir exists once — on a fresh checkout state/logs/ may not
// exist yet, and a best-effort appendFile would silently drop every line.
const LOGS_DIR = `${STATE_DIR}/logs`;
const dirReady = mkdir(LOGS_DIR, { recursive: true }).catch(() => {});

// Sequence counter for events fired outside any trace — keeps the file totally
// ordered even when two ISO timestamps collide at millisecond resolution.
let globalSeq = 0;

// Today's log file. Computed per write (UTC) so the file rotates daily with no
// daemon — old days are simply never reopened.
function eventsPath() {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${STATE_DIR}/logs/events-${day}.jsonl`;
}

// Truncate long strings for the durable file (the in-memory /debug buffer keeps
// them full). Marks where content was dropped so analysis isn't misled.
export function cap(str: any, n = 4000) {
  if (typeof str !== 'string') return str;
  if (str.length <= n) return str;
  return str.slice(0, n) + `…[+${str.length - n} chars]`;
}

// The active trace store, or null when running outside any withTrace scope
// (e.g. boot-time library warm-up). Callers read `.traceId`.
export function currentTrace() {
  return als.getStore() || null;
}

// Append one event line. `data` is spread onto the record after the standard
// envelope fields. Never throws.
export function logEvent(type: string, data: any = {}) {
  try {
    const trace = currentTrace();
    const seq = trace ? ++trace.seq : ++globalSeq;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      traceId: trace?.traceId || null,
      seq,
      type,
      ...data,
    }) + '\n';
    dirReady.then(() => appendFile(eventsPath(), line)).catch(() => {});
  } catch {
    // Logging must never break a broadcast.
  }
}

// Delete event day-files older than `maxAgeDays`. Daily rotation means old
// days are never reopened, but nothing ever removed them either — on a busy
// station the JSONL files were the biggest unbounded state-dir growth vector.
// The horizon is generous: recent-plays backfill (queue.ts) needs 2 days and
// the budget seed (telemetry/budget.ts) needs today only. Called from the
// hourly scheduler cleanup; best-effort per file so one unlink failure can't
// stop the sweep.
export const EVENTS_MAX_AGE_DAYS = 14;

export async function pruneOldEvents(maxAgeDays = EVENTS_MAX_AGE_DAYS): Promise<number> {
  // Lexicographic compare works because the filename embeds YYYY-MM-DD.
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  let removed = 0;
  let names: string[] = [];
  try {
    names = await readdir(LOGS_DIR);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = name.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m || m[1] >= cutoff) continue;
    try {
      await unlink(`${LOGS_DIR}/${name}`);
      removed += 1;
    } catch {}
  }
  return removed;
}

// Run `fn` inside a fresh trace scope. Emits a `trace.start` event up front and
// a `trace.end` ({ ok, ms }) once `fn` settles. Errors are re-thrown unchanged
// so existing fallback logic (dj-agent's pool fallback, etc.) still triggers.
export async function withTrace<T>(meta: any = {}, fn: () => Promise<T>): Promise<T> {
  const store: TraceStore = { traceId: randomUUID(), kind: meta.kind || 'trace', seq: 0 };
  return als.run(store, async () => {
    const startedAt = Date.now();
    logEvent('trace.start', { kind: store.kind, meta });
    let ok = true;
    let error: any;
    try {
      return await fn();
    } catch (err: any) {
      ok = false;
      error = err?.message;
      throw err;
    } finally {
      logEvent('trace.end', {
        kind: store.kind, ok, ms: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
    }
  });
}
