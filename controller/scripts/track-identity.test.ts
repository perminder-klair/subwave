// Tests for metadata-derived track identity (music/track-identity.ts) and the
// adopt-before-prune reconcile step (library-db.adoptOrphanTracks).
//
// Part 1 pins the pure matcher: normalisation, the one-to-one-both-ways rule,
// and the duration tolerance — the guards that make a wrong adoption (tags
// stamped onto a different song) impossible by construction.
//
// Part 2 runs a REAL better-sqlite3 + sqlite-vec DB against a temp STATE_DIR
// (same pattern as embedding-dim-migrate.test.ts) and replays the scenario the
// feature exists for: a track is tagged + analysed + embedded, its id re-mints
// (source rescan / file move / source switch), reconcile runs — the data must
// arrive under the new id and the orphan must be gone, while a genuinely
// removed track still prunes.
//
// Run: part of `npm test` (tsx scripts/track-identity.test.ts).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityKey, matchOrphansToLive, type TrackIdentityFields } from '../src/music/track-identity.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const t = (id: string, artist: string | null, title: string | null, album: string | null = 'Album', durationSec: number | null = 200): TrackIdentityFields =>
  ({ id, artist, title, album, durationSec });

async function pureTests() {
  console.log('identityKey:');

  await test('normalises case and whitespace', () => {
    assert.equal(
      identityKey({ artist: '  The  Cartel ', title: 'LEDGER lines', album: 'Neon\tLedger' }),
      identityKey({ artist: 'the cartel', title: 'Ledger Lines', album: 'Neon Ledger' }),
    );
  });

  await test('requires artist and title; album may be missing', () => {
    assert.equal(identityKey({ artist: null, title: 'x', album: null }), null);
    assert.equal(identityKey({ artist: 'a', title: '  ', album: null }), null);
    assert.equal(identityKey({ artist: 'a', title: 'x', album: null }), 'a|x|');
  });

  await test('different albums are different identities', () => {
    assert.notEqual(
      identityKey({ artist: 'a', title: 'x', album: 'Greatest Hits' }),
      identityKey({ artist: 'a', title: 'x', album: 'Debut' }),
    );
  });

  console.log('matchOrphansToLive:');

  await test('pairs a single orphan with its single live twin', () => {
    const m = matchOrphansToLive([t('old1', 'A', 'X')], [t('new1', 'a', 'x')]);
    assert.deepEqual(m, [{ orphanId: 'old1', liveId: 'new1' }]);
  });

  await test('skips a key with two live candidates (ambiguous target)', () => {
    const m = matchOrphansToLive([t('old1', 'A', 'X')], [t('new1', 'A', 'X'), t('new2', 'A', 'X')]);
    assert.deepEqual(m, []);
  });

  await test('skips a key with two orphans (ambiguous origin)', () => {
    const m = matchOrphansToLive([t('old1', 'A', 'X'), t('old2', 'A', 'X')], [t('new1', 'A', 'X')]);
    assert.deepEqual(m, []);
  });

  await test('rejects a duration gap beyond tolerance, tolerates a small one', () => {
    assert.deepEqual(
      matchOrphansToLive([t('old1', 'A', 'X', 'Al', 200)], [t('new1', 'A', 'X', 'Al', 212)]),
      [],
    );
    assert.deepEqual(
      matchOrphansToLive([t('old1', 'A', 'X', 'Al', 200)], [t('new1', 'A', 'X', 'Al', 203)]),
      [{ orphanId: 'old1', liveId: 'new1' }],
    );
  });

  await test('a missing duration on either side does not block the match', () => {
    assert.deepEqual(
      matchOrphansToLive([t('old1', 'A', 'X', 'Al', null)], [t('new1', 'A', 'X', 'Al', 200)]),
      [{ orphanId: 'old1', liveId: 'new1' }],
    );
  });

  await test('independent pairs all match in one pass', () => {
    const m = matchOrphansToLive(
      [t('o1', 'A', 'X'), t('o2', 'B', 'Y')],
      [t('n2', 'B', 'Y'), t('n1', 'A', 'X')],
    );
    assert.deepEqual(
      m.sort((a, b) => a.orphanId.localeCompare(b.orphanId)),
      [{ orphanId: 'o1', liveId: 'n1' }, { orphanId: 'o2', liveId: 'n2' }],
    );
  });
}

