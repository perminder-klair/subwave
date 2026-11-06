import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectMostSpecificEligibleClaim,
  type SleeveNoteRecentUse,
  type SleeveNoteSelectionCandidate,
} from '../src/sleeve-notes/link-selection.js';

const now = Date.parse('2026-09-28T12:00:00.000Z');

function candidate(overrides: Partial<SleeveNoteSelectionCandidate> = {}): SleeveNoteSelectionCandidate {
  return {
    claimId: 'claim-1', entityType: 'artist', entityId: 'artist-1',
    category: 'artist-stories', topic: 'studio decision',
    wording: 'The artist made a distinctive studio decision.',
    fullWording: 'The artist made a distinctive studio decision.', shortWording: null,
    provider: 'wikipedia', attribution: 'Wikipedia', sourceUrl: 'https://example.test/source',
    relationshipKey: null, localTrackId: 'local-1', sourceContent: '', evidence: 'quoted source evidence',
    ...overrides,
  };
}

function use(overrides: Partial<SleeveNoteRecentUse> = {}): SleeveNoteRecentUse {
  const suppliedAt = overrides.suppliedAt ?? new Date(now - 1_000).toISOString();
  return {
    claimId: 'used-claim', entityType: 'recording', entityId: 'recording-1',
    topic: 'a different topic', relationshipKey: null,
    suppliedAt,
    airedAt: suppliedAt,
    releasedAt: null,
    detectionStatus: 'detected',
    ...overrides,
  };
}

test('prefers a recording story, then a release story, before an artist fallback', () => {
  const artist = candidate();
  const release = candidate({ claimId: 'release-claim', entityType: 'release', entityId: 'release-1', category: 'milestones' });
  const recording = candidate({ claimId: 'recording-claim', entityType: 'recording', entityId: 'recording-1', category: 'credits' });
  assert.equal(selectMostSpecificEligibleClaim([artist, release, recording], [], now)?.claimId, 'recording-claim');
  assert.equal(selectMostSpecificEligibleClaim([artist, release], [], now)?.claimId, 'release-claim');
});

test('avoids a recently aired exact claim, topic, or entity', () => {
  const note = candidate({ entityType: 'recording', entityId: 'recording-1' });
  assert.equal(selectMostSpecificEligibleClaim([note], [use({ claimId: note.claimId })], now), null);
  assert.equal(selectMostSpecificEligibleClaim([note], [use({ entityId: note.entityId, topic: note.topic })], now), null);
  assert.equal(selectMostSpecificEligibleClaim([note], [use({ entityId: note.entityId })], now), null);
});

