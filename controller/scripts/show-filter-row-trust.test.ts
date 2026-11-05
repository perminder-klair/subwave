// Show filters answer from the row they are given (#2235). Every library-row
// mapper carries what the vocal, energy and genre readers need, an unknown value
// as an explicit null (or []), so the answer is already on the row. A null used
// to send each reader back to library.get, a full-row read per track that cost a
// strict show 2-3 s per pick on a 50k library with no vocal analysis, for the
// same answer. Only a shape without the keys still looks the track up: `{ id }`,
// a raw Subsonic child, and a mood-pool row for the vocal fields it never carries.
//
// Proof without spying on ESM exports: read the rows, change the DB under them,
// then see which answer each reader gives. A trusted row keeps the answer it was
// read with; a lookup follows the DB.
//
// Run: npm test -- show-filter-row-trust

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-row-trust-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const {
  trackInstrumental, onlyVocals, trackEnergy, onlyEnergy, trackGenres, genreMatches, onlyGenre,
} = await import('../src/music/show-filter.js');
const { carriesVocalEvidence } = await import('../src/music/lyric-vocal.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');

// A lean analysis: beat grids and an outro, no vocal measurement in either window.
const leanOutro = JSON.stringify({ startMs: 180_000, ending: 'fade', beats: [180_000, 180_500], bars: [180_000] });
const sungOutro = JSON.stringify({ startMs: 180_000, ending: 'fade', beats: [180_000], bars: [180_000],
  vocalRanges: [{ startMs: 180_000, endMs: 190_000 }] });

function seed(id: string, { energy, genres, vocal = null, outro = leanOutro }: {
  energy: string | null; genres: string[] | null; vocal?: string | null; outro?: string | null;
}) {
  db.requireDb().prepare(`INSERT INTO tracks (id, title, artist, album, moods, energy, genres, duration_sec,
    vocal_ranges_json, outro_json) VALUES (?, ?, ?, ?, ?, ?, ?, 240, ?, ?)`)
    .run(id, id, `Artist ${id}`, `Album ${id}`, '["calm"]', energy, genres ? JSON.stringify(genres) : null, vocal, outro);
}

// Every library-row shape that reaches a show filter, read once and keyed by reader.
function libraryRows(id: string, { energy }: { energy: string | null }) {
  const rows: Array<[string, any]> = [
    ['candidateFilterTracks', db.candidateFilterTracks().find(r => r.id === id)],
    ['getTrack', db.getTrack(id)],
    ['slimById', library.slimById(id)],
    ['db.filter', db.filter({ limit: 200 }).rows.find(r => r.id === id)],
  ];
  if (energy) {
    rows.push(['songsByEnergy', db.songsByEnergy(energy as 'low').find(r => r.id === id)]);
    rows.push(['library.songsByEnergy', library.songsByEnergy(energy).find((r: { id: string }) => r.id === id)]);
  }
  for (const [reader, row] of rows) assert.ok(row, `${id}: ${reader} returned the row`);
  return rows;
}
const moodPoolRow = (id: string): any => {
  const row = db.songsByMood('calm').find(r => r.id === id);
  assert.ok(row, `${id}: songsByMood returned the row`);
  return row;
};
// A raw Subsonic child: no tagger fields, no vocal fields, and an empty genre
// omitted (OpenSubsonic may still send `genres: []`).
const rawChild = (id: string, extra: Record<string, unknown> = {}): any => ({ id, title: id, artist: `Artist ${id}`, duration: 240, ...extra });

before(async () => {
  await library.load();
});

after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

