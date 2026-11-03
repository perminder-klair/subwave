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
  /** An orphan pass changed the cache since this was measured. */
  stale?: boolean;
}

export interface StemUsageResponse {
  usage: StemUsage | null;
  budgetBytes?: number;
  /** Sent only while pick-time stems is on: how far over `budgetBytes` the cache may run by design. */
  pickTimeOvershootBytes?: number;
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

/**
 * How far pick-time stems has taken the cache over the budget in force, when
 * that is within the overshoot it is allowed by design. The next hourly sweep
 * trims it, so the budget field says so instead of warning. Null when the
 * feature is off (no `pickTimeOvershootBytes`), when the budget being typed is
 * not the one in force (a cut deletes stems, and keeps the warning), or when
 * the cache is past the designed overshoot (that is a fault).
 */
export function pickTimeOvershoot(resp: StemUsageResponse | null | undefined, budgetGb: number): number | null {
  const usage = resp?.usage;
  const allowed = resp?.pickTimeOvershootBytes;
  const inForce = resp?.budgetBytes;
  if (!usage || typeof allowed !== 'number' || typeof inForce !== 'number') return null;
  if (!Number.isFinite(budgetGb) || budgetGb * GB !== inForce) return null;
  const over = usage.bytes - inForce;
  return over > 0 && over <= allowed ? over : null;
}

/** Why a stored figure is not the sweep's own, for the "measured" note. */
export function usageCaveat(usage: StemUsage): string {
  if (usage.fresh) return '';
  if (usage.passRunning) return ', analysis pass adding more';
  if (usage.stale) return ', a cleanup pass has run since';
  return ', over a day old';
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
