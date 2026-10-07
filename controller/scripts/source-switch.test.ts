// Carrying the library across a music-source switch (#692): the metadata
// matcher, and the adoption it feeds. A real better-sqlite3 DB in a temp
// STATE_DIR (set before library-db is imported).
//
// Two properties are load-bearing: without the switch marker, adoption is the
// Navidrome canonical-id path exactly as before; with it, a row moves only to
// a live row that is unambiguously the same recording.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-source-switch-'));
process.env.STATE_DIR = stateDir;

const { matchByMetadata, identityText, pendingSourceSwitch } = await import('../src/music/source-switch.js');
const db = await import('../src/music/library-db.js');
const rotation = await import('../src/music/id-rotation.js');
const ms = await import('../src/setup/music-source.js');

after(() => rmSync(stateDir, { recursive: true, force: true }));

const row = (id: string, artist: string, title: string, album: string, duration_sec: number | null = 200) => ({ id, artist, title, album, duration_sec });

test('normalisation ignores case, accents, punctuation and "&"', () => {
  assert.equal(identityText('Sigur Rós'), identityText('sigur ros'));
  assert.equal(identityText("Don't Stop (Remastered)"), identityText('dont stop  remastered'));
  assert.equal(identityText('Simon & Garfunkel'), identityText('Simon and Garfunkel'));
  assert.notEqual(identityText('Live'), identityText('Alive'));
});

test('matches one-to-one on artist, title, album and duration', () => {
  const orphans = [row('old1', 'A', 'Song', 'Album', 200), row('old2', 'B', 'Other', 'X', 180)];
  const live = [row('jf-1', 'a', 'song', 'ALBUM', 201), row('jf-2', 'B', 'Other', 'X', 240)];
  const pairs = matchByMetadata(orphans, live, new Set());
  assert.deepEqual(pairs, [['old1', 'jf-1']], 'a 60s duration gap is a different recording');
});

test('an ambiguous orphan is left alone rather than guessed', () => {
  const orphans = [row('old', 'A', 'Song', 'Album', 200)];
  const tie = [row('n1', 'A', 'Song', 'Album', 199), row('n2', 'A', 'Song', 'Album', 201)];
  assert.deepEqual(matchByMetadata(orphans, tie, new Set()), []);
  const clear = [row('n1', 'A', 'Song', 'Album', 200), row('n2', 'A', 'Song', 'Album', 202)];
  assert.deepEqual(matchByMetadata(orphans, clear, new Set()), [['old', 'n1']]);
  const noDurations = [row('n1', 'A', 'Song', 'Album', null), row('n2', 'A', 'Song', 'Album', null)];
  assert.deepEqual(matchByMetadata(orphans, noDurations, new Set()), []);
});

test('targets are claimed once, and claimed targets are skipped', () => {
  const orphans = [row('o1', 'A', 'S', 'Al'), row('o2', 'A', 'S', 'Al')];
  const live = [row('n1', 'A', 'S', 'Al')];
  assert.deepEqual(matchByMetadata(orphans, live, new Set()), [['o1', 'n1']]);
  assert.deepEqual(matchByMetadata(orphans, live, new Set(['n1'])), []);
  assert.deepEqual(matchByMetadata([row('o', '', 'S', 'Al')], [row('n', '', 'S', 'Al')], new Set()), [], 'no artist, no match');
});

test('adoption carries tags across a switch only when the marker is set', async () => {
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  // The old library (direct Navidrome ids), tagged and analysed.
  db.upsertTrackMeta('nd0000000000000000000001', { title: 'Harbour Lights', artist: 'Neon Harbor', album: 'Night', year: 1990, duration: 200 });
  db.upsertTrackTags('nd0000000000000000000001', { moods: ['nocturnal'], energy: 'low', source: 'llm', confidence: 0.9 });
  db.upsertTrackMeta('nd0000000000000000000002', { title: 'Gone Song', artist: 'Nobody', album: 'Lost', year: 1980, duration: 100 });
  // The new library as the walk just wrote it (router ids).
  db.upsertTrackMeta('jf-aaa', { title: 'Harbour Lights', artist: 'Neon Harbor', album: 'Night', year: 1990, duration: 201 });
  const live = new Set(['jf-aaa']);

  // No marker: exactly the Navidrome path — nothing to adopt by canonical id.
  const without = db.adoptRotatedIds(live);
  assert.equal(without.adopted, 0);

  await ms.markSourceSwitch('navidrome', 'router');
  const result = await rotation.adoptAndPrune(live, { confirmMassPrune: true });
  assert.equal(result.adopted, 1);
  assert.equal(pendingSourceSwitch(), null, 'the marker is spent by the walk that used it');
  const carried = db.requireDb().prepare('SELECT id, moods, energy FROM tracks WHERE id = ?').get('jf-aaa') as any;
  assert.match(carried.moods, /nocturnal/);
  assert.equal(carried.energy, 'low');
  const left = (db.requireDb().prepare('SELECT id FROM tracks ORDER BY id').all() as any[]).map((r) => r.id);
  assert.deepEqual(left, ['jf-aaa'], 'the unmatched row was pruned and the adopted one moved');
  // The pair is journalled for the state-file replay (likes, blocklist, stems).
  assert.equal(db.pendingIdRotations().get('nd0000000000000000000001'), 'jf-aaa');
});
