// Migration 32. The instrumental verdict gained the tail, which takes the word
// "instrumental" off the Sound: line of some rows. The text format did not change,
// so nothing tells a station to re-embed its library: the migration marks exactly
// the rows whose text moved, and the next phaseEmbed replaces just those. A real
// SQLite database and the real phaseEmbed, with only the embedding endpoint faked,
// because what matters here is which rows get paid for.
//
// Run: npm test -- tail-verdict-vectors

import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-tail-vectors-'));
const DIM = 8;
const embedded: string[] = [];
const vector = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const inputs = z.array(z.string()).parse(JSON.parse(Buffer.concat(chunks).toString()).input);
  embedded.push(...inputs);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    object: 'list', model: 'fixture',
    data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: vector })),
    usage: { prompt_tokens: 1, total_tokens: 1 },
  }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;

process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = baseUrl;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';

const db = await import('../src/music/library-db.js');
const settings = await import('../src/settings.js');
const coverage = await import('../src/music/library-coverage.js');
const { formatTrackText, EMBED_TEXT_VERSION, activeModelLabel } = await import('../src/music/embeddings.js');
const { phaseEmbed } = await import('../src/music/tag-library/embed.js');

const open = () => db.open({ embeddingDim: DIM, adoptStoredDim: true });
await settings.load();
await open();

before(async () => {
  await settings.update({
    embedding: { enabled: true, provider: 'openai-compatible', model: 'fixture',
      providerBaseUrls: { 'openai-compatible': `${baseUrl}/v1` },
      enrichment: { lastfmTags: false, lyrics: false, originalYear: false } },
  } as never);
});
after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(root);
});
beforeEach(() => {
  db.requireDb().exec('DELETE FROM tracks; DELETE FROM track_vectors; DELETE FROM embedding_meta;');
  embedded.length = 0;
});

const version = () => db.requireDb().pragma('user_version', { simple: true });
// Every migration after 32 runs on the same open, so a full open ends at the newest one.
const LATEST = 34;
const sung = (ms: number) => [{ startMs: 200_000, endMs: 200_000 + ms }];
const outro = (vocalRanges?: unknown) => JSON.stringify({
  startMs: 180_000, ending: 'fade', ...(vocalRanges === undefined ? {} : { vocalRanges }),
});

// A row as a station left it: analysed, and embedded unless it says otherwise.
function seed(id: string, head: string | null, outroJson: string | null, { embed = true } = {}) {
  db.upsertTrackMeta(id, { title: id, artist: `Artist ${id}`, album: 'Album', year: 1999, genres: ['Ambient'], duration: 240 });
  db.requireDb()
    .prepare('UPDATE tracks SET bpm = 120, vocal_ranges_json = ?, outro_json = ?, moods = ? WHERE id = ?')
    .run(head, outroJson, embed ? '["calm"]' : null, id);
  if (embed) db.upsertTrackVector(id, vector, db.resolvedEraYearForTrack(id));
}

// The text a vector was built from under each rule. Head-only is what develop
// wrote: the same record with the tail evidence taken off it.
function textOf(id: string, rule: 'both windows' | 'head only' = 'both windows') {
  const t = db.getTrack(id)!;
  const song = { title: t.title, artist: t.artist, album: t.album, year: t.year, genres: t.genres };
  return formatTrackText(song, null, rule === 'both windows'
    ? t
    : { ...t, tailVocalRanges: undefined, tailVocalRangesInvalid: undefined });
}

// What the upgrade does to a station, on the row as develop left it.
async function upgrade(from = 31) {
  db.requireDb().pragma(`user_version = ${from}`);
  db.close();
  await open();
}

const dirtyColumn = (id: string) =>
  (db.requireDb().prepare('SELECT text_vector_dirty AS d FROM tracks WHERE id = ?').get(id) as { d: number }).d;

