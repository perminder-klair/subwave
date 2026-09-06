// Pure programme-arc helpers — no imports, unit-tested in
// scripts/programme.test.ts (same seam pattern as auto-pool.ts). The episode
// runner (broadcast/programme.ts) is the only production consumer.

// Position of the (day, hour) slot inside its show's consecutive run on the
// 7×24 schedule grid: index = hours since the show started, total = the run's
// length. Walks across midnight and the week seam; capped at a full week so a
// grid painted wall-to-wall with one show can't loop forever.
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

// Episode span for a timed takeover (#930). A pinned show usually isn't in the
// grid at the pinned hours, so showSpan can't see it — the override window
// itself is the episode: total = the window rounded up to whole hours, index =
// whole hours elapsed since the pin (clamped inside the window, so a tick
// arriving fractionally past expiry can't index off the end).
export function overrideSpan(
  ov: { startedAt: number; expiresAt: number },
  nowMs: number,
): { index: number; total: number } {
  const HOUR = 3_600_000;
  const total = Math.max(1, Math.ceil((ov.expiresAt - ov.startedAt) / HOUR));
  const index = Math.min(total - 1, Math.max(0, Math.floor((nowMs - ov.startedAt) / HOUR)));
  return { index, total };
}

// Which beat a STATION-ZONE minute belongs to. The arc's placement is a
// station-clock fact (the sign-off must land in the show's closing minutes),
// but crons fire on fixed process-local minutes — and station zones sit at
// :30/:45 offsets (IST, Nepal), so a process-minute :55 cron can land mid-show
// on the station clock. The scheduler therefore ticks every 5 minutes and
// dispatches on this window instead: offsets are multiples of 15, so a 5-minute
// cadence always lands inside each 5-minute station window exactly once (the
// beat flags make repeats no-ops).
//
// `handoverOffsetMinutes` (#1576) moves the OUTRO window earlier in the hour —
// 5 puts it at :55–:59, exactly where it has always been. Both windows are one
// sampling stride wide and open on a multiple of it, which is what keeps that
// one-sample-per-window property true for any offset; the constraint is
// enforced where the operator sets the value (HANDOVER_OFFSET_BOUNDS and
// HANDOVER_OFFSET_STEP_MINUTES in schemas/settings.ts), not here, because this
// file stays import-free.
//
// BOTH numbers are REQUIRED rather than defaulted, so the canonical 5 lives in
// exactly one place each — the settings default for the offset,
// HANDOVER_OFFSET_STEP_MINUTES for the stride — and this file cannot drift from
// either. A default here would be a second copy of the very constant the stride
// import in talk-scheduler.ts exists to stop being copied. The outro is tested
// first: the bound keeps the moved window clear of the feature at :35–:39
// (pinned by scripts/handover-timing.test.ts, since this file cannot import the
// bound to assert it against), and if a future bound ever let them meet,
// closing the show beats repeating its middle.
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

// The plan's feature for a given show hour. The producer writes one per hour,
// but a degraded/short plan just reuses its last feature rather than going
// silent for the tail hours.
export function planFeature(plan: any, hourIndex: number): { topic: string; kind: string | null } | null {
  const features = plan?.features;
  if (!Array.isArray(features) || !features.length) return null;
  const f = features[Math.min(Math.max(0, hourIndex), features.length - 1)];
  return f?.topic ? { topic: String(f.topic), kind: f.kind ? String(f.kind) : null } : null;
}
