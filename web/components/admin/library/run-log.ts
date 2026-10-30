// The Library page's run-log merge: pure, so it is tested without React.
import type { TaggerEvent } from '../LibraryTaggingPanel';

export type RunLogLine = string | TaggerEvent;
export interface RunLogEntry { seq: number; line: RunLogLine }
export interface RunLogPage { runId: string; entries: RunLogEntry[]; nextSeq: number; gap: boolean; closed: boolean }
export interface RunLogFileInfo { id: string; mode: string; startedAt: string; bytes: number }

// What the page holds for the current run: every line fetched so far.
export interface RunLogView {
  runId: string;
  entries: RunLogEntry[];
  nextSeq: number;
  // Lines were dropped before this page saw them (the controller keeps the
  // newest 5000 in memory); the file download has them all.
  gap: boolean;
  // The controller has every line of this run: its child's pipes closed,
  // which can be after the snapshot already shows the run as finished.
  closed: boolean;
}

// The browser keeps as many lines as the controller does, so a long run never
// grows the page without bound.
const CLIENT_CAP = 5000;

// Merge one page into what the page already holds. A page from another run
// replaces it; a page of the same run appends.
export function mergeRunLog(prev: RunLogView | null | undefined, page: RunLogPage): RunLogView {
  const same = prev && prev.runId === page.runId;
  const base = same ? prev.entries : [];
  const lastSeq = same ? prev.nextSeq : 0;
  const fresh = page.entries.filter(e => e.seq > lastSeq);
  const all = base.concat(fresh);
  const dropped = all.length > CLIENT_CAP;
  return {
    runId: page.runId,
    entries: dropped ? all.slice(-CLIENT_CAP) : all,
    nextSeq: Math.max(lastSeq, page.nextSeq),
    gap: (same ? prev.gap : false) || page.gap || dropped,
    closed: page.closed,
  };
}

// The controller holds no run log (it restarted): nothing more will arrive
// for what the page holds, so it reads as closed and the polling stops.
export function orphanRunLog(prev: RunLogView | null | undefined): RunLogView | null {
  return prev ? { ...prev, closed: true } : null;
}
