// The Blocked tab's per-entry figure (blocked-counts.ts).
//
// Run: npm test -- blocked-counts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedCount } from './blocked-counts';

const at = '2026-10-31T02:00:00.000Z';

test('reads the per-entry tally by type and id', () => {
  const by = { 'album:al1': 14, 'track:t1': 1 };
  assert.deepEqual(
    [blockedCount(by, { type: 'album', id: 'al1' }, at)?.label, blockedCount(by, { type: 'track', id: 't1' }, at)?.label],
    ['14 tracks', '1 track'],
  );
  assert.equal(blockedCount({ 'album:al1': 1200 }, { type: 'album', id: 'al1' }, at)?.label, '1,200 tracks');
});

test('an entry the tally lacks blocks nothing, and says so', () => {
  const c = blockedCount({}, { type: 'artist', id: 'ar1', addedAt: '2026-10-01T00:00:00Z' }, at);
  assert.equal(c?.label, '0 tracks');
  assert.equal(c?.none, true);
});

test('unknown stays blank: no overview yet, or an entry newer than the count', () => {
  assert.equal(blockedCount(undefined, { type: 'track', id: 't1' }, at), null);
  assert.equal(blockedCount(null, { type: 'track', id: 't1' }, at), null);
  assert.equal(blockedCount({}, { type: 'track', id: 'new', addedAt: '2026-10-31T03:00:00Z' }, at), null);
  // Already counted once the overview is newer than the entry.
  assert.equal(blockedCount({ 'track:new': 1 }, { type: 'track', id: 'new', addedAt: '2026-10-31T03:00:00Z' }, at)?.label, '1 track');
});
