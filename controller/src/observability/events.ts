// Durable append-only JSONL timeline of LLM calls, agent tool calls and
// Navidrome calls, at ${STATE_DIR}/logs/events-YYYY-MM-DD.jsonl. The in-memory
// ring buffers feeding /debug are lost on restart and can't be correlated.
//
// `withTrace` wraps one logical DJ decision in an AsyncLocalStorage scope
// carrying a traceId, so every call made inside it — however deep the await
// chain — reads back as one trace.
//
// Best-effort everywhere: logEvent swallows its own errors and never throws.

import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { STATE_DIR } from '../config.js';

type TraceStore = { traceId: string; kind: string; seq: number };
const als = new AsyncLocalStorage<TraceStore>();

// Once: on a fresh checkout state/logs/ may not exist and a best-effort
// appendFile would silently drop every line.
const LOGS_DIR = `${STATE_DIR}/logs`;
const dirReady = mkdir(LOGS_DIR, { recursive: true }).catch(() => {});

// For events outside any trace: keeps the file ordered when two ISO timestamps
// collide at millisecond resolution.
let globalSeq = 0;

// Computed per write (UTC), so the file rotates daily with no daemon.
function eventsPath() {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${STATE_DIR}/logs/events-${day}.jsonl`;
}

// Truncate long strings for the durable file (/debug keeps them full), marking
// where content was dropped.
export function cap(str: any, n = 4000) {
  if (typeof str !== 'string') return str;
  if (str.length <= n) return str;
  return str.slice(0, n) + `…[+${str.length - n} chars]`;
}

// The active trace store, or null outside any withTrace scope.
export function currentTrace() {
  return als.getStore() || null;
}

// Append one event line; `data` is spread after the envelope fields. Never throws.
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

// Delete event day-files older than `maxAgeDays`; without it the JSONL files are
// the biggest unbounded state-dir growth vector. The horizon is generous — the
// recent-plays backfill needs 2 days, the budget seed today only. Driven by the
// hourly scheduler cleanup; best-effort per file.
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

// Run `fn` inside a fresh trace scope, emitting `trace.start`/`trace.end`.
// Errors are re-thrown unchanged so caller fallback logic still triggers.
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
