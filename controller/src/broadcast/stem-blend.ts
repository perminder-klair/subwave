// Controller side of the pre-rendered seam (docs/stem-transitions-research.md).
// Decides whether an X→Y seam earns a rendered blend, asks the analyzer to mix one
// from cached stems (cache-hit-only), and returns the cue points the drain stamps:
// X cuts at blendStartSec, the clip airs annotated as Y, Y enters at inCueSec.
// Any miss or failure returns null and the seam falls back to the plain pair-aware
// crossfade — this may only upgrade a transition, never break one.

import path from 'node:path';
import { readdir, stat, unlink } from 'node:fs/promises';
import { config } from '../config.js';
import * as settings from '../settings.js';
import * as analyzer from '../music/analyzer.js';
import * as db from '../music/library-db.js';
import * as mix from '../music/mix.js';
import * as loudness from '../music/loudness.js';
import * as stemCache from '../music/stem-cache.js';
import { readPidfile, isPidAlive } from '../music/tagger-lock.js';
import { HARD_DEADLINE_SEC } from './drain-policy.js';

// Cross length at the two clip seams (X→clip, clip→Y): long enough to declick,
// short enough that the rendered mix, not the crossfader, is the transition.
export const CLIP_SEAM_CROSS_SEC = 0.3;

// bpmCompat floor: the beat-carry loop is retriggered on the incoming grid, so
// only near-locked (or clean half/double) tempos read as intentional.
const BPM_COMPAT_MIN = 0.7;

// Only identity fields and loudness inputs are read here.
export type BlendTrack = loudness.LoudnessTrack & {
  title?: string | null;
  gainDb?: number;
};

interface BlendPlan {
  clipPath: string;
  blendStartSec: number; // X's liq_cue_out
  inCueSec: number;      // Y's liq_cue_in
  clipSec: number;
}

function transitionsDir(): string {
  return path.join(config.stateDir, 'transitions');
}

// A bulk pass holds the single-flight analyzer worker for minutes; a render would
// only time out behind it. The pidfile is that pass's own lock.
function bulkPassRunning(): boolean {
  try {
    const info = readPidfile();
    return !!info && isPidAlive(info.pid);
  } catch {
    return false;
  }
}

// bars/outro/lufs are never on the slim track objects, so they resolve from
// library.db here.
export async function maybeRenderBlend(
  outTrack: BlendTrack,
  inTrack: BlendTrack,
  remainingSec: number | null,
  opts: { outCapped?: boolean; outTrimEndSec?: number | null; inHeadTrimmed?: boolean } = {},
): Promise<BlendPlan | null> {
  const s = settings.get();
  if (s?.transitions?.stemBlends !== true) return null;
  if (s?.transitions?.pairDrain === false) return null; // blends ride pair drains
  if (!settings.getEffectivePersona()?.djMode) return null;
  if (!outTrack?.id || !inTrack?.id) return null;
  if (opts.outCapped) return null;      // a capped exit already owns that ending
  // Dead-air trim veto (music/silence-trim.ts). The incoming head is
  // unconditional: the clip is rendered from the successor's head window starting
  // at zero, so a trimmed leading blank would be baked into the seam.
  if (opts.inHeadTrimmed) return null;
  if (bulkPassRunning()) return null;

  const out = db.getTrack(outTrack.id);
  const inn = db.getTrack(inTrack.id);
  if (!out || !inn) return null;
  // Alignment data both sides. The render re-checks all of it; these gates only
  // avoid pointless round-trips.
  if (!out.outro?.bars?.length || !out.durationSec || !inn.bars?.length) return null;
  // A blend always starts at or after the outro wind-down, so a trimmed end
  // at/before it can only cut the clip's source region. Exact test post-render.
  if (opts.outTrimEndSec != null && opts.outTrimEndSec <= (out.outro.startMs ?? 0) / 1000) return null;
  // Tempo gate: near-locked or clean half/double only.
  if (mix.bpmCompat(out.outro.bpm ?? out.bpm, inn.bpm) < BPM_COMPAT_MIN) return null;
  // Cache-hit-only: both windows must already be separated.
  const [haveTail, haveHead] = await Promise.all([
    stemCache.hasWindow(outTrack.id, 'tail'),
    stemCache.hasWindow(inTrack.id, 'head'),
  ]);
  if (!haveTail || !haveHead) return null;

  // The render must lose the race to the drain's hard fallback, so it gets the
  // window to the hard deadline minus a write/stamp margin, capped by the render
  // budget. An unknown clock vetoes outright: the sender is blocked while it runs.
  if (remainingSec == null) return null;
  const windowMs = Math.floor((remainingSec - HARD_DEADLINE_SEC - 5) * 1000);
  if (windowMs < 3000) return null; // too late to even try
  const timeoutMs = Math.min(config.analyzer.renderTimeoutMs, windowMs);

  // Level match (#1240). The clip carries no liq_amplify of its own, so the render
  // bakes in the same dB the station would apply to each side — resolved through
  // music/loudness.ts, never re-derived from the analyzer's LUFS (which ignores
  // ReplayGain tags and both caps). Resolving the incoming side here also caches
  // its ReplayGain answer onto the track object for its own drain.
  const outGainDb = typeof outTrack.gainDb === 'number'
    ? outTrack.gainDb
    : await loudness.resolveGainDb(outTrack);
  const inGainDb = await loudness.resolveGainDb(inTrack);

  const result = await analyzer.renderTransition({
    out: {
      stems_dir: stemCache.dirFor(outTrack.id),
      // Advisory only: the worker aligns the tail window from the stems' own
      // tail-meta.json, and treats stems without that sidecar as a cache miss.
      duration_s: out.durationSec,
      outro: {
        start_ms: out.outro.startMs,
        bars: out.outro.bars,
        lufs: out.outro.lufs ?? null,
      },
      // gain_db is what the worker uses; lufs stays on the wire so an older
      // analyzer image still renders.
      gain_db: outGainDb,
      lufs: out.loudnessLufs ?? null,
    },
    in: {
      stems_dir: stemCache.dirFor(inTrack.id),
      bars: inn.bars,
      gain_db: inGainDb,
      lufs: inn.loudnessLufs ?? null,
    },
    out_dir: transitionsDir(),
    clip_name: `${path.basename(String(outTrack.id))}-${path.basename(String(inTrack.id))}.wav`,
    target_lufs: s?.loudness?.targetLufs ?? -14,
  }, { timeoutMs });
  if (!result) return null;

  // Cue points must sit inside their tracks and leave real audio either side.
  if (!(result.blendStartSec > 10 && result.blendStartSec < out.durationSec)) return null;
  if (!(result.inCueSec > 1 && result.clipSec > 2)) return null;
  // cue_outs arbitrate as earliest-wins, so a trimmed end before the seam would
  // cut the track before the clip's source region ever plays.
  if (opts.outTrimEndSec != null && opts.outTrimEndSec < result.blendStartSec) return null;
  return {
    clipPath: result.path,
    blendStartSec: result.blendStartSec,
    inCueSec: result.inCueSec,
    clipSec: result.clipSec,
  };
}

// Age sweep for orphaned clips. Age alone is not proof: a clip can out-age the
// window behind a long track, so `keep` (queue.pendingClipPaths()) is skipped
// regardless of age.
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
