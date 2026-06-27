// Structured progress channel between the tagger/analyzer child processes and
// the controller. The children print one sentinel line per update on stdout;
// broadcast/tagger.ts parses it into `tagger.progress` (and keeps it out of
// lastLog). Dependency-free on purpose — imported by both CLI scripts and the
// server.
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
  // Human-friendly line authored here (single source of truth) so the UI
  // needs no phase→label map.
  label: string;
  done?: number;
  // Absent total → indeterminate (e.g. the Navidrome walk, which doesn't
  // pre-report a count).
  total?: number;
  // Active-learning round (phase 'learn' only).
  round?: number;
  // Cumulative failures within the current phase.
  errors?: number;
  // Per-leg tagged counts when dual-LLM mode is draining the batch queue.
  llm?: { legs: Record<string, number> };
  // Cumulative wall-clock per phase, in milliseconds (e.g. { enrich: 12000,
  // embed: 40000 }). Attached to the terminal 'done' event so the operator can
  // see where a slow run actually spent its time (the chat-model tagging phases
  // usually dominate, not embeddings). Absent on in-flight events.
  timings?: Record<string, number>;
  updatedAt: string;
}

export function reportProgress(p: Omit<TaggerProgress, 'updatedAt'>): void {
  console.log(PROGRESS_PREFIX + JSON.stringify({ ...p, updatedAt: new Date().toISOString() }));
}

// Phase timings sorted slowest-first, with zero-duration phases dropped. The
// shared shape behind both the CLI breakdown line and the 'done' event's
// `timings` field, so the two can't drift. Pure — unit-pinned.
export function sortedPhaseTimings(timings: Record<string, number>): Array<[string, number]> {
  return Object.entries(timings)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1]);
}

// One-line, slowest-first phase breakdown for the tagger CLI log, e.g.
// "seed 480s · learn 360s · embed 120s". '' when nothing was timed.
export function formatPhaseBreakdown(timings: Record<string, number>): string {
  return sortedPhaseTimings(timings)
    .map(([p, ms]) => `${p} ${Math.round(ms / 1000)}s`)
    .join(' · ');
}
