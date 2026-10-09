// Rescans rerun selected phases only for previously processed tracks. Normal runs process new
// tracks through enabled phases.

export interface RunFlags {
  rescan: boolean;
  // Re-scan pass selections (only consulted when rescan === true).
  reseed: boolean;
  reEnrich: boolean;
  reAnalyze: boolean;
  upgrade: boolean;
  // Forward-run step deselections (only consulted when rescan === false).
  skipEnrich: boolean;
  skipTag: boolean;
  skipAnalyze: boolean;
}

export interface PhasePlan {
  // Phase 0 — fetch Last.fm tags + lyrics.
  enrich: boolean;
  // Phases 1-4 — embed → seed → propagate → active-learn over UNTAGGED tracks.
  // The forward-discovery path that grows coverage; off for every re-scan.
  forwardTag: boolean;
  // Re-scan only: drop + rebuild vectors for the already-embedded set.
  reEmbed: boolean;
  // Re-scan only: re-LLM-tag tagged rows whose prompt/model went stale.
  reDecide: boolean;
  // Phase 5 — acoustic bpm/key (+ optional CLAP / Demucs).
  analyze: boolean;
}

export function planRun(f: RunFlags): PhasePlan {
  if (f.rescan) {
    return {
      enrich: f.reEnrich,
      forwardTag: false,
      reEmbed: f.reseed,
      reDecide: f.upgrade,
      analyze: f.reAnalyze,
    };
  }
  return {
    enrich: !f.skipEnrich,
    forwardTag: !f.skipTag,
    reEmbed: false,
    reDecide: false,
    analyze: !f.skipAnalyze,
  };
}
