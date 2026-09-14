// The seed-vs-pick rule, plus classification of an agent pick whose id no tool
// surfaced (#1247). Every pick event hands the agent the ON-AIR track's id to
// seed discovery, and the tools exclude it from their results, so it is the one
// well-formed id in context that no tool returned — the most available wrong
// answer when a model is cornered.
//
// Policy chokepoint: the clause below is the ONE wording, shared by the
// pick/request schema field descriptions and the empty-tool-result rule the
// model sees. Never inline a second copy.
export const SEED_NOT_A_PICK_CLAUSE =
  'The track already playing is only the SEED you pass to the discovery tools — its id is never a valid answer, even when a tool comes back empty.';

export type PickFailureKind = 'no-candidates' | 'no-discovery' | 'seed-echo' | 'unknown-id';

export interface PickFailure {
  kind: PickFailureKind;
  // Operator-facing booth-log cause. No trailing "falling back to pool" — the
  // call site adds that.
  message: string;
  // Only true when the failure is evidence the model can't drive the tool-loop
  // harness. A run that surfaced zero candidates is a library-coverage problem,
  // so it must not open the breaker.
  countsAgainstBreaker: boolean;
}

export function classifyPickFailure(
  { pickedId, seedId, candidates, toolCalls }:
  { pickedId: string | null; seedId: string | null; candidates: number; toolCalls: number },
): PickFailure {
  const echoed = !!pickedId && !!seedId && pickedId === seedId;

  // `toolCalls` counts real discovery calls (the synthetic `done` is excluded),
  // so zero means the model never explored: a harness failure, not a coverage
  // one, and it must count against the breaker.
  if (candidates === 0 && toolCalls === 0) {
    return {
      kind: 'no-discovery',
      message: 'agent made no discovery call at all, so its answer could not come from any tool — the configured model may not drive tool calls',
      countsAgainstBreaker: true,
    };
  }

  // Zero candidates after real discovery: both salvage stages need a non-empty
  // `seen`, so the run was lost when discovery came back empty (#1247).
  if (candidates === 0) {
    return {
      kind: 'no-candidates',
      message: echoed
        ? 'agent had no candidates — every discovery call came back empty, so it answered with the on-air track\'s own id. Not a model fault: the seed is likely missing from the index the tool it reached for is built on (check sounds-like / mood coverage on /admin/library)'
        : 'agent had no candidates — every discovery call came back empty, so its answer could not match a real track. Not a model fault: check library coverage on /admin/library',
      countsAgainstBreaker: false,
    };
  }

  // Candidates existed, the model still answered with the seed, and the
  // constrained re-pick missed too: a harness problem.
  if (echoed) {
    return {
      kind: 'seed-echo',
      message: `agent answered with the on-air track's own id despite ${candidates} candidate(s) from its own tools, and the corrective re-pick missed`,
      countsAgainstBreaker: true,
    };
  }

  return {
    kind: 'unknown-id',
    message: `agent returned unknown id ${pickedId ?? 'none'} (${candidates} candidate(s) surfaced, near-miss repair and corrective re-pick both missed)`,
    countsAgainstBreaker: true,
  };
}
