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

const { matchByMetadata, identityText, pendingSourceSwitch, afterMaintenanceRun, switchedAfter } = await import('../src/music/source-switch.js');
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

// #1827 review: a walk already running when the operator switched sources
// walked the OLD library. Spending the marker on it re-linked nothing, and the
// first walk of the new source then found every row orphaned with no marker.
test('a walk that began before the switch leaves the marker for the walk after it', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));
  db.upsertTrackMeta('nd0000000000000000000003', { title: 'Quiet Room', artist: 'Low Tide', album: 'Rooms', year: 2001, duration: 180 });
  db.upsertTrackTags('nd0000000000000000000003', { moods: ['calm'], energy: 'low', source: 'manual', confidence: 1 });

  // The running child loaded its connection (the old library), then the save landed.
  ms.setCurrentSelection(ms.readSelection({}));
  await tick();
  await ms.markSourceSwitch('navidrome', 'router');
  const stale = await rotation.adoptAndPrune(new Set(['jf-aaa', 'nd0000000000000000000003']));
  assert.equal(stale.adopted, 0, 'nothing re-linked from a walk of the old library');
  assert.ok(pendingSourceSwitch(), 'the marker is kept for a walk of the new library');

  // The reconcile the controller starts next loads the new selection.
  ms.setCurrentSelection(ms.readSelection({ music: { mode: 'router', sources: [{ plugin: 'mock', config: {} }] } }));
  db.upsertTrackMeta('jf-bbb', { title: 'Quiet Room', artist: 'Low Tide', album: 'Rooms', year: 2001, duration: 181 });
  const fresh = await rotation.adoptAndPrune(new Set(['jf-aaa', 'jf-bbb']), { confirmMassPrune: true });
  assert.equal(fresh.adopted, 1);
  assert.equal(pendingSourceSwitch(), null, 'spent by the walk that used it');
  const carried = db.requireDb().prepare('SELECT moods, source FROM tracks WHERE id = ?').get('jf-bbb') as any;
  assert.match(carried.moods, /calm/);
  assert.equal(carried.source, 'manual');
});

test('a run that predates the switch is followed by a reconcile; a later one is not', () => {
  const marker = { at: '2026-10-07T12:00:00.000Z', from: 'navidrome', to: 'router' };
  const before = '2026-10-07T11:59:00.000Z';
  const after = '2026-10-07T12:00:01.000Z';
  assert.equal(afterMaintenanceRun(null, { startedAt: before, outcome: 'ok' }), null);
  assert.equal(afterMaintenanceRun(marker, { startedAt: before, outcome: 'ok' }), 'reconcile');
  assert.equal(afterMaintenanceRun(marker, { startedAt: before, outcome: 'failed' }), 'reconcile');
  assert.equal(afterMaintenanceRun(marker, { startedAt: before, outcome: 'stopped' }), 'stopped', 'Stop is not the moment to start another run');
  assert.equal(afterMaintenanceRun(marker, { startedAt: after, outcome: 'failed' }), null, 'it had its chance; retrying could loop');
  assert.equal(switchedAfter(marker, null), false, 'an unknown start keeps the original behaviour');
  assert.equal(switchedAfter(marker, Date.parse(marker.at)), false, 'a connection loaded at the same moment is the new one');
});
