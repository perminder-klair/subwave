import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAirtimeDecision } from '../src/sleeve-notes/airtime-review.js';
import { usefulRepairCandidate, type ResearchCandidate, type ResearchJob } from '../src/sleeve-notes/researcher.js';
const candidate: ResearchCandidate = { category: 'release-stories', topic: 'recording location',
  wording: 'Bright Days was recorded in a converted church.', evidence: 'Bright Days was recorded in a converted church.' };
const job: ResearchJob = { id: 'j', subjectKind: 'album', document: { id: 'source', revisionId: null, entityId: 'g', entityName: 'Bright Days',
  provider: 'genius', sourceUrl: 'https://example.test', text: candidate.evidence }, categories: ['release-stories', 'track-stories'], maxCandidates: 8 };
const resolve = (value: ResearchCandidate, title: string | undefined) => title && value.evidence.includes(title) && value.wording.includes(title) ? title : undefined;
test('source-album scope is retained without entering Review, including an implicit album subject', () => {
  assert.equal(applyAirtimeDecision(job, candidate, { claimId: 'C001', decision: 'matching-release-only', releaseTitle: 'Bright Days', reason: 'Needs this album' }, resolve).accepted?.wording, candidate.wording);
  const implicit = { ...candidate, wording: 'The album was recorded in a converted church.', evidence: 'The album was recorded in a converted church.' };
  assert.ok(applyAirtimeDecision(job, implicit, { claimId: 'C001', decision: 'matching-release-only', reason: 'Needs this album' }, resolve).accepted);
});
test('artist stories keep a supported album scope; album sources reject foreign albums and scope their own songs', () => {
  const other = { ...candidate, wording: 'Other Days was recorded in a barn.', evidence: 'Other Days was recorded in a barn.' };
  const result = applyAirtimeDecision({ ...job, subjectKind: 'artist' }, other, { claimId: 'C001', decision: 'matching-release-only', releaseTitle: 'Other Days', reason: 'Other album' }, resolve);
  assert.equal(result.accepted?.matchingReleaseTitle, 'Other Days');
  const foreign = applyAirtimeDecision(job, other, { claimId: 'C001', decision: 'matching-release-only', releaseTitle: 'Other Days', reason: 'Needs the other album' }, resolve);
  assert.equal(foreign.accepted, undefined);
  assert.equal(usefulRepairCandidate(foreign.rejected!.candidate), false);
  const song = { ...candidate, category: 'track-stories' as const, wording: 'First Song was recorded in a barn.', evidence: 'First Song was recorded in a barn.' };
  assert.equal(applyAirtimeDecision(job, song, { claimId: 'C001', decision: 'matching-track-only', trackTitle: 'First Song', reason: 'Needs this song' }, resolve).accepted?.matchingTrackTitle, 'First Song');
});
test('absent verdicts are unresolved and unsupported scope titles do not nominate Review', () => {
  assert.throws(() => applyAirtimeDecision(job, candidate, undefined, resolve), /unresolved/);
  const result = applyAirtimeDecision(job, candidate, { claimId: 'C001', decision: 'matching-release-only', releaseTitle: 'Invented Album', reason: 'Needs that album', reviewIssue: 'context' }, resolve);
  assert.equal(usefulRepairCandidate(result.rejected!.candidate), false);
});
test('only explicit supported worthwhile repair candidates qualify, not routine identity or generic rejection', () => {
  const decision = { claimId: 'C001', decision: 'bin' as const, reason: 'The recording place is useful, but the subject wording needs a clear album reference.', reviewIssue: 'wording' as const };
  assert.equal(usefulRepairCandidate(applyAirtimeDecision(job, candidate, decision, resolve).rejected!.candidate), true);
  assert.equal(usefulRepairCandidate(applyAirtimeDecision(job, candidate, { ...decision, reviewIssue: null }, resolve).rejected!.candidate), false);
  const identity = { ...candidate, topic: 'album identity', wording: 'Bright Days is the ninth studio album by Example Band.', evidence: 'Bright Days is the ninth studio album by Example Band.' };
  assert.equal(usefulRepairCandidate(applyAirtimeDecision(job, identity, decision, resolve).rejected!.candidate), false);
  assert.equal(usefulRepairCandidate({ ...candidate, reviewIssue: 'wording', reviewReason: 'Needs fixing' }), false);
  assert.equal(usefulRepairCandidate({ ...candidate, reviewIssue: 'context', reviewReason: 'The fact needs to be matched with the release title, which is Bright Days.' }), false);
  assert.equal(usefulRepairCandidate({ ...candidate, wording: 'Bright Days was recorded in an invented palace.', reviewIssue: 'context', reviewReason: decision.reason }), false);
});