async function dbTests() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-identity-'));
  process.env.STATE_DIR = stateDir;
  // Imported AFTER STATE_DIR is set so DB_PATH resolves into the temp dir.
  const db = await import('../src/music/library-db.js');
  const DIM = 8;
  const vec = (fill: number) => new Float32Array(DIM).fill(fill);

  console.log('adoptOrphanTracks (real DB):');

  try {
    await db.open({ embeddingDim: DIM });

    await test('re-minted id keeps tags, enrichment, analysis and vectors; removed track still prunes', () => {
      // A tagged + analysed + embedded track under its original id, an untouched
      // track that will disappear, and a plain neighbour that stays put.
      db.upsertTrackMeta('old-1', { title: 'Ledger Lines', artist: 'Test Cartel', album: 'Neon Ledger', duration: 200 });
      db.upsertTrackTags('old-1', { moods: ['midnight', 'driving'], energy: 'medium', source: 'llm' });
      db.upsertTrackEnrichment('old-1', { lastfmTags: ['synthwave'], lyricExcerpt: 'neon rain' });
      db.upsertTrackAnalysis('old-1', { bpm: 118, musicalKey: '8A', introMs: 9000 });
      db.upsertTrackVector('old-1', vec(0.25));
      db.upsertTrackAudioVector('old-1', new Float32Array(db.AUDIO_EMBEDDING_DIM).fill(0.5));
      db.upsertTrackMeta('gone-1', { title: 'Deleted Song', artist: 'Test Cartel', album: 'Neon Ledger', duration: 100 });
      db.upsertTrackTags('gone-1', { moods: ['dawn'], energy: 'low', source: 'llm' });
      db.upsertTrackMeta('keep-1', { title: 'Stays Put', artist: 'Other Act', album: 'Elsewhere', duration: 150 });
      db.upsertTrackTags('keep-1', { moods: ['sunny'], energy: 'high', source: 'llm' });

      // The walk after a rescan/move/switch: same recording under a fresh id
      // (duration off by a second, as sources disagree), keep-1 unchanged.
      db.upsertTrackMeta('new-1', { title: 'Ledger Lines', artist: 'Test Cartel', album: 'Neon Ledger', duration: 201 });
      const liveIds = new Set(['new-1', 'keep-1']);

      const adopted = db.adoptOrphanTracks(liveIds);
      assert.equal(adopted, 1);
      const pruned = db.pruneMissingTracks(liveIds);
      assert.equal(pruned, 1); // gone-1 only — old-1 was already re-keyed

      const rec = db.getTrack('new-1');
      assert.ok(rec);
      assert.deepEqual(rec!.moods, ['midnight', 'driving']);
      assert.equal(rec!.energy, 'medium');
      assert.deepEqual(rec!.lastfmTags, ['synthwave']);
      assert.equal(rec!.lyricExcerpt, 'neon rain');
      assert.equal(rec!.bpm, 118);
      assert.equal(rec!.musicalKey, '8A');
      assert.equal(rec!.introMs, 9000);
      assert.ok(db.hasVector('new-1'));
      assert.ok(db.hasAudioVector('new-1'));
      assert.equal(db.getTrack('old-1'), null);
      assert.equal(db.getTrack('gone-1'), null);
      assert.deepEqual(db.getTrack('keep-1')!.moods, ['sunny']);
      assert.equal(db.trackCount(), 2);
    });

    await test('an ambiguous twin adopts nothing and falls through to the prune', () => {
      db.upsertTrackMeta('old-2', { title: 'Twin Song', artist: 'Dup Act', album: 'Twins', duration: 180 });
      db.upsertTrackTags('old-2', { moods: ['stormy'], energy: 'high', source: 'llm' });
      db.upsertTrackMeta('new-2a', { title: 'Twin Song', artist: 'Dup Act', album: 'Twins', duration: 180 });
      db.upsertTrackMeta('new-2b', { title: 'Twin Song', artist: 'Dup Act', album: 'Twins', duration: 180 });
      const liveIds = new Set(['new-1', 'keep-1', 'new-2a', 'new-2b']);

      assert.equal(db.adoptOrphanTracks(liveIds), 0);
      assert.equal(db.pruneMissingTracks(liveIds), 1); // old-2 pruned, as before this feature
      assert.deepEqual(db.getTrack('new-2a')!.moods, []);
      assert.deepEqual(db.getTrack('new-2b')!.moods, []);
    });

    await test('a live row that already has its own data is not a target', () => {
      db.upsertTrackMeta('old-3', { title: 'Solo', artist: 'Third Act', album: 'Three', duration: 210 });
      db.upsertTrackTags('old-3', { moods: ['old-mood'], energy: 'low', source: 'llm' });
      db.upsertTrackMeta('new-3', { title: 'Solo', artist: 'Third Act', album: 'Three', duration: 210 });
      db.upsertTrackTags('new-3', { moods: ['fresh-mood'], energy: 'high', source: 'llm' });
      const liveIds = new Set(['new-1', 'keep-1', 'new-2a', 'new-2b', 'new-3']);

      assert.equal(db.adoptOrphanTracks(liveIds), 0);
      db.pruneMissingTracks(liveIds);
      assert.deepEqual(db.getTrack('new-3')!.moods, ['fresh-mood']);
    });
  } finally {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function main() {
  await pureTests();
  await dbTests();
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall track-identity tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
