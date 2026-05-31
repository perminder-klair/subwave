// Acoustic-analysis pass — fills bpm / musical_key / intro_ms for tracks that
// lack them (or were analysed by an older ANALYSIS_VERSION). Resumable and
// batched like the mood tagger: interrupt it and re-run, it picks up where it
// left off. Shared by two entry points — a phase of `npm run tag`
// (music/tag-library.ts) and the standalone `npm run analyze`
// (music/analyze-library.ts) — so the logic lives in exactly one place.
//
// The heavy DSP runs in music/analyzer.ts's backend (tts-heavy sidecar or a
// local librosa venv). When no backend is available this is a clean no-op, so
// it's always safe to call as a tagger phase.

import * as db from './library-db.js';
import * as analyzer from './analyzer.js';

export interface AnalyzeOptions {
  limit?: number;        // cap tracks this run (default: all that need it)
  reAnalyze?: boolean;   // drop existing analysis first, redo everything
}

export interface AnalyzeStats {
  available: boolean;
  backend: string;
  analyzed: number;
  failed: number;
  scope: number;
}

export async function runAnalysisPass(opts: AnalyzeOptions = {}): Promise<AnalyzeStats> {
  if (!(await analyzer.isAvailable())) {
    console.log('[analyze] no analysis backend (tts-heavy sidecar / local librosa venv) — skipping');
    return { available: false, backend: 'none', analyzed: 0, failed: 0, scope: 0 };
  }
  const backend = analyzer.backendLabel();
  console.log(`[analyze] backend: ${backend}`);

  if (opts.reAnalyze) {
    db.clearAnalysis();
    console.log('[analyze] --re-analyze: cleared existing analysis');
  }

  const ids = db.needsAnalysisIds(opts.limit && opts.limit > 0 ? opts.limit : undefined);
  if (ids.length === 0) {
    console.log('[analyze] nothing to analyse — all tracks current');
    return { available: true, backend, analyzed: 0, failed: 0, scope: 0 };
  }
  console.log(`[analyze] ${ids.length} tracks to analyse`);

  let analyzed = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const a = await analyzer.analyze(id);
      db.upsertTrackAnalysis(id, {
        bpm: a.bpm,
        musicalKey: a.musicalKey,
        introMs: a.introMs,
        confidence: a.confidence,
      });
      analyzed += 1;
    } catch (err: any) {
      failed += 1;
      // Leave the row NULL so the next run retries it; don't stamp a version.
      console.error(`[analyze] ${id} failed: ${err?.message || err}`);
    }
    if ((i + 1) % 25 === 0 || i + 1 === ids.length) {
      console.log(`[analyze] ${i + 1}/${ids.length} (ok=${analyzed} fail=${failed})`);
    }
  }

  console.log(`[analyze] done — analyzed=${analyzed} failed=${failed}`);
  return { available: true, backend, analyzed, failed, scope: ids.length };
}
