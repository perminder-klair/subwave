import type { ResearchCandidate, ResearchJob, ResearchReviewDecision, ValidatedResearch } from './researcher.js';

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[’']/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function titleIsSupported(candidate: ResearchCandidate, title: string | undefined): boolean {
  return Boolean(title && candidate.wording.toLocaleLowerCase().includes(title.toLocaleLowerCase())
    && candidate.evidence.toLocaleLowerCase().includes(title.toLocaleLowerCase()));
}

/** Scope is eligibility, not quality. Only an explicit bin verdict can nominate a repair. */
export function applyAirtimeDecision(
  job: ResearchJob, candidate: ResearchCandidate, decision: ResearchReviewDecision | undefined,
  resolveArtistTitle: (candidate: ResearchCandidate, title: string | undefined, kind: 'release' | 'track') => string | undefined,
): { accepted?: ResearchCandidate; rejected?: ValidatedResearch['rejected'][number] } {
  if (!decision) throw new Error('Airtime decision is missing; leave this candidate unresolved');
  const correctedTopic = decision?.topic?.replace(/\s+/gu, ' ').trim();
  const { reviewIssue: _previousIssue, ...base } = candidate;
  const reviewedCandidate: ResearchCandidate = {
    ...base,
    category: decision?.category && job.categories.includes(decision.category)
      ? decision.category : candidate.category,
    topic: correctedTopic && correctedTopic.length >= 2 && correctedTopic.length <= 100
      ? correctedTopic : candidate.topic,
    shortWording: decision?.shortSafe === true ? candidate.shortWording : undefined,
  };
  const artistReleaseStory = job.subjectKind === 'artist' && reviewedCandidate.category === 'release-stories';
  const artistTrackStory = job.subjectKind === 'artist' && reviewedCandidate.category === 'track-stories';
  const proposedReleaseTitle = decision?.releaseTitle?.trim();
  const proposedTrackTitle = decision?.trackTitle?.trim();
  const releaseTitle = job.subjectKind === 'artist'
    ? resolveArtistTitle(candidate, proposedReleaseTitle, 'release')
    : titleIsSupported(candidate, proposedReleaseTitle) ? proposedReleaseTitle : undefined;
  const trackTitle = job.subjectKind === 'artist'
    ? resolveArtistTitle(candidate, proposedTrackTitle, 'track')
    : titleIsSupported(candidate, proposedTrackTitle) ? proposedTrackTitle : undefined;
  const sourceAlbumSubject = titleIsSupported(candidate, job.document.entityName ?? undefined)
    || /^(?:the|this) album\b/iu.test(candidate.wording);
  const sourceAlbumDecision = job.subjectKind === 'album' && decision?.decision === 'matching-release-only'
    && sourceAlbumSubject
    && (!proposedReleaseTitle || normalizedTitle(proposedReleaseTitle) === normalizedTitle(job.document.entityName ?? ''));
  if ((decision?.decision === 'ready' && !artistReleaseStory && !artistTrackStory) || sourceAlbumDecision) {
    return { accepted: reviewedCandidate };
  } else if (job.subjectKind !== 'album' && (decision?.decision === 'matching-release-only'
      || (decision?.decision === 'ready' && artistReleaseStory))
    && titleIsSupported(candidate, releaseTitle)) {
    return { accepted: { ...reviewedCandidate, airtimeScope: 'matching-release-only', matchingReleaseTitle: releaseTitle } };
  } else if ((decision?.decision === 'matching-track-only'
      || (decision?.decision === 'ready' && artistTrackStory))
    && titleIsSupported(candidate, trackTitle)) {
    return { accepted: { ...reviewedCandidate, airtimeScope: 'matching-track-only', matchingTrackTitle: trackTitle } };
  } else {
    const needsTitle = decision?.decision === 'ready' && (artistReleaseStory || artistTrackStory);
    return { rejected: { candidate: { ...base,
      ...(decision?.decision === 'bin' && decision.reviewIssue ? { reviewIssue: decision.reviewIssue } : {}),
      reviewReason: needsTitle
        ? `Artist-level ${artistReleaseStory ? 'album' : 'song'} story needs an exact matching title in Full and Evidence.`
        : decision?.reason.trim() || 'Generic DJ did not approve this claim' }, reason: 'editorial' } };
  }
}
