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
  updatedAt: string;
}

export function reportProgress(p: Omit<TaggerProgress, 'updatedAt'>): void {
  console.log(PROGRESS_PREFIX + JSON.stringify({ ...p, updatedAt: new Date().toISOString() }));
}
