import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaggerEvent } from '../music/tagger-progress.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RunLogLine = string | TaggerEvent;

export interface RunLogEntry { seq: number; line: RunLogLine }

export interface RunLogPage {
  runId: string;
  entries: RunLogEntry[];
  nextSeq: number;
  gap: boolean;
}

export interface RunLogSink { write(text: string): void; close(): void }

export interface RunLogFileInfo { id: string; mode: string; startedAt: string; bytes: number }

// ─── Constants ────────────────────────────────────────────────────────────────

export const RUN_LOG_CAP = 5000;
export const RUN_LOG_HOLD_MS = 400;
export const RUN_LOG_KEEP = 10;
export const RUN_LOG_DIR_NAME = 'tagger-logs';

// ─── Helpers (internal) ───────────────────────────────────────────────────────

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Newlines break the one-entry-per-line contract on disk.
function oneLine(text: string): string { return text.replace(/\n/g, ' '); }

// ─── RunLog class ─────────────────────────────────────────────────────────────

export class RunLog {
  readonly runId: string;

  private readonly cap: number;
  private readonly holdMs: number;
  private readonly nowFn: () => number;
  private sink: RunLogSink | null;

  private entries: RunLogEntry[] = [];
  private seq = 0;            // last committed seq (starts at 0, first commit → 1)
  private everEvicted = false;
  private closed = false;

  // Pending raw line: held back so we can drop it if an event echo follows.
  private pending: { line: string; heldAt: number } | null = null;

  constructor(opts: {
    runId: string;
    cap?: number;
    sink?: RunLogSink | null;
    now?: () => number;
    holdMs?: number;
  }) {
    this.runId = opts.runId;
    this.cap = opts.cap ?? RUN_LOG_CAP;
    this.sink = opts.sink ?? null;
    this.nowFn = opts.now ?? Date.now;
    this.holdMs = opts.holdMs ?? RUN_LOG_HOLD_MS;
  }

  raw(line: string): void {
    if (this.closed) return;
    // Flush previous pending before parking the new one.
    this.commitPending();
    this.pending = { line, heldAt: this.nowFn() };
  }

  event(ev: TaggerEvent, isEcho: (raw: string) => boolean): void {
    if (this.closed) return;
    // The raw echo duplicates the event—drop it silently.
    if (this.pending && isEcho(this.pending.line)) this.pending = null;
    else this.commitPending();
    // Commit exactly {kind, text, at}.
    this.commitEvent({ kind: ev.kind, text: ev.text, at: ev.at });
  }

  since(after: number): RunLogPage {
    // Sanitise the cursor.
    let a = Number(after);
    if (!Number.isFinite(a) || a < 0) a = 0;
    a = Math.floor(a);

    // Commit pending if it's been held long enough.
    if (!this.closed && this.pending && this.nowFn() - this.pending.heldAt >= this.holdMs) this.commitPending();

    const filtered = this.entries.filter(e => e.seq > a);
    const firstSeq = filtered.length > 0 ? filtered[0].seq : (this.entries.length > 0 ? this.entries[0].seq : 0);
    const gap = this.everEvicted && this.entries.length > 0 && a < firstSeq - 1;

    // Return defensive copies so callers cannot mutate internal state.
    const entries: RunLogEntry[] = filtered.map(e => ({
      seq: e.seq,
      line: typeof e.line === 'string' ? e.line : { kind: e.line.kind, text: e.line.text, at: e.line.at },
    }));

    return { runId: this.runId, entries, nextSeq: this.seq, gap };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.commitPending();
    if (this.sink) {
      try { this.sink.close(); } catch { /* best effort */ }
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  // A held line is stamped with when it arrived, not when it was committed:
  // with nobody polling, the next line is what commits it, and that can be
  // minutes later when the step in between is a slow one.
  private commitPending(): void {
    if (!this.pending) return;
    const { line, heldAt } = this.pending;
    this.pending = null;
    this.push({ seq: ++this.seq, line });
    this.writeToSink(`${hhmmss(heldAt)}  ${oneLine(line)}\n`);
  }

  private commitEvent(ev: TaggerEvent): void {
    this.push({ seq: ++this.seq, line: ev });
    const ts = Number.isNaN(Date.parse(ev.at)) ? this.nowFn() : Date.parse(ev.at);
    this.writeToSink(`${hhmmss(ts)}  [${ev.kind}] ${oneLine(ev.text)}\n`);
  }

  private push(entry: RunLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      const excess = this.entries.length - this.cap;
      this.entries.splice(0, excess);
      this.everEvicted = true;
    }
  }

  private writeToSink(text: string): void {
    if (!this.sink) return;
    try {
      this.sink.write(text);
    } catch {
      // Disk is failing—continue in memory only.
      this.sink = null;
    }
  }
}

// ─── File helpers ─────────────────────────────────────────────────────────────

const MODES = new Set(['tag', 'analyze', 'reconcile']);
const ID_RE = /^tagger-run-(\d{8})-(\d{6})-(tag|analyze|reconcile)$/;

export function runLogId(startedAt: Date, mode: string): string {
  if (!MODES.has(mode)) throw new Error(`unknown run mode: ${mode}`);
  const y = startedAt.getUTCFullYear();
  const mo = String(startedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startedAt.getUTCDate()).padStart(2, '0');
  const h = String(startedAt.getUTCHours()).padStart(2, '0');
  const mi = String(startedAt.getUTCMinutes()).padStart(2, '0');
  const s = String(startedAt.getUTCSeconds()).padStart(2, '0');
  return `tagger-run-${y}${mo}${d}-${h}${mi}${s}-${mode}`;
}

export function isRunLogId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function parseRunLogId(id: string): { mode: string; startedAt: string } | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const [, ymd, hms, mode] = m;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}.000Z`;
  return { mode, startedAt: iso };
}

export function openRunLogSink(dir: string, id: string): RunLogSink | null {
  if (!isRunLogId(id)) return null;
  let fd: number;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(path.join(dir, `${id}.log`), 'a');
  } catch {
    return null;
  }
  let isClosed = false;
  return {
    write(text: string): void {
      if (!isClosed) fs.writeSync(fd, text);
    },
    close(): void {
      if (isClosed) return;
      isClosed = true;
      try { fs.closeSync(fd); } catch { /* already gone */ }
    },
  };
}

export function listRunLogs(dir: string): RunLogFileInfo[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }

  const results: RunLogFileInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const id = name.slice(0, -4); // strip '.log'
    if (!isRunLogId(id)) continue;
    const parsed = parseRunLogId(id)!;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile()) continue;
      results.push({ id, mode: parsed.mode, startedAt: parsed.startedAt, bytes: stat.size });
    } catch { /* skip unreadable */ }
  }
  // Timestamp-encoded ids sort lexicographically = chronologically.
  results.sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
  return results;
}

export function runLogPath(dir: string, id: unknown): string | null {
  if (!isRunLogId(id)) return null;
  const p = path.join(dir, `${id}.log`);
  try {
    if (fs.statSync(p).isFile()) return p;
  } catch { /* missing */ }
  return null;
}

export function pruneRunLogs(dir: string, keep: number = RUN_LOG_KEEP): number {
  const k = Math.max(0, keep);
  const all = listRunLogs(dir); // newest first
  if (all.length <= k) return 0;
  let deleted = 0;
  for (const info of all.slice(k)) {
    try {
      fs.unlinkSync(path.join(dir, `${info.id}.log`));
      deleted++;
    } catch { /* skip */ }
  }
  return deleted;
}
