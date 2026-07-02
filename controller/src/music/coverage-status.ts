// Pure decision for an opt-in analysis dimension's coverage status. Both CLAP
// "sounds-like" (audio) and Demucs vocal-activity coverage collapse the same
// four nullable signals — enabled, backend reachable, backend capable, how much
// is actually covered — into one status the UI (and, soon, the native app) can
// render without re-deriving. Side-effect-free so it can be unit-pinned
// (scripts/coverage-status.test.ts).
//
// The seven states, and the legacy /admin/library conditionals they replace:
//   off            dimension disabled, nothing to say (paused-with-data reads as
//                  partial/complete instead — existing coverage still shows).
//   pending-engine enabled but NO analysis backend reachable at all.
//   pending-heavy  backend up but reports it CAN'T do this dimension (lean image
//                  without CLAP/Demucs) — today's `*Incapable`. Reported even
//                  when disabled so a lean-engine row can say "off · needs the
//                  heavy analyzer"; the panel pairs it with the (optimistic)
//                  enable to pick "waiting…" vs "off · needs…" wording.
//   incapable      backend up, capability UNKNOWN (older sidecar that doesn't
//                  advertise), the bpm/key pass HAS run yet produced zero here —
//                  today's `*Starved`. Also enable-independent for the same
//                  reason; the panel gates the wording on enable.
//   ready          enabled + able (or ability unknown with no evidence), nothing
//                  covered yet.
//   partial        some coverage, < 100%.
//   complete       100%.
//
// PRECEDENCE NOTE — this intentionally widens the "enabled but…" framing: the
// capability facts (pending-heavy / incapable) and existing coverage
// (partial / complete) are surfaced BEFORE the enable gate, because the panel
// must reproduce "off · needs the heavy analyzer" (a disabled row on a lean
// engine) and must keep showing numbers for a paused-but-populated dimension.
// `off` is therefore the FALLBACK (disabled with nothing else to report), not an
// early short-circuit — so every legacy string maps to exactly one enum case.
export type DimensionStatus =
  | 'off'
  | 'pending-engine'
  | 'pending-heavy'
  | 'incapable'
  | 'ready'
  | 'partial'
  | 'complete';

export interface DimensionInputs {
  // Operator wants this dimension (env force OR the admin toggle).
  enabled: boolean;
  // Analysis backend reachable at all. null = still probing (treated as "not
  // definitively down" — we don't jump to pending-engine on an unknown).
  analysisAvailable: boolean | null;
  // Backend can emit THIS dimension. false = lean image; null = unknown (older
  // sidecar that doesn't advertise).
  capable: boolean | null;
  // Tracks through the always-on bpm/key pass — the evidence that the engine has
  // actually processed audio (used to tell "starved" from "not run yet").
  analysed: number;
  // Covered tracks for THIS dimension.
  count: number;
  // Coverage percent for this dimension against the library total, or null when
  // the library total isn't known yet.
  percent: number | null;
}

export function dimensionStatus(x: DimensionInputs): DimensionStatus {
  // Engine down while wanted — nothing can progress until it's back. Gated on
  // enable so a disabled dimension on a downed engine reads as plain 'off'.
  if (x.enabled && x.analysisAvailable === false) return 'pending-engine';
  // Hard capability gap (lean image). Enable-independent (see PRECEDENCE NOTE).
  if (x.capable === false) return 'pending-heavy';
  // Existing coverage wins over "not run yet" so a paused-with-data dimension
  // still shows its numbers.
  if (x.count > 0) return x.percent != null && x.percent >= 100 ? 'complete' : 'partial';
  // Starved: the bpm/key pass ran but this dimension got nothing and the backend
  // won't say whether it can (an older sidecar). Enable-independent.
  if (x.capable == null && x.analysed > 0) return 'incapable';
  // Nothing covered, no capability problem: disabled → off, enabled → ready.
  if (!x.enabled) return 'off';
  return 'ready';
}

// Whether a backfill/analyze action would make sense IF the dimension is enabled
// — there's headroom to fill and no hard block (a lean/downed engine, or already
// 100%). Returns true for the disabled-with-headroom case ('off') too, because
// the panel ANDs this with the OPTIMISTIC enable prop so the button appears the
// instant the operator flips Enable, ahead of the next /coverage poll that would
// move the enum off 'off'. Matches today's gate, which likewise still offers the
// action on the unknown 'incapable' case so the operator can try.
export function isBackfillable(status: DimensionStatus): boolean {
  return status !== 'pending-heavy' && status !== 'pending-engine' && status !== 'complete';
}