test('uses longer entity cooldowns for artist claims and suppresses either direction of a connection', () => {
  const artist = candidate({ entityType: 'artist', entityId: 'artist-1' });
  const recentArtistUse = use({ entityType: 'artist', entityId: 'artist-1', suppliedAt: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(selectMostSpecificEligibleClaim([artist], [recentArtistUse], now), null);

  const relation = candidate({ entityType: 'recording', entityId: 'recording-2', relationshipKey: 'genius:10|genius:20' });
  const reverseUse = use({ relationshipKey: 'genius:10|genius:20' });
  assert.equal(selectMostSpecificEligibleClaim([relation], [reverseUse], now), null);
});

test('allows a claim again after its cooldown expires', () => {
  const note = candidate({ entityType: 'recording', entityId: 'recording-1' });
  const oldUse = use({ entityId: note.entityId, suppliedAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(selectMostSpecificEligibleClaim([note], [oldUse], now)?.claimId, note.claimId);
});

test('preserved Wikipedia rank wins over alphabetical topic within a category', () => {
  const stronger = candidate({ claimId: 'z', topic: 'Zebra', extractionRank: 1, extractionSection: 2 });
  const weaker = candidate({ claimId: 'a', topic: 'Apple', extractionRank: 2, extractionSection: 1 });
  assert.equal(selectMostSpecificEligibleClaim([weaker, stronger], [], now)?.claimId, 'z');
});

test('first-ranked sparks across sections precede second-ranked sparks', () => {
  const first = candidate({ claimId: 'first', extractionRank: 1, extractionSection: 2 });
  const second = candidate({ claimId: 'second', extractionRank: 2, extractionSection: 1 });
  assert.equal(selectMostSpecificEligibleClaim([second, first], [], now)?.claimId, 'first');
});

test('the extractor strongest-first order survives a different Wikipedia category', () => {
  const strongest = candidate({ claimId: 'strong', category: 'milestones', extractionRank: 1 });
  const weaker = candidate({ claimId: 'weak', category: 'musical-connections', extractionRank: 2 });
  assert.equal(selectMostSpecificEligibleClaim([weaker, strongest], [], now)?.claimId, 'strong');
});

test('an aired pass rotates behind untried ranked stories, then retries the oldest pass', () => {
  const stories = [1, 2, 3].map(rank => candidate({ claimId: `rank-${rank}`, extractionRank: rank }));
  const passed = (rank: number, secondsAgo: number) => use({ claimId: `rank-${rank}`,
    entityType: 'artist', entityId: 'artist-1', detectionStatus: 'not-detected',
    suppliedAt: new Date(now - secondsAgo * 1000).toISOString() });
  assert.equal(selectMostSpecificEligibleClaim(stories, [], now)?.claimId, 'rank-1');
  assert.equal(selectMostSpecificEligibleClaim(stories, [passed(1, 30)], now)?.claimId, 'rank-2');
  assert.equal(selectMostSpecificEligibleClaim(stories, [passed(1, 30), passed(2, 20)], now)?.claimId, 'rank-3');
  assert.equal(selectMostSpecificEligibleClaim(stories, [passed(1, 30), passed(2, 20), passed(3, 10)], now)?.claimId, 'rank-1');
  assert.equal(selectMostSpecificEligibleClaim(stories, [passed(1, 5), passed(2, 20), passed(3, 10)], now)?.claimId, 'rank-2');
});

test('an explicit context pass rotates without confirmed air after its reservation is released', () => {
  const first = candidate({ claimId: 'first', extractionRank: 1 });
  const second = candidate({ claimId: 'second', extractionRank: 2 });
  const passed = use({ claimId: first.claimId, entityType: 'artist', entityId: first.entityId,
    detectionStatus: 'not-detected', airedAt: null, releasedAt: new Date(now).toISOString(),
    contextPassReason: 'Too little room for this story.' });
  assert.equal(selectMostSpecificEligibleClaim([first, second], [passed], now)?.claimId, 'second');
  assert.equal(selectMostSpecificEligibleClaim([first], [passed], now)?.claimId, 'first', 'a pass is not a usage cooldown');
  assert.equal(selectMostSpecificEligibleClaim([first, second], [{ ...passed, contextPassReason: null }], now)?.claimId,
    'first', 'a failed or cancelled handoff does not spend a story turn');
});

test('rotation keeps pending reservations and confirmed-use entity cooldowns', () => {
  const first = candidate({ claimId: 'first', extractionRank: 1 });
  const second = candidate({ claimId: 'second', extractionRank: 2 });
  const pending = use({ claimId: first.claimId, entityType: 'artist', entityId: first.entityId,
    detectionStatus: 'not-detected', airedAt: null });
  assert.equal(selectMostSpecificEligibleClaim([first, second], [pending], now), null);
  assert.equal(selectMostSpecificEligibleClaim([first, second], [{ ...pending, detectionStatus: 'detected', airedAt: pending.suppliedAt }], now), null);
});

test('a series has a six-hour station-wide cooldown only after confirmed Spark use',()=>{
 const note=candidate({provider:'musicbrainz-series',category:'recognition',sourceUrl:'https://musicbrainz.org/series/list-a'});
 const aired=use({seriesKey:note.sourceUrl,entityId:'another-recording'});
 assert.equal(selectMostSpecificEligibleClaim([note],[aired],now),null);
 assert.equal(selectMostSpecificEligibleClaim([note],[{...aired,seriesKey:'https://musicbrainz.org/series/list-b'}],now)?.claimId,note.claimId);
 assert.equal(selectMostSpecificEligibleClaim([note],[{...aired,airedAt:null}],now)?.claimId,note.claimId);
 assert.equal(selectMostSpecificEligibleClaim([note],[{...aired,detectionStatus:'not-detected'}],now)?.claimId,note.claimId);
 assert.equal(selectMostSpecificEligibleClaim([note],[{...aired,airedAt:new Date(now-6*60*60*1000).toISOString()}],now)?.claimId,note.claimId);
 assert.equal(selectMostSpecificEligibleClaim([candidate()],[aired],now)?.claimId,'claim-1');
});
