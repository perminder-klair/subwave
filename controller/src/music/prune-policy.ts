// When a library walk may delete the tracks it did not see (pure; pinned by
// scripts/prune-policy.test.ts).
//
// A complete walk proves which ids Navidrome serves NOW, not that the missing
// ones are gone for good. The common way to lose most of a library in one
// walk is an unmounted music folder: Navidrome rescans, its albums vanish, and
// the next reconcile deletes their rows, which takes every tag, analysis,
// vector and play record with them. Nothing brings those back except
// re-tagging and re-analysing from scratch. So:
// - while Navidrome reports a scan in progress, nothing is pruned (its
//   catalogue is mid-change);
// - a prune larger than max(PRUNE_HOLD_MIN_TRACKS, PRUNE_HOLD_FRACTION of the
//   library) is HELD until the operator confirms it (--confirm-prune);
// - anything smaller prunes as before: albums do get deleted.
// Id rotation is adopted BEFORE this decision (music/id-rotation.ts), so a
// re-minted catalogue does not count as missing.

export const PRUNE_HOLD_MIN_TRACKS = 200;
export const PRUNE_HOLD_FRACTION = 0.02;

export type PruneDecision =
  | { prune: true }
  | { prune: false; reason: 'scanning' | 'mass-loss'; message: string };

export function pruneHoldThreshold(knownTracks: number): number {
  return Math.max(PRUNE_HOLD_MIN_TRACKS, Math.ceil(knownTracks * PRUNE_HOLD_FRACTION));
}

export function decidePrune(opts: {
  // Rows the walk did not see (after id adoption).
  missing: number;
  // Rows in the library before the prune.
  knownTracks: number;
  // Navidrome's getScanStatus; null = unknown (the call failed).
  scanning: boolean | null;
  // The operator confirmed a mass prune for this run.
  confirmed: boolean;
}): PruneDecision {
  if (opts.missing <= 0) return { prune: true };
  if (opts.scanning === true) {
    return {
      prune: false,
      reason: 'scanning',
      message: `Navidrome is scanning its library, so the ${opts.missing.toLocaleString('en-GB')} tracks this walk did not see were kept; the next walk after the scan decides`,
    };
  }
  const threshold = pruneHoldThreshold(opts.knownTracks);
  if (opts.missing > threshold && !opts.confirmed) {
    return {
      prune: false,
      reason: 'mass-loss',
      message:
        `${opts.missing.toLocaleString('en-GB')} of ${opts.knownTracks.toLocaleString('en-GB')} library tracks are missing from Navidrome ` +
        `(more than the ${threshold.toLocaleString('en-GB')} a walk may remove on its own). Removal is on hold: ` +
        'if a music folder or share is not mounted, mount it and run the walk again. ' +
        'If the tracks were really deleted, run the reconcile with --confirm-prune.',
    };
  }
  return { prune: true };
}
