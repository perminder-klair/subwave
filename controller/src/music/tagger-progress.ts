// Structured progress channel from the tagger/analyzer children: one sentinel
// line per update on stdout, parsed by broadcast/tagger.ts into `tagger.progress`.
// Dependency-free so both the CLI scripts and the server can import it.
export const PROGRESS_PREFIX = '[progress] ';

export type TaggerPhase =
  | 'walk'
  | 'enrich'
  | 'embed'
  | 'seed'
  | 'propagate'
  | 'learn'
  | 'analyze'
  | 'done';

export interface TaggerProgress {
  phase: TaggerPhase;
  // Authored here so the UI needs no phase->label map.
  label: string;
  done?: number;
  // Absent total = indeterminate (the Navidrome walk reports no count up front).
  total?: number;
  // Active-learning round (phase 'learn' only).
  round?: number;
  // Cumulative failures within the current phase.
  errors?: number;
  // Per-leg tagged counts when dual-LLM mode is draining the batch queue.
  llm?: { legs: Record<string, number> };
  // Cumulative wall-clock per phase in ms. Attached to the terminal 'done' event
  // only; absent on in-flight events.
  timings?: Record<string, number>;
  updatedAt: string;
}

export function reportProgress(p: Omit<TaggerProgress, 'updatedAt'>): void {
  console.log(PROGRESS_PREFIX + JSON.stringify({ ...p, updatedAt: new Date().toISOString() }));
}

// Second sentinel channel: discrete typed status events, so the panel renders by
// kind instead of regex-scraping log lines (a song title containing "failed" used
// to read as a failure).
export const EVENT_PREFIX = '[event] ';

export type TaggerEventKind = 'info' | 'success' | 'warning' | 'error';

export interface TaggerEvent {
  kind: TaggerEventKind;
  // Operator-facing sentence, composed at the call site.
  text: string;
  at: string;
}

export function reportEvent(e: Omit<TaggerEvent, 'at'>): void {
  console.log(EVENT_PREFIX + JSON.stringify({ ...e, at: new Date().toISOString() }));
}

// Emits both the terse `[tag] …` line (greppable in docker logs) and the event
// sentinel, back-to-back, so the capture side can drop the plain echo.
export function makeEventLogger(prefix: string) {
  return (kind: TaggerEventKind, text: string): void => {
    // Collapse newlines: a multi-line echo defeats the controller's de-dup.
    const line = text.replace(/\s*\n\s*/g, ' ');
    console.log(`[${prefix}] ${line}`);
    reportEvent({ kind, text: line });
  };
}

// Slowest-first, zero-duration phases dropped. Shared by the CLI breakdown line
// and the 'done' event's `timings` so the two can't drift.
export function sortedPhaseTimings(timings: Record<string, number>): Array<[string, number]> {
  return Object.entries(timings)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1]);
}

// e.g. "seed 480s · learn 360s · embed 120s"; '' when nothing was timed.
export function formatPhaseBreakdown(timings: Record<string, number>): string {
  return sortedPhaseTimings(timings)
    .map(([p, ms]) => `${p} ${Math.round(ms / 1000)}s`)
    .join(' · ');
}
