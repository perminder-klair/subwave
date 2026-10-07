// Coverage status combines enablement, backend capability, and existing coverage. Check
// capability and coverage before the enable gate so disabled dimensions still show existing
// data and engine requirements. scripts/coverage-status.test.ts..
export type DimensionStatus =
  | 'off'
  | 'pending-engine'
  | 'pending-heavy'
  | 'load-failed'
  | 'incapable'
  | 'ready'
  | 'partial'
  | 'complete';

export interface DimensionInputs {
  // Operator wants this dimension (env force OR the admin toggle).
  enabled: boolean;
  // Analysis backend reachable. null = still probing, which is not treated as
  // down.
  analysisAvailable: boolean | null;
  // Backend can emit THIS dimension. false = lean image; null = unknown (older
  // sidecar that doesn't advertise).
  capable: boolean | null;
  // Why `capable` is false when the model is INSTALLED and failed to load. null
  // in every other case, a lean image included.
  loadError?: string | null;
  // Tracks through the always-on bpm/key pass: evidence the engine processed
  // audio at all, which is what tells "starved" from "not run yet".
  analysed: number;
  // Covered tracks for THIS dimension.
  count: number;
  // Coverage against the library total, or null when that total isn't known.
  percent: number | null;
}

export function dimensionStatus(x: DimensionInputs): DimensionStatus {
  // Gated on enable, so a disabled dimension on a downed engine reads 'off'.
  if (x.enabled && x.analysisAvailable === false) return 'pending-engine';
  // Installed but broken, checked ahead of the lean-image case it is otherwise
  // indistinguishable from. Enable-independent, as is pending-heavy.
  if (x.capable === false && x.loadError) return 'load-failed';
  if (x.capable === false) return 'pending-heavy';
  // Existing coverage wins over "not run yet", so a paused-with-data dimension
  // still shows its numbers.
  if (x.count > 0) return x.percent != null && x.percent >= 100 ? 'complete' : 'partial';
  // Starved: bpm/key ran, this dimension got nothing, and the backend won't say
  // whether it can. Enable-independent.
  if (x.capable == null && x.analysed > 0) return 'incapable';
  if (!x.enabled) return 'off';
  return 'ready';
}

// Whether a backfill would make sense IF the dimension is enabled: headroom to
// fill and no hard block. True for 'off' too, because the panel ANDs this with
// the optimistic enable prop so the button appears the instant Enable is
// flipped, ahead of the next /coverage poll. 'incapable' is offered so the
// operator can try.
export function isBackfillable(status: DimensionStatus): boolean {
  return (
    status !== 'pending-heavy' &&
    status !== 'load-failed' &&
    status !== 'pending-engine' &&
    status !== 'complete'
  );
}