test('a station with no tail measurements gains nothing and pays nothing', async () => {
  seed('never-analysed', null, null);
  seed('lean', null, outro());
  seed('head-only-instrumental', '[]', outro());
  seed('head-only-vocal', JSON.stringify([{ startMs: 1_000, endMs: 30_000 }]), outro());
  db.setEmbeddingMeta(activeModelLabel()!, DIM, null, EMBED_TEXT_VERSION);
  const ids = ['never-analysed', 'lean', 'head-only-instrumental', 'head-only-vocal'];
  const before = ids.map(id => textOf(id));

  await upgrade();

  assert.equal(version(), LATEST);
  assert.deepEqual(db.textVectorDirtyIds(), [], '0 rows dirty');
  assert.deepEqual(ids.map(id => textOf(id)), before, 'byte-identical text');
  await phaseEmbed([], 8, 'plain');
  assert.deepEqual(embedded, [], 'no embed call on the next pass');
  const state = await coverage.get();
  assert.equal(state.embeddingFormatStale, false, 'no banner');
  assert.equal(state.embeddedTextFormat, EMBED_TEXT_VERSION, 'the format is left alone');
});

test('a Demucs station re-embeds only the rows whose text changes, and they lose the word', async () => {
  const headBleed = JSON.stringify([{ startMs: 1_207, endMs: 4_168 }]);
  const expectedDirty = [
    'reported', 'head-bleed-then-sung', 'tail-exactly-tolerance', 'tail-bad-span',
  ];
  seed('reported', '[]', outro(sung(15_000)));
  seed('head-bleed-then-sung', headBleed, outro(sung(15_000)));
  seed('tail-exactly-tolerance', '[]', outro(sung(5_000)));
  seed('tail-bad-span', '[]', outro([{ startMs: 'nope', endMs: 3 }]));
  // Instrumental before and after, so the same text.
  seed('tail-bleed', '[]', outro(sung(4_999)));
  seed('bleed-in-both', headBleed, outro(sung(2_961)));
  seed('tail-measured-clean', '[]', outro([]));
  // Vocal before and after, so the word was never there.
  seed('head-sung', JSON.stringify([{ startMs: 1_000, endMs: 30_000 }]), outro(sung(15_000)));
  seed('head-malformed', 'not json', outro(sung(15_000)));
  // Unknown to vocal: the word is written for `true` alone, so the text stays put.
  seed('unknown-head-tail-sung', null, outro(sung(15_000)));
  // The verdict moves, but there is no vector to replace.
  seed('no-vector', '[]', outro(sung(15_000)), { embed: false });
  // No readable tail: no evidence, so the head still decides.
  seed('broken-outro', '[]', '{not json');
  seed('tail-is-a-string', '[]', outro('[{"startMs":0,"endMs":9000}]'));

  const ids = (db.requireDb().prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(r => r.id);
  await upgrade();

  assert.deepEqual(db.textVectorDirtyIds().sort(), [...expectedDirty].sort());
  assert.equal(dirtyColumn('no-vector'), 0, 'a row with no vector is not marked');
  // The real text function is the judge, so the list above is no second copy of the rule.
  for (const id of ids) {
    const changed = textOf(id, 'head only') !== textOf(id);
    assert.equal(db.textVectorDirtyIds().includes(id), changed && db.hasVector(id), id);
  }

  await phaseEmbed([], 8, 'plain');
  assert.equal(embedded.length, expectedDirty.length, 'only the marked rows are paid for');
  for (const id of expectedDirty) {
    const text = embedded.find(input => input.includes(`Artist ${id} `));
    assert.match(String(text), /Sound: upbeat tempo/, id);
    assert.doesNotMatch(String(text), /instrumental/, id);
  }
  assert.ok(textOf('tail-bleed').includes('instrumental'), 'a row left alone keeps the word');
  assert.deepEqual(db.textVectorDirtyIds(), [], 'replacing a vector clears its mark');

  embedded.length = 0;
  await phaseEmbed([], 8, 'plain');
  assert.deepEqual(embedded, [], 'and the pass after that has nothing to do');
});

test('it runs once, and a wound-back user_version only marks the same rows again', async () => {
  seed('reported', '[]', outro(sung(15_000)));
  seed('tail-bleed', '[]', outro(sung(3_000)));
  await upgrade();
  assert.deepEqual(db.textVectorDirtyIds(), ['reported']);
  await phaseEmbed([], 8, 'plain');
  assert.deepEqual(db.textVectorDirtyIds(), []);

  db.close();
  await open();
  assert.deepEqual(db.textVectorDirtyIds(), [], 'an upgraded station is left alone on every later open');
  assert.equal(version(), LATEST);

  // A downgrade or a hand repair: every step from 28 on runs again.
  await upgrade(27);
  assert.equal(version(), LATEST);
  assert.deepEqual(db.textVectorDirtyIds(), ['reported'], 'no wider than the first time');
});

test('a failure warns, the station still opens, and the later steps still run', async () => {
  seed('reported', '[]', outro(sung(15_000)));
  seed('also-sung', '[]', outro(sung(9_000)));
  db.requireDb().exec(`CREATE TRIGGER refuse_mark BEFORE UPDATE OF text_vector_dirty ON tracks
    BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    await upgrade();
  } finally {
    console.warn = warn;
  }

  assert.ok(db.isOpen(), 'the station opened');
  assert.equal(db.getTrack('reported')?.title, 'reported', 'and answers reads');
  assert.ok(warnings.some(line => line.includes('disk on fire')), warnings.join('\n'));
  assert.deepEqual(db.textVectorDirtyIds(), [], 'all or nothing');
  assert.equal(version(), LATEST, 'the steps after it ran');

  // A later step has moved user_version on, so the mark is not tried again:
  // the rows keep the text they had, which still works.
  db.requireDb().exec('DROP TRIGGER refuse_mark');
  db.close();
  await open();
  assert.equal(version(), LATEST);
  assert.deepEqual(db.textVectorDirtyIds(), []);
});

test('a fresh database, with no vector table yet, migrates like any other', async () => {
  const d = db.requireDb();
  seed('reported', '[]', outro(sung(15_000)));
  d.exec('DROP TABLE track_vectors');
  await upgrade();
  assert.equal(version(), LATEST);
  assert.equal(dirtyColumn('reported'), 0);
});

test('the same rows are marked with the count index missing, a station that never built it', async () => {
  seed('reported', '[]', outro(sung(15_000)));
  seed('tail-bleed', '[]', outro(sung(3_000)));
  db.requireDb().exec('DROP INDEX idx_tracks_vocal_measured');
  await upgrade();
  assert.deepEqual(db.textVectorDirtyIds(), ['reported']);
});

test('a station with no vocal analysis pays an index probe, never a scan of the wide rows', () => {
  const plan = (db.requireDb().prepare(`EXPLAIN QUERY PLAN ${db.TAIL_SUNG_VECTORS_SQL}`).all() as Array<{ detail: string }>)
    .map(row => row.detail);
  assert.ok(plan.some(step => step.includes('idx_tracks_vocal_measured')), plan.join(' | '));
  assert.ok(!plan.some(step => step.startsWith('SCAN tracks')), plan.join(' | '));
});

test('the outro is read only where the head leaves the word in play', async () => {
  seed('head-sung', JSON.stringify([{ startMs: 1_000, endMs: 30_000 }]), outro(sung(15_000)));
  seed('head-instrumental', '[]', outro(sung(15_000)));
  const d = db.requireDb();
  const read: string[] = [];
  d.function('json_valid', { deterministic: false }, (text: string | null) => {
    read.push(String(text));
    return 1;
  });
  try {
    assert.equal(d.prepare(db.TAIL_SUNG_VECTORS_SQL).run().changes, 1);
  } finally {
    db.close();
    await open();
  }
  assert.equal(read.length, 1, 'only the row the head calls instrumental');
});
