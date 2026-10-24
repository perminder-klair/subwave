import assert from 'node:assert/strict';
import test from 'node:test';
import { isCoreReleaseGroup, latestCoreReleaseGroup, type MbReleaseGroup } from '../src/music/musicbrainz.js';

const now = new Date('2026-10-24T12:00:00Z');

test('core release filtering excludes non-core release types and future dates', () => {
  assert.equal(isCoreReleaseGroup({ 'primary-type': 'Single' }, 'single'), true);
  assert.equal(isCoreReleaseGroup({ 'primary-type': 'Album', 'secondary-types': ['Compilation'] }, 'album'), false);
  assert.equal(isCoreReleaseGroup({ 'primary-type': 'Single', 'secondary-types': ['Live'] }, 'single'), false);
  assert.equal(latestCoreReleaseGroup([
    { id: 'future', title: 'Future', 'primary-type': 'Single', 'first-release-date': '2026-11-01' },
    { id: 'live', title: 'Live', 'primary-type': 'Single', 'secondary-types': ['Live'], 'first-release-date': '2026-10-01' },
  ], 'single', now), null);
});

test('latest core release uses date, precision, title, then id as deterministic ties', () => {
  const groups: MbReleaseGroup[] = [
    { id: 'b', title: 'Zeta', 'primary-type': 'Single', 'first-release-date': '2026-10' },
    { id: 'a', title: 'Alpha', 'primary-type': 'Single', 'first-release-date': '2026-10-24' },
    { id: 'c', title: 'Alpha', 'primary-type': 'Single', 'first-release-date': '2026-10-24' },
  ];
  assert.equal(latestCoreReleaseGroup(groups, 'single', now)?.id, 'a');
});
