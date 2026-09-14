// Pure programme-arc helpers. Deliberately import-free.

// Position of the (day, hour) slot inside its show's consecutive run on the
// 7x24 grid: index = hours since the show started, total = the run's length.
// Walks across midnight and the week seam; capped at a week so a grid painted
// wall-to-wall with one show can't loop forever.
export function showSpan(schedule: any, day: number, hour: number): { index: number; total: number } {
  const id = schedule?.[day]?.[hour];
  if (!id) return { index: 0, total: 1 };
  const at = (d: number, h: number) => schedule?.[((d % 7) + 7) % 7]?.[((h % 24) + 24) % 24] ?? null;
  let before = 0;
  for (let i = 1; i < 7 * 24; i++) {
    const h = hour - i;
    if (at(day + Math.floor(h / 24), h) !== id) break;
    before++;
  }
  let after = 0;
  for (let i = 1; i < 7 * 24 - before; i++) {
    const h = hour + i;
    if (at(day + Math.floor(h / 24), h) !== id) break;
    after++;
  }
  return { index: before, total: before + 1 + after };
}

// Episode span for a timed takeover (#930): the override window itself is the
// episode, since a pinned show usually isn't in the grid. Index is clamped
// inside the window so a tick past expiry can't index off the end.
export function overrideSpan(
  ov: { startedAt: number; expiresAt: number },
  nowMs: number,
): { index: number; total: number } {
  const HOUR = 3_600_000;
  const total = Math.max(1, Math.ceil((ov.expiresAt - ov.startedAt) / HOUR));
  const index = Math.min(total - 1, Math.max(0, Math.floor((nowMs - ov.startedAt) / HOUR)));
  return { index, total };
}

// Which beat a STATION-ZONE minute belongs to. Placement is a station-clock
// fact but crons fire on process-local minutes, and station zones sit at
// :30/:45 offsets — so the scheduler ticks on the stride and dispatches on this
// window, which each tick samples exactly once (beat flags make repeats no-ops).
//
// `handoverOffsetMinutes` (#1576) moves the OUTRO window earlier; both windows
// are one stride wide and open on a multiple of it, which is what keeps the
// one-sample-per-window property. Both numbers are REQUIRED, never defaulted,
// so the canonical 5 lives only in the settings default and
// HANDOVER_OFFSET_STEP_MINUTES; the bounds are enforced at the save path, since
// this file stays import-free. Outro is tested first, so a bound that ever let
// the windows meet closes the show rather than repeating its middle.
export function beatWindow(
  stationMinute: number,
  handoverOffsetMinutes: number,
  sampleStrideMinutes: number,
): 'feature' | 'outro' | null {
  const outroOpens = 60 - handoverOffsetMinutes;
  if (stationMinute >= outroOpens && stationMinute < outroOpens + sampleStrideMinutes) return 'outro';
  if (stationMinute >= 35 && stationMinute < 40) return 'feature';
  return null;
}

// The plan's feature for a show hour. A short plan reuses its last feature
// rather than going silent for the tail hours.
export function planFeature(plan: any, hourIndex: number): { topic: string; kind: string | null } | null {
  const features = plan?.features;
  if (!Array.isArray(features) || !features.length) return null;
  const f = features[Math.min(Math.max(0, hourIndex), features.length - 1)];
  return f?.topic ? { topic: String(f.topic), kind: f.kind ? String(f.kind) : null } : null;
}
