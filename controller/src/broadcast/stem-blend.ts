// Stem-blend transitions (feature: docs/stem-transitions-research.md,
// Option B) — the controller side of the pre-rendered seam. When the pair
// drain is about to send track X with successor Y known, this module decides
// whether the seam earns a rendered blend, asks the analyzer to mix one from
// the cached stems (cache-hit-only, seconds of CPU), and hands back the cue
// points the drain stamps: X cuts at blendStartSec, the clip airs (annotated
// as Y), Y enters at inCueSec. Any miss or failure returns null and the seam
// falls back to the plain pair-aware crossfade — the feature can only ever
// upgrade a transition, never break one.

import path from 'node:path';
import { readdir, stat, unlink } from 'node:fs/promises';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as analyzer from '../music/analyzer.js';
import * as db from '../music/library-db.js';
import * as mix from '../music/mix.js';
import * as stemCache from '../music/stem-cache.js';
import { readPidfile, isPidAlive } from '../music/tagger-lock.js';
import { HARD_DEADLINE_SEC } from './drain-policy.js';

// Cross length at the two clip seams (X→clip, clip→Y). Long enough for a
// clean declick through Liquidsoap's frame-quantised cross, short enough
// that the pre-rendered mix — not the crossfader — is the transition.
export const CLIP_SEAM_CROSS_SEC = 0.3;

// bpmCompat floor for a blend: the beat-carry loop is retriggered on the
// incoming grid, so near-locked (or clean half/double) tempos are required
// for the borrowed groove to read as intentional.
const BPM_COMPAT_MIN = 0.7;

export interface BlendPlan {
  clipPath: string;
  blendStartSec: number; // X's liq_cue_out
  inCueSec: number;      // Y's liq_cue_in
  clipSec: number;
}

function transitionsDir(): string {
  return path.join(config.stateDir, 'transitions');
}

// A bulk tagging/analysis pass holds the single-flight analyzer worker for
// minutes at a time — a render would just time out behind it. Skip stem
// seams while one runs (the pidfile is the pass's own single-flight lock).
function bulkPassRunning(): boolean {
  try {
    const info = readPidfile();
    return !!info && isPidAlive(info.pid);
  } catch {
    return false;
  }
}

// The queue hands in the two queue items' tracks + the live remaining
// seconds; everything else resolves from library.db (bars/outro/lufs are
// never on the slim track objects).
export async function maybeRenderBlend(
  outTrack: { id?: string | null; title?: string | null },
  inTrack: { id?: string | null; title?: string | null },
  remainingSec: number | null,
  opts: { outCapped?: boolean } = {},
): Promise<BlendPlan | null> {
  const s = settings.get();
  if (s?.transitions?.stemBlends !== true) return null;
  if (s?.transitions?.pairDrain === false) return null; // blends ride pair drains
  if (!settings.getEffectivePersona()?.djMode) return null;
  if (!outTrack?.id || !inTrack?.id) return null;
  if (opts.outCapped) return null;      // a capped exit already owns that ending
  if (bulkPassRunning()) return null;

  const out = db.getTrack(outTrack.id);
  const inn = db.getTrack(inTrack.id);
  if (!out || !inn) return null;
  // Alignment data both sides: the outgoing needs a measured tail grid
  // (outro bars) + duration; the incoming a head grid. The render re-checks
  // all of this — these gates just avoid pointless round-trips.
  if (!out.outro?.bars?.length || !out.durationSec || !inn.bars?.length) return null;
  // Tempo gate: near-locked or clean half/double only.
  if (mix.bpmCompat(out.outro.bpm ?? out.bpm, inn.bpm) < BPM_COMPAT_MIN) return null;
  // Cache-hit-only: both windows must already be separated.
  const [haveTail, haveHead] = await Promise.all([
    stemCache.hasWindow(outTrack.id, 'tail'),
    stemCache.hasWindow(inTrack.id, 'head'),
  ]);
  if (!haveTail || !haveHead) return null;

  // The render must lose the race to the drain's hard fallback: give it the
  // window between now and the hard deadline (minus a write/stamp margin),
  // capped by the configured render budget. An UNKNOWN clock (boot/recover,
  // untracked auto play) vetoes the render outright — the sender is blocked
  // while it runs, and with no window to race the boundary could be seconds
  // away; the seam just gets the plain pair-aware crossfade.
  if (remainingSec == null) return null;
  const windowMs = Math.floor((remainingSec - HARD_DEADLINE_SEC - 5) * 1000);
  if (windowMs < 3000) return null; // too late to even try
  const timeoutMs = Math.min(config.analyzer.renderTimeoutMs, windowMs);

  const result = await analyzer.renderTransition({
    out: {
      stems_dir: stemCache.dirFor(outTrack.id),
      // Tagged (integer) duration — advisory only: the worker aligns the tail
      // window from the stems' own tail-meta.json (exact decoded offset), and
      // treats stems without that sidecar as a cache miss.
      duration_s: out.durationSec,
      outro: {
        start_ms: out.outro.startMs,
        bars: out.outro.bars,
        lufs: out.outro.lufs ?? null,
      },
      lufs: out.loudnessLufs ?? null,
    },
    in: {
      stems_dir: stemCache.dirFor(inTrack.id),
      bars: inn.bars,
      lufs: inn.loudnessLufs ?? null,
    },
    out_dir: transitionsDir(),
    clip_name: `${path.basename(String(outTrack.id))}-${path.basename(String(inTrack.id))}.wav`,
    target_lufs: s?.loudness?.targetLufs ?? -14,
  }, { timeoutMs });
  if (!result) return null;

  // Sanity: the cue points must sit inside their tracks and leave real audio
  // on both sides of the seam — a degenerate render is worse than none.
  if (!(result.blendStartSec > 10 && result.blendStartSec < out.durationSec)) return null;
  if (!(result.inCueSec > 1 && result.clipSec > 2)) return null;
  return {
    clipPath: result.path,
    blendStartSec: result.blendStartSec,
    inCueSec: result.inCueSec,
    clipSec: result.clipSec,
  };
}

// Age sweep for rendered clips — a clip left behind by a cancelled pair or a
// crashed drain is an orphan. Age alone isn't proof, though: a clip renders a
// full outgoing-track-length before it airs, so behind a long track (an
// uncapped listener-requested mix) a still-queued clip can out-age the
// window. `keep` is the queue's live set of pending clip basenames
// (queue.pendingClipPaths()) — those are skipped regardless of age.
export async function cleanupOldClips(
  keep: Set<string> = new Set(),
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  let removed = 0;
  try {
    const dir = transitionsDir();
    const now = Date.now();
    for (const f of await readdir(dir)) {
      if (keep.has(f)) continue; // queued for a seam that hasn't aired yet
      try {
        const p = path.join(dir, f);
        const st = await stat(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          await unlink(p);
          removed += 1;
        }
      } catch { /* file vanished mid-sweep */ }
    }
  } catch { /* no transitions dir yet */ }
  return removed;
}
