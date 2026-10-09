// One Musical Leanings review pass, shared by both selection routes.
//
// Agentic Tools and Track Shortlist each make a Leanings-blind preliminary
// pick, then this pass may swap it for a close, controller-verified challenger.
// It used to be written out once per route, and the two copies drifted (one
// stopped sending the host/guest split, the other wrapped its reason
// differently). A route now supplies only what genuinely differs: its names,
// its telemetry object and how it words a verified replacement. The model call
// and logging are injected, as runArtistGuard's are, so the pass can be driven
// without a provider.
//
// The pass never decides whether Leanings MATTERED. That needs the final track
// after the guards and the queue's answer, so it stays with the caller
// (resolveAgenticLeaningsUsage after enqueue).

import {
  agenticLeaningsReviewPrompt,
  agenticLeaningsReviewSchema,
  agenticLeaningsReviewSystem,
  NO_AGENTIC_LEANINGS_INFLUENCE,
  type AgenticLeaningsReviewContext,
  type EditorialLeaningsContext,
} from './schemas.js';
import {
  agenticLeaningsSelectionReason,
  agenticLeaningsSources,
  agenticTrackRef,
  compactAgenticReviewCandidate,
  eligibleAgenticLeanings,
  selectAgenticReviewCandidates,
  validateAgenticLeaningsReplacement,
  type PickResolution,
} from './leanings-review.js';

export type LeaningsRoute = {
  kind: 'djAgentLeaningsReview' | 'djShortlistLeaningsReview';
  // Shared by reference with the LLM call record, so Debug shows the settled
  // outcome beside the raw response.
  telemetry: Record<string, unknown>;
  // Booth wording: "<label> rejected (<why>) — <fallback>".
  label: string;
  fallback: string;
  failureEvent: string;
  failureFields?: Record<string, unknown>;
  // How this route words a verified replacement for the Booth and session.
  replacementReason: (replacement: any, leaningsReason: string) => string;
};

export type LeaningsReviewCall = (request: {
  system: string;
  prompt: string;
  schema: ReturnType<typeof agenticLeaningsReviewSchema>;
  temperature: number;
  kind: LeaningsRoute['kind'];
  telemetry: Record<string, unknown>;
}) => Promise<any>;

export type LeaningsPassResult = {
  song: any;
  object: any;
  // True when the review model actually answered; the caller counts it as a
  // step. A skipped or failed review spends no step.
  reviewed: boolean;
};

