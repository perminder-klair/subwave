// Pure decisions behind "should this link ride a bed, and how long?". The
// mechanism (pushing the bed into dj_queue) lives in broadcast/queue.ts.
// A link beds only when the DJ would outlast the incoming intro; a request intro
// always beds, because the track's opening belongs to whoever asked for it.

export interface BedOpts {
  // Used only when the ramp budget is unknown (see rampBudgetMs).
  thresholdSec: number;
  // The bed's own exit crossfade — how long the next song takes to ramp in.
  crossSec: number;
  // Solo bed between the DJ's last word and that ramp. Optional: BedOpts is
  // `settings.beds` verbatim and a pre-#1485 file has no such key.
  tailSec?: number;
}

export type BedReason = 'link' | 'request';

// Bed alone before the DJ's clip lands, on top of the entry cross. LATENCY, not a
// preference: 1.5s now-playing tick + 0.5s liquidsoap poll, worst case ~2.5s.
export const BED_HEAD_SEC = 2.5;

// Default for `settings.beds.tailSec`: bed alone after the DJ's last word, before
// the next song fades in. Operator range 0..15.
export const BED_TAIL_SEC = 3.0;

// How long the DJ may talk over the start of `track`. Three-state `vocalRanges`:
//   non-empty → earliest startMs is the vocal onset
//   []        → instrumental, nothing to trample: Infinity, never bed
//   null      → not computed: caller falls back to the threshold
// Never introMs: it only equals the onset when Demucs ran in the same pass, and
// otherwise reads ~0 for a full-band opener — firing a bed where the ramp is longest.
export function rampBudgetMs(
  track: { vocalRanges?: { startMs: number }[] | null } | null,
): number | null {
  if (!track) return null;
  const ranges = track.vocalRanges;
  if (ranges == null) return null;              // not computed → unknown
  if (ranges.length === 0) return Infinity;     // instrumental → never bed
  const onset = Math.min(...ranges.map(r => (typeof r?.startMs === 'number' ? r.startMs : NaN)));
  return Number.isFinite(onset) && onset >= 0 ? onset : null;
}

// `voiceMs` is the rendered clip plus lead-in/tail padding (queue.speechDurationMs).
// `budgetMs` is rampBudgetMs() for the incoming track, null when unknown.
export function bedWanted(
  voiceMs: number,
  budgetMs: number | null,
  opts: BedOpts,
  reason: BedReason = 'link',
): boolean {
  if (!Number.isFinite(voiceMs) || voiceMs <= 0) return false;
  // Tested BEFORE the budget on purpose: a request beds even for an instrumental,
  // whose Infinity budget would otherwise veto it.
  if (reason === 'request') return true;
  // Bed exactly when the DJ would outlast the intro; Infinity never is.
  if (budgetMs != null) return voiceMs > budgetMs;
  const thresholdMs = Math.max(0, opts.thresholdSec) * 1000;
  return voiceMs > thresholdMs;
}

// bedSec = entryCross + head + voice + tail + cross.
// `entryCrossSec` is the predecessor's exit canvas: the bed's clock starts when it
// enters that cross buffer, not when it is dominant, so it is dead time the bed
// must carry. The cross is a term too (#1485) — the next song fades in at
// (bedSec - crossSec), so including it makes the audible quiet exactly `tailSec`
// at any crossfade length instead of a residual that goes negative on defaults.
export function bedLengthFor(
  voiceMs: number,
  opts: BedOpts,
  entryCrossSec = 0,
): { bedSec: number; crossSec: number } {
  const crossReq = Math.max(0, opts.crossSec);
  // Absent (pre-#1485 settings file) or unusable → the default.
  const tailSec = Number.isFinite(opts.tailSec) ? Math.max(0, opts.tailSec as number) : BED_TAIL_SEC;
  const bedSec = Math.max(0, entryCrossSec) + BED_HEAD_SEC + voiceMs / 1000 + tailSec + crossReq;
  const crossSec = Math.min(crossReq, bedSec - 1);
  return { bedSec: round2(bedSec), crossSec: round2(crossSec) };
}

// Long enough to be cut to `bedSec`, and not the one that played last. Beds are
// only trimmed shorter (cue_out), never looped. `roll` is 0..1, injected so
// selection is deterministic in tests.
export function pickBed<T extends { name: string; durationSec?: number | null }>(
  beds: T[],
  bedSec: number,
  lastUsed: string | null,
  roll: number,
): T | null {
  // Unknown duration is excluded, not gambled on: a bed running out mid-link
  // drops the DJ into silence.
  const fits = beds.filter(b => typeof b.durationSec === 'number' && b.durationSec >= bedSec);
  if (!fits.length) return null;
  // Avoid an immediate repeat, but never at the cost of airing no bed at all.
  const fresh = fits.filter(b => b.name !== lastUsed);
  const pool = fresh.length ? fresh : fits;
  const i = Math.min(pool.length - 1, Math.floor(clamp01(roll) * pool.length));
  return pool[i];
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