test('vocal: a library row answers from its own fields; `{ id }`, a raw child and a mood-pool row look it up', () => {
  const id = 'vocal-lean';
  seed(id, { energy: 'low', genres: ['Ambient'] });
  const rows = libraryRows(id, { energy: 'low' });
  const mood = moodPoolRow(id);
  for (const [reader, row] of rows) {
    assert.equal(carriesVocalEvidence(row), true, `${reader} carries both windows`);
    assert.equal(trackInstrumental(row), null, `${reader}: unmeasured before the write`);
  }
  assert.equal(carriesVocalEvidence(mood), false, 'a mood-pool row carries no vocal fields');

  // Singing measured in the tail lands after the rows were read.
  db.requireDb().prepare('UPDATE tracks SET outro_json = ? WHERE id = ?').run(sungOutro, id);

  for (const [reader, row] of rows) {
    assert.equal(trackInstrumental(row), null, `${reader}: answered from the row, not looked up`);
    assert.equal(slim(row).instrumental ?? null, null, `${reader}: the picker payload reads the same evidence`);
  }
  assert.equal(trackInstrumental({ id }), false, '`{ id }` looks the track up');
  assert.equal(trackInstrumental(rawChild(id)), false, 'a raw Subsonic child looks the track up');
  assert.equal(trackInstrumental(mood), false, 'a mood-pool row looks the track up');
  assert.equal(slim(rawChild(id)).instrumental, false, 'the picker payload looks a raw child up too');
  assert.deepEqual(onlyVocals(rows.map(([, row]) => row), 'vocal'), []);
  assert.equal(onlyVocals([{ id }, mood], 'vocal').length, 2);
});

test('energy: a library row answers from its own fields, mood-pool rows included; `{ id }` and a raw child look it up', () => {
  const id = 'energy-untagged';
  seed(id, { energy: null, genres: ['Ambient'] });
  const rows = [...libraryRows(id, { energy: null }), ['songsByMood', moodPoolRow(id)] as [string, any]];
  for (const [reader, row] of rows) {
    assert.equal(row.energy, null, `${reader} carries energy as an explicit null`);
    assert.equal(trackEnergy(row), null, `${reader}: untagged before the write`);
  }

  db.requireDb().prepare(`UPDATE tracks SET energy = 'high' WHERE id = ?`).run(id);

  for (const [reader, row] of rows) assert.equal(trackEnergy(row), null, `${reader}: answered from the row, not looked up`);
  assert.equal(trackEnergy({ id }), 'high', '`{ id }` looks the track up');
  assert.equal(trackEnergy(rawChild(id)), 'high', 'a raw Subsonic child looks the track up');
  assert.deepEqual(onlyEnergy(rows.map(([, row]) => row), ['high']), []);
  assert.equal(onlyEnergy([{ id }, rawChild(id)], ['high']).length, 2);
});

test('genre: a library row answers from its own fields, mood-pool and blocklist rows included; `{ id }` and raw children look it up', () => {
  const id = 'genre-untagged';
  seed(id, { energy: 'low', genres: null });
  const rows = [
    ...libraryRows(id, { energy: 'low' }),
    ['songsByMood', moodPoolRow(id)],
    ['ruleMatchRows', db.ruleMatchRows().find(r => r.id === id)],
  ] as Array<[string, any]>;
  for (const [reader, row] of rows) {
    assert.ok(row, `${reader} returned the row`);
    assert.equal(row.genre, null, `${reader} carries genre as an explicit null`);
    assert.deepEqual(trackGenres(row), [], `${reader}: untagged before the write`);
  }

  db.requireDb().prepare(`UPDATE tracks SET genres = '["Jazz"]' WHERE id = ?`).run(id);

  for (const [reader, row] of rows) {
    assert.deepEqual(trackGenres(row), [], `${reader}: answered from the row, not looked up`);
    assert.equal(genreMatches(row, ['jazz']), false, `${reader}: genreMatches reads the same`);
  }
  assert.deepEqual(trackGenres({ id }), ['Jazz'], '`{ id }` looks the track up');
  assert.deepEqual(trackGenres(rawChild(id)), ['Jazz'], 'a raw child with no genre fields looks the track up');
  assert.deepEqual(trackGenres(rawChild(id, { genres: [] })), ['Jazz'],
    'an OpenSubsonic child\'s empty `genres` is not the library\'s answer');
  assert.deepEqual(onlyGenre(rows.map(([, row]) => row), ['Jazz']), []);
  assert.equal(onlyGenre([{ id }, rawChild(id, { genres: [] })], ['Jazz']).length, 2);
});

test('a tagged library row still answers from its tags, and an empty row with no id answers empty', () => {
  seed('tagged', { energy: 'medium', genres: ['Dub'], vocal: '[]', outro: null });
  const row = db.candidateFilterTracks().find(r => r.id === 'tagged');
  assert.equal(trackEnergy(row), 'medium');
  assert.deepEqual(trackGenres(row), ['Dub']);
  assert.equal(trackInstrumental(row), true);
  assert.equal(trackEnergy({}), null);
  assert.deepEqual(trackGenres({}), []);
  assert.equal(trackInstrumental({}), null);
});