export async function runLeaningsReview({
  song,
  object,
  seen,
  editorialLeanings,
  djName,
  lastfmTagsFor = () => [],
  context,
  resolution,
  route,
  review,
  log,
  logEvent,
}: {
  song: any;
  object: any;
  seen: Map<string, any>;
  editorialLeanings: EditorialLeaningsContext;
  djName: string | null;
  // Read existing library evidence privately, after the Leanings-blind pick.
  lastfmTagsFor?: (id: string) => readonly string[] | null | undefined;
  context: AgenticLeaningsReviewContext;
  resolution: PickResolution;
  route: LeaningsRoute;
  review: LeaningsReviewCall;
  log: (line: string) => void;
  logEvent: (event: string, fields: Record<string, unknown>) => void;
}): Promise<LeaningsPassResult> {
  const preliminaryId = String(song.id);
  resolution.leaningsReview = { outcome: 'not-run', replacementId: null };
  if (!editorialLeanings.promptValue || seen.size <= 1) return { song, object, reviewed: false };

  // Tool candidates omit Last.fm tags to keep discovery compact. Enrich copies
  // only for this review, including the baseline so shared evidence cannot be
  // mistaken for a challenger advantage. Never mutate the picker’s seen map.
  const withEvidence = (candidate: any) => ({
    ...candidate,
    lastfm_tags: [...new Set([
      ...(Array.isArray(candidate.lastfm_tags) ? candidate.lastfm_tags : []),
      ...(lastfmTagsFor(String(candidate.id)) ?? []),
    ])],
  });
  const reviewBaseline = withEvidence(song);
  const candidates = [...seen.values()].map(withEvidence);
  const leaningsSources = eligibleAgenticLeanings(reviewBaseline, candidates, agenticLeaningsSources(editorialLeanings, djName));
  const leaningsOptions = leaningsSources.map(({ phrase }) => phrase);
  const reviewCandidates = selectAgenticReviewCandidates(reviewBaseline, candidates, leaningsOptions);
  if (reviewCandidates.length < 2 || leaningsOptions.length === 0) return { song, object, reviewed: false };

  const common = {
    baselineId: preliminaryId,
    candidateIds: reviewCandidates.map((candidate) => String(candidate.id)),
    leaningsOptions,
    leaningsSources,
  };
  const compactCandidates = reviewCandidates.map((candidate) => compactAgenticReviewCandidate(candidate, leaningsOptions, reviewBaseline));
  const baselineSupportedLeanings = (compactCandidates[0].leaningsMatches ?? []) as string[];
  // No distinguishing preference among viable challengers means there is no
  // tie for Leanings to settle. Keep the original pick without a model call.
  if (!compactCandidates.slice(1).some(candidate =>
    (candidate.flowCloseness === 'close' || candidate.flowCloseness === 'possible')
    && Array.isArray(candidate.leaningsAdvantages) && candidate.leaningsAdvantages.length > 0)) {
    resolution.leaningsReview = { outcome: 'not-run', replacementId: null, ...common };
    return { song, object, reviewed: false };
  }
  try {
    const compactById = new Map(compactCandidates.map((candidate) => [String(candidate.id), candidate]));
    const answer: any = await review({
      system: agenticLeaningsReviewSystem(),
      prompt: agenticLeaningsReviewPrompt({
        baseline: compactCandidates[0],
        challengers: compactCandidates.slice(1),
        leaningsOptions,
        leaningsSources,
        context: {
          ...context,
          djName,
          hostLeaningsOptions: leaningsSources.filter(({ source }) => source === 'host').map(({ phrase }) => phrase),
          guestLeaningsOptions: leaningsSources.filter(({ source }) => source === 'guest').map(({ phrase }) => phrase),
        },
      }),
      schema: agenticLeaningsReviewSchema(common.candidateIds, leaningsOptions, preliminaryId),
      temperature: 0,
      kind: route.kind,
      telemetry: route.telemetry,
    });
    const reviewedSelectedId = answer.selectedId;
    const claimedBasis = answer.leaningsBasis === NO_AGENTIC_LEANINGS_INFLUENCE ? null : answer.leaningsBasis;
    if (reviewedSelectedId === preliminaryId) {
      resolution.leaningsReview = { outcome: 'kept', replacementId: null, reviewedSelectedId, leaningsBasis: claimedBasis, ...common };
      return { song, object, reviewed: true };
    }

    const replacement = reviewCandidates.find((candidate) => String(candidate.id) === String(reviewedSelectedId));
    if (!replacement) {
      resolution.leaningsReview = {
        outcome: 'invalid', replacementId: null, proposedReplacementId: String(reviewedSelectedId),
        rejectionReason: 'unknown-candidate', reviewedSelectedId, leaningsBasis: claimedBasis, ...common,
      };
      log(`${route.label} rejected (unknown-candidate) — ${route.fallback}`);
      return { song, object, reviewed: true };
    }

    const compactReplacement = compactById.get(String(replacement.id));
    const validation = validateAgenticLeaningsReplacement({
      musicalReason: answer.musicalReason,
      leaningsBasis: answer.leaningsBasis,
      musicalLeanings: editorialLeanings.promptValue,
      allowedLeanings: leaningsOptions,
      supportedLeanings: Array.isArray(compactReplacement?.leaningsMatches) ? compactReplacement.leaningsMatches as string[] : [],
      baselineSupportedLeanings,
      flowCloseness: compactReplacement?.flowCloseness,
    });
    if (!validation.valid) {
      resolution.leaningsReview = {
        outcome: 'invalid', replacementId: null, proposedReplacementId: String(replacement.id),
        rejectionReason: validation.reason, track: agenticTrackRef(replacement),
        reviewedSelectedId, leaningsBasis: claimedBasis, ...common,
      };
      log(`${route.label} rejected (${validation.reason}) — ${route.fallback}`);
      return { song, object, reviewed: true };
    }

    const owner = leaningsSources.find(({ phrase }) => phrase === validation.basis);
    const leaningsReason = agenticLeaningsSelectionReason({
      replacement,
      djName,
      leaningsOwnerName: owner?.ownerName ?? (owner?.source === 'guest' ? 'The guest' : djName),
      basis: validation.basis,
      musicalReason: answer.musicalReason,
    });
    resolution.leaningsReview = {
      outcome: 'replaced', replacementId: String(replacement.id), track: agenticTrackRef(replacement),
      leaningsBasis: validation.basis, leaningsSource: owner?.source ?? null, reviewedSelectedId, ...common,
    };
    return {
      song: seen.get(String(replacement.id)) ?? replacement,
      object: { ...object, id: replacement.id, reason: route.replacementReason(replacement, leaningsReason), transition: answer.transition },
      reviewed: true,
    };
  } catch (error) {
    resolution.leaningsReview = { outcome: 'failed', replacementId: null };
    logEvent(route.failureEvent, { ...route.failureFields, candidates: seen.size, error: String(error) });
    log(`${route.label} failed — ${route.fallback}`);
    return { song, object, reviewed: false };
  }
}
