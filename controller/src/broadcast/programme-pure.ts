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

// The plan's feature for a given show hour. The producer writes one per hour,
// but a degraded/short plan just reuses its last feature rather than going
// silent for the tail hours.
export function planFeature(plan: any, hourIndex: number): { topic: string; kind: string | null } | null {
  const features = plan?.features;
  if (!Array.isArray(features) || !features.length) return null;
  const f = features[Math.min(Math.max(0, hourIndex), features.length - 1)];
  return f?.topic ? { topic: String(f.topic), kind: f.kind ? String(f.kind) : null } : null;
}
