import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planOrphanPurge,
  planQuarantinePurge,
  QUARANTINE_DIR,
  QUARANTINE_GRACE_MS,
  exceedsAutoCeiling,
  isStemDirListing,
  AUTO_MAX_MIN_DIRS,
} from '../src/music/orphan-purge-pure.js';

const DAY = 86400_000;
const NOW = 1_760_000_000_000;

const entry = (name: string, over: Partial<{ mtimeMs: number; known: boolean }> = {}) => ({
  name,
  mtimeMs: over.mtimeMs ?? NOW - 30 * DAY,
  known: over.known ?? false,
});

test('a directory for a track still in the library is kept untouched', () => {
  const plan = planOrphanPurge([entry('keep-me', { known: true })], { confirm: true });
  assert.deepEqual(plan.quarantine, []);
  assert.deepEqual(plan.kept, ['keep-me']);
});

test('an orphan is quarantined, not deleted, once the operator has confirmed', () => {
  const plan = planOrphanPurge([entry('gone-track')], { confirm: true });
  assert.deepEqual(plan.quarantine.map(q => q.name), ['gone-track']);
  assert.deepEqual(plan.kept, []);
});

test('unconfirmed is a dry run: the plan reports what WOULD move but moves nothing', () => {
  const plan = planOrphanPurge([entry('gone-track'), entry('keep-me', { known: true })], { confirm: false });
  assert.deepEqual(plan.quarantine.map(q => q.name), ['gone-track']);
  assert.equal(plan.dryRun, true);
});

test('an orphan that is in the library again is released back, not copied', () => {
  // The live slot is free (the orphan copy was the only one): quarantine holds
  // the sole copy, so a re-appearing track id gets its stems back by moving.
  const plan = planQuarantinePurge(
    [{ name: 'back-again', known: true, ageMs: 2 * DAY, liveSlotFree: true }],
    { confirm: true },
  );
  assert.deepEqual(plan.released, ['back-again']);
  assert.deepEqual(plan.deleted, []);
});

test('a superseded quarantine ages out and is deleted once aged, never merged over the new copy', () => {
  const plan = planQuarantinePurge(
    [{ name: 're-analysed', known: true, ageMs: QUARANTINE_GRACE_MS + 1, liveSlotFree: false }],
    { confirm: true },
  );
  assert.deepEqual(plan.deleted.map(d => d.name), ['re-analysed']);
  assert.deepEqual(plan.released, []);
  assert.deepEqual(plan.superseded, ['re-analysed']);
});

test('a quarantine younger than the grace period stays put', () => {
  const plan = planQuarantinePurge(
    [{ name: 'fresh-orphan', known: false, ageMs: QUARANTINE_GRACE_MS - DAY, liveSlotFree: true }],
    { confirm: true },
  );
  assert.deepEqual(plan.aging.map(a => a.name), ['fresh-orphan']);
  assert.deepEqual(plan.deleted, []);
  assert.deepEqual(plan.released, []);
});

test('a quarantine older than the grace period is deleted once confirmed', () => {
  const plan = planQuarantinePurge(
    [{ name: 'old-orphan', known: false, ageMs: QUARANTINE_GRACE_MS + 60_000, liveSlotFree: false }],
    { confirm: true },
  );
  assert.deepEqual(plan.deleted.map(d => d.name), ['old-orphan']);
});

test('an unconfirmed quarantine pass is also a dry run', () => {
  const plan = planQuarantinePurge(
    [{ name: 'old-orphan', known: false, ageMs: 9 * DAY, liveSlotFree: false }],
    { confirm: false },
  );
  assert.deepEqual(plan.deleted.map(d => d.name), ['old-orphan']);
  assert.equal(plan.dryRun, true);
});

test('the quarantine is a dot-directory at the cache root, hidden from every walk', () => {
  assert.equal(QUARANTINE_DIR.startsWith('.'), true);
  assert.equal(QUARANTINE_DIR.includes('/'), false);
});

test('grace is 7 days', () => {
  assert.equal(QUARANTINE_GRACE_MS, 7 * DAY);
});

test('an empty cache plans nothing', () => {
  const plan = planOrphanPurge([], { confirm: true });
  assert.equal(plan.quarantined, 0);
  assert.deepEqual(plan.kept, []);
});

test('a young superseded quarantine waits out the grace like any other, released under no condition', () => {
  const plan = planQuarantinePurge(
    [{ name: 're-analysed-young', known: true, ageMs: DAY, liveSlotFree: false }],
    { confirm: true },
  );
  assert.deepEqual(plan.released, []);
  assert.deepEqual(plan.deleted, []);
  assert.deepEqual(plan.superseded, ['re-analysed-young']);
  assert.equal(plan.aging.length, 1);
});

test('the automatic ceiling: a large share of the cache, and at least AUTO_MAX_MIN_DIRS dirs', () => {
  assert.equal(exceedsAutoCeiling(4288, 72_000), false, 'the 25 Oct churn pass (~6%) still runs on its own');
  assert.equal(exceedsAutoCeiling(40_000, 36_000), true, 'half the cache is an operator decision');
  assert.equal(exceedsAutoCeiling(AUTO_MAX_MIN_DIRS - 1, 0), false, 'a small cache is never held back');
  assert.equal(exceedsAutoCeiling(0, 0), false);
});

const file = (name: string) => ({ name, isDirectory: false });
const dir = (name: string) => ({ name, isDirectory: true });

test('a stem dir holds stem files and nothing else', () => {
  assert.equal(isStemDirListing([file('head-drums.flac'), file('head-vocals.flac')]), true);
  assert.equal(isStemDirListing([file('tail-bass.flac'), file('tail-meta.json')]), true);
  assert.equal(isStemDirListing([file('head-other.flac'), file('.orphaned-at'), file('.track-meta.json')]), true);
});

test('the grammar follows the model: a six-source Demucs writes more than four stems', () => {
  assert.equal(isStemDirListing([file('head-guitar.flac'), file('tail-piano.flac')]), true);
});

test('a crashed write leaves its .tmp behind, and that is still the analyzer\'s file', () => {
  assert.equal(isStemDirListing([file('head-drums.flac'), file('head-bass.flac.tmp'), file('tail-meta.json.tmp')]), true);
});

test('an empty dir is not a stem dir: lost+found often is one', () => {
  assert.equal(isStemDirListing([]), false);
});

test('sidecars alone are not a stem dir', () => {
  assert.equal(isStemDirListing([file('.orphaned-at'), file('.track-meta.json')]), false);
});

test('anything else beside the stems disqualifies the dir', () => {
  assert.equal(isStemDirListing([file('head-drums.flac'), file('keep-me.tar')]), false);
  assert.equal(isStemDirListing([file('head-drums.flac'), file('.DS_Store')]), false);
  assert.equal(isStemDirListing([file('middle-drums.flac')]), false);
  assert.equal(isStemDirListing([file('head-drums.flac.bak')]), false);
  assert.equal(isStemDirListing([file('xhead-drums.flac')]), false);
});

test('a subdirectory disqualifies the dir, even one named like a stem', () => {
  assert.equal(isStemDirListing([file('head-drums.flac'), dir('@eaDir')]), false);
  assert.equal(isStemDirListing([dir('head-drums.flac')]), false);
});
