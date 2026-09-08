// Which pipeline phases a tagger run executes. Its own module because
// tag-library.ts runs main() on import and can't be test-imported.
//
// A RE-SCAN redoes already-done work for the existing population and must NEVER
// forward-process never-touched tracks: it fires only the selected re-* passes
// and suppresses the forward seed→propagate→active-learn discovery entirely.
// A NORMAL run is a full forward pass minus any deselected steps.

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
