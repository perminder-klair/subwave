// The full log of one maintenance run (tag, analyze, reconcile): every line,
// numbered, for the Library page's log box, and one file per run under
// state/tagger-logs/ for download (#2063). `tagger.lastLog` stays the short
// tail every snapshot carries; this is what the page reads while the box is open.
//
// A reader asks for the lines after the last seq it saw, so a run that prints
// faster than the poll loses nothing. The page used to re-read a 30-line tail of
// a 100-line buffer every few seconds and never saw what scrolled past between
// two reads, which on a large library was usually the part worth reading. The
// newest RUN_LOG_CAP lines are held in memory; a reader that fell further
// behind is told `gap`, and the file still has them all.
//
// A raw line is held RUN_LOG_HOLD_MS before it is committed, because the child's
// makeEventLogger prints a terse echo just before each [event] sentinel and the
// event replaces it, exactly as lastLog drops it. A held line keeps the time it
// arrived. The log closes on the child's 'close', once its pipes have drained,
// never on 'exit' and never because the next run started, and the page keeps
// reading until the log reports `closed`.
//
// The file name grammar is the safety property, as in backup/pure.ts: retention
// deletes, and the download route opens a file named by the request. Only
// `tagger-run-YYYYMMDD-HHMMSS-<mode>[-N]` is ours to touch, so never widen the
// pattern. A disk that refuses the file, or fails a write, costs the download,
// never the run.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaggerEvent } from '../music/tagger-progress.js';
import type { MaintenanceMode } from './tagger-followups.js';

export type RunLogLine = string | TaggerEvent;

export interface RunLogEntry { seq: number; line: RunLogLine }

export interface RunLogPage {
  runId: string;
  entries: RunLogEntry[];
  nextSeq: number;
  gap: boolean;
  // Every line of the run is in: its child's pipes have closed, which can be
  // after 'exit' has already cleared `running`. A reader polls until this.
  closed: boolean;
}

export interface RunLogSink { write(text: string): void; close(): void }

export interface RunLogFileInfo { id: string; mode: string; startedAt: string; bytes: number }

export const RUN_LOG_CAP = 5000;
export const RUN_LOG_HOLD_MS = 400;
export const RUN_LOG_KEEP = 10;
export const RUN_LOG_DIR_NAME = 'tagger-logs';

const pad2 = (n: number) => String(n).padStart(2, '0');

function hhmmss(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// Newlines break the one-entry-per-line contract on disk.
function oneLine(text: string): string { return text.replace(/\n/g, ' '); }

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
    // Only kind, text and at, as lastLog keeps them: the sentinel is parsed
    // JSON, and any other key it carried would ride into every page.
    this.commitEvent({ kind: ev.kind, text: ev.text, at: ev.at });
  }

  since(after: number): RunLogPage {
    // The cursor comes from a query string: NaN or a negative reads from the
    // start, a fraction floors.
    let a = Number(after);
    if (!Number.isFinite(a) || a < 0) a = 0;
    a = Math.floor(a);

    // A held line no echo claimed in time is the reader's now.
    if (!this.closed && this.pending && this.nowFn() - this.pending.heldAt >= this.holdMs) this.commitPending();

    const filtered = this.entries.filter(e => e.seq > a);
    const firstSeq = filtered.length > 0 ? filtered[0].seq : (this.entries.length > 0 ? this.entries[0].seq : 0);
    const gap = this.everEvicted && this.entries.length > 0 && a < firstSeq - 1;

    // Return defensive copies so callers cannot mutate internal state.
    const entries: RunLogEntry[] = filtered.map(e => ({
      seq: e.seq,
      line: typeof e.line === 'string' ? e.line : { kind: e.line.kind, text: e.line.text, at: e.line.at },
    }));

    return { runId: this.runId, entries, nextSeq: this.seq, gap, closed: this.closed };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.commitPending();
    if (this.sink) {
      try { this.sink.close(); } catch { /* best effort */ }
    }
  }

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
      // Disk is failing—continue in memory only, and give the file back now:
      // close() skips a sink it no longer holds.
      const failed = this.sink;
      this.sink = null;
      try { failed.close(); } catch { /* best effort */ }
    }
  }
}

const MODES = new Set(['tag', 'analyze', 'reconcile']);
// The writer's one name grammar: the UTC start stamp, the mode, and `-N` for
// the Nth run to start within that second. Retention, listing and download
// accept nothing else, so never widen it.
const ID_RE = /^tagger-run-(\d{8})-(\d{6})-(tag|analyze|reconcile)(?:-(\d{1,2}))?$/;
const MAX_SAME_SECOND = 99;

export function runLogId(startedAt: Date, mode: MaintenanceMode, n = 1): string {
  if (!MODES.has(mode)) throw new Error(`unknown run mode: ${mode}`);
  const d = startedAt;
  const ymd = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
  const hms = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return `tagger-run-${ymd}-${hms}-${mode}${n > 1 ? `-${n}` : ''}`;
}

export function isRunLogId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

export function parseRunLogId(id: string): { mode: string; startedAt: string; n: number } | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const [, ymd, hms, mode, n] = m;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}.000Z`;
  return { mode, startedAt: iso, n: n ? Number(n) : 1 };
}

// Newest first: the start stamp, then the count within its second.
function runOrderKey(id: string): string {
  const p = parseRunLogId(id)!;
  return `${p.startedAt}-${String(p.n).padStart(2, '0')}`;
}

// Without the count, a run started in the same second as an earlier one (a
// retry straight after a failed spawn, Stop then Start) gets the same id: it
// appends to that run's file, and a page holding that run's cursor skips the
// new run's head. Counted across modes, so the count also orders a second's
// runs, and against the previous run, whose file may never have opened.
function freeRunLogId(dir: string, startedAt: Date, mode: MaintenanceMode, previousId: string | null): string {
  const first = runLogId(startedAt, mode);
  const second = parseRunLogId(first)!.startedAt;
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { /* no dir yet */ }
  const ids = names.filter(n => n.endsWith('.log')).map(n => n.slice(0, -4));
  if (previousId) ids.push(previousId);
  let taken = 0;
  for (const id of ids) {
    const p = parseRunLogId(id);
    if (p && p.startedAt === second) taken = Math.max(taken, p.n);
  }
  return taken ? runLogId(startedAt, mode, Math.min(taken + 1, MAX_SAME_SECOND)) : first;
}

// A new run's log: its own id, room made for its file (the newest
// RUN_LOG_KEEP - 1 kept, so this one is the tenth), and the file opened. A
// disk that refuses the file costs the download, never the run: the log then
// lives in memory only.
export function openRunLog(dir: string, startedAt: Date, mode: MaintenanceMode, previousId: string | null): RunLog {
  const runId = freeRunLogId(dir, startedAt, mode, previousId);
  pruneRunLogs(dir, RUN_LOG_KEEP - 1);
  return new RunLog({ runId, sink: openRunLogSink(dir, runId) });
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
  results.sort((a, b) => {
    const ka = runOrderKey(a.id), kb = runOrderKey(b.id);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
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
