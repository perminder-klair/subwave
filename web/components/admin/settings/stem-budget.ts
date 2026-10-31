/**
 * What a stem cache budget would delete at the next hourly sweep.
 *
 * The sweep evicts (lowest stem priority first) until the cache fits the
 * budget, so a budget under the measured size deletes about the difference.
 * Sizes come from GET /stem-cache/usage, the controller's stored measurement
 * (never a walk). GB is the controller's unit: 1024³ bytes.
 */
export const GB = 1024 ** 3;

export interface StemUsage {
  bytes: number;
  dirs: number;
  estTrackBytes: number;
  measuredAt?: string;
  updatedAt?: string;
  fresh?: boolean;
  passRunning?: boolean;
}

export interface StemUsageResponse {
  usage: StemUsage | null;
  budgetBytes?: number;
}

export interface StemBudgetImpact {
  deleteBytes: number;
  deleteTracks: number;
  keepTracks: number;
}

/** Null when nothing would be deleted, or nothing is known. */
export function stemBudgetImpact(usage: StemUsage | null | undefined, budgetGb: number): StemBudgetImpact | null {
  if (!usage || !Number.isFinite(budgetGb) || budgetGb <= 0) return null;
  const budget = budgetGb * GB;
  if (usage.bytes <= budget) return null;
  const deleteBytes = usage.bytes - budget;
  const avg = usage.dirs > 0 ? usage.bytes / usage.dirs : usage.estTrackBytes;
  const deleteTracks = Math.min(usage.dirs, Math.max(1, Math.round(deleteBytes / Math.max(1, avg))));
  return { deleteBytes, deleteTracks, keepTracks: Math.max(0, usage.dirs - deleteTracks) };
}

export function fmtGb(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 10) return `${Math.round(gb).toLocaleString('en-GB')} GB`;
  return `${gb.toFixed(1)} GB`;
}

/** "18 Oct 23:02" in the operator's browser zone (an operator surface). */
export function fmtMeasured(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
