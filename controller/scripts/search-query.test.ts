// The query language (music/search-query.ts): liqe parses, compileSql turns the
// AST into a WHERE over library-db `tracks`. Run against a temp library-db.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-search-query-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { compileSearch, compileSql, describeQuery, parseQuery, QuerySyntaxError } = await import('../src/music/search-query.js');
await db.open({ embeddingDim: 4 });

type Row = { id: string; title: string; artist: string; album: string; genres: string[]; year: number; moods?: string[]; energy?: 'low' | 'medium' | 'high'; bpm?: number };
const rows: Row[] = [
  { id: 'live', title: 'Song Name (Live)', artist: 'Some Artist', album: 'Concert', genres: ['Pop'], year: 2005, energy: 'high', bpm: 150 },
  { id: 'remix', title: 'Song (Club Remix)', artist: 'Some Artist', album: 'Singles', genres: ['Dance Pop'], year: 2012, bpm: 128 },
  { id: 'liver', title: 'Liver', artist: 'The Band', album: 'Greatest Hits', genres: ['Punk Rock'], year: 1995 },
  { id: 'trap', title: 'Drill', artist: 'Someone feat. The Guest', album: 'Mixtape', genres: ['Trap'], year: 2019, moods: ['dark'] },
  { id: 'abba', title: 'Dancing Queen', artist: 'ABBA', album: 'Arrival', genres: ['Pop'], year: 1976, moods: ['celebratory'] },
  { id: 'xmas', title: 'Last Christmas', artist: 'Wham!', album: '100% Hits', genres: ['Christmas Rock'], year: 1984, moods: ['calm'] },
  { id: 'asa', title: 'Visa', artist: 'Åsa Jinder', album: 'Folk', genres: ['Folk'], year: 1990, moods: ['ärlig'] },
  { id: 'acdc', title: 'Thunderstruck', artist: 'AC/DC', album: 'The Razors Edge', genres: ['Hard Rock', 'R&B'], year: 1990 },
  { id: 'gnr', title: 'Don’t Cry', artist: 'Guns N’ Roses', album: 'Use Your Illusion I', genres: ['Hard Rock'], year: 1991 },
];
for (const r of rows) {
  db.upsertTrackMeta(r.id, { title: r.title, artist: r.artist, album: r.album, genres: r.genres, year: r.year });
  // The Library tab lists tagged tracks only.
  db.upsertTrackTags(r.id, { moods: r.moods ?? ['neutral'], energy: r.energy ?? 'medium', source: 'llm', model: 'test-model' });
  if (r.bpm) db.upsertTrackAnalysis(r.id, { bpm: r.bpm });
}

const ids = (q: string) => db.filter({ query: compileSql(parseQuery(q)), limit: 50 }).rows.map((r) => r.id).sort();
const search = (q: string) => {
  const { query, error } = compileSearch(q);
  return { ids: db.filter({ query, limit: 50 }).rows.map((r) => r.id).sort(), error: error?.message ?? null };
};

test('bare terms and fields are case-insensitive substrings', () => {
  assert.deepEqual(ids('live'), ['live', 'liver']);
  assert.deepEqual(ids('title:"(live)"'), ['live'], 'quoted is a phrase, still case-insensitive');
  assert.deepEqual(ids('åsa'), ['asa'], 'Unicode case folding');
  assert.deepEqual(ids('album:"100%"'), ['xmas'], '% is literal');
});

test("unquoted * and ? are liqe's unanchored wildcards", () => {
  assert.deepEqual(ids('title:son*name'), ['live']);
  assert.deepEqual(ids('title:dr?ll'), ['trap']);
  assert.deepEqual(ids('title:dri*ll'), [], '`*` is one or more characters, not zero');
  assert.deepEqual(ids('title:"son*"'), [], 'quoted: `*` is literal');
});

test('regex nodes run as RE2', () => {
  assert.deepEqual(ids('title:/\\((live|remix)\\)/'), ['live']);
  assert.deepEqual(ids('/\\bclub remix\\b/'), ['remix'], 'implicit field');
  assert.deepEqual(ids('artist:/^the /'), ['liver']);
});

test(':= is an exact name; on artist it also matches a credited act', () => {
  assert.deepEqual(ids('artist:="abba"'), ['abba']);
  assert.deepEqual(ids('artist:="The Guest"'), ['trap']);
  assert.deepEqual(ids('title:="Song"'), []);
});

test('genre, tag and mood match the value or a word-aligned refinement', () => {
  assert.deepEqual(ids('genre:punk'), ['liver']);
  assert.deepEqual(ids('genre:rap'), [], '"Trap" is not "Rap"');
  assert.deepEqual(ids('genre:pop'), ['abba', 'live', 'remix']);
  assert.deepEqual(ids('genre:="pop"'), ['abba', 'live']);
  assert.deepEqual(ids('tag:christmas'), ['xmas']);
  assert.deepEqual(ids('mood:calm'), ['xmas']);
  assert.deepEqual(ids('tag:/^christ/'), ['xmas'], 'a regex over the tag lists');
});

test('numbers, ranges, energy and booleans', () => {
  assert.deepEqual(ids('year:[1980 TO 1999]'), ['acdc', 'asa', 'gnr', 'liver', 'xmas']);
  assert.deepEqual(ids('bpm:>140'), ['live']);
  assert.ok(ids('-bpm:>140').includes('liver'), 'NOT keeps a track with no bpm');
  assert.deepEqual(ids('-year:[1980 TO 1999]'), ['abba', 'live', 'remix', 'trap'], 'and one outside the range');
  assert.deepEqual(ids('year:{1984 TO 1995}'), ['acdc', 'asa', 'gnr'], 'exclusive bounds');
  assert.deepEqual(ids('energy:high'), ['live']);
  assert.deepEqual(ids('genre:pop -title:live'), ['abba', 'remix']);
  assert.deepEqual(ids('title:live OR title:remix'), ['live', 'liver', 'remix']);
  assert.deepEqual(ids('NOT (title:live OR title:remix) mood:calm'), ['xmas']);
  assert.deepEqual(ids(''), rows.map((r) => r.id).sort(), 'an empty query matches everything');
});

test('errors carry an offset', () => {
  const offset = (q: string) => { try { compileSql(parseQuery(q)); return null; } catch (e) { assert.ok(e instanceof QuerySyntaxError, String(e)); return (e as InstanceType<typeof QuerySyntaxError>).offset; } };
  assert.equal(offset('nosuchfield:x'), 0);
  assert.equal(offset('title:(live OR remix)'), 6, "liqe does not parse field-scoped groups");
  assert.equal(offset('title:"unclosed'), 'title:"unclosed'.length);
  assert.equal(offset('title:/(live/'), 6, 'RE2 refusal points at the pattern');
  assert.equal(offset('year:>abc'), 6);
  assert.equal(offset('year:true'), 5, 'liqe types true; a year is digits only');
  assert.equal(offset('year:0x10'), 5);
  assert.equal(offset('energy:>high'), 6);
  assert.equal(offset('genre:pop*'), 6, 'a genre takes a name, not a wildcard');
  assert.equal(offset('title://'), 6, 'an empty pattern');
  assert.equal(offset('constructor:x'), 0, 'a prototype key is an unknown field, not a crash');
  assert.equal(offset('playlist:x'), 0);
  assert.equal(offset('energy:hi'), 7, 'energy is low, medium or high');
  assert.equal(offset('x'.repeat(501)), 500, 'a query is capped');
  assert.equal(offset('title:'), 6, 'a field with no value');
  assert.equal(offset('title:>x'), 5, 'text fields take no comparison');
  assert.equal(offset('tag:>x'), 3);
  assert.equal(offset('year:/19/'), 5, 'a number field takes no regex');
  assert.equal(offset('title:live AND'), 'title:live AND'.length, 'input that ends early points at the end');
});

test('tag and mood are Unicode substrings, not the ASCII genre fold', () => {
  assert.deepEqual(ids('mood:ärl'), ['asa']);
  assert.deepEqual(ids('tag:år'), [], 'no false match on "R&B"');
  assert.deepEqual(ids('tag:="hard rock"'), ['acdc', 'gnr']);
});

test('apostrophes fold the way name keys do', () => {
  assert.deepEqual(ids(`title:"don't"`), ['gnr']);
});

test('text that is not a query is searched as plain text, with the reason', () => {
  for (const name of ['AC/DC', "Guns N' Roses", 'Re:Stacks', '12" mixes', 'Name (Live']) {
    assert.ok(search(name).error, `${name} is not a valid query`);
  }
  assert.deepEqual(search('AC/DC').ids, ['acdc']);
  assert.deepEqual(search("Guns N' Roses").ids, ['gnr'], 'curly-apostrophe artist found');
  assert.deepEqual(search('Name (Live').ids, ['live']);
  assert.deepEqual(search('genre:pop -title:live'), { ids: ['abba', 'remix'], error: null }, 'a valid query is a query');
});

test('describeQuery reads a query back in plain words', () => {
  const reads = (q: string) => describeQuery(parseQuery(q));
  assert.equal(reads('live'), 'anywhere "live"');
  assert.equal(reads('title:/^love/'), 'title starts with "love"');
  assert.equal(reads('title:/\\(live\\)$/'), 'title ends with "(live)"');
  assert.equal(reads('title:/\\blove\\b/'), 'title has the word "love"');
  assert.equal(reads('title:/^love$/'), 'title is "love"');
  assert.equal(reads('title:/live|remix/'), 'title matches /live|remix/');
  assert.equal(reads('artist:="ABBA"'), 'artist is "ABBA"');
  assert.equal(reads('title:son*name'), 'title matches son*name');
  assert.equal(reads('son*name'), 'anywhere matches son*name');
  assert.equal(reads('title:/\\bår\\b/'), 'title matches /\\bår\\b/', 'RE2 \\b is ASCII-only: no "has the word" for å');
  assert.equal(reads('genre:pop'), 'genre pop (or a kind of pop)');
  assert.equal(reads('genre:="pop"'), 'genre is "pop"');
  assert.equal(reads('-genre:pop'), 'not genre pop (or a kind of pop)');
  assert.equal(reads('year:[1990 TO 1999]'), 'year 1990–1999');
  assert.equal(reads('bpm:>140'), 'bpm > 140');
  assert.equal(reads('energy:high mood:calm'), 'energy high · mood contains "calm"');
  assert.equal(reads('title:live OR title:remix'), 'title contains "live" or title contains "remix"');
  assert.equal(reads('genre:pop (title:live OR title:remix)'), 'genre pop (or a kind of pop) · (title contains "live" or title contains "remix")');
  // liqe groups left to right, so mixed AND/OR reads with the grouping it runs.
  assert.equal(reads('a OR b c'), '(anywhere "a" or anywhere "b") · anywhere "c"');
  assert.equal(reads('a b OR c'), '(anywhere "a" · anywhere "b") or anywhere "c"');
  assert.equal(reads('NOT (title:live OR title:remix)'), 'not (title contains "live" or title contains "remix")');
  assert.equal(reads(''), '');
  assert.equal(reads('year:{1984 TO 1995}'), 'year > 1984 and < 1995');
  assert.equal(reads('year:[1984 TO 1995}'), 'year ≥ 1984 and < 1995');
  assert.equal(reads('year:{1984 TO 1995]'), 'year > 1984 and ≤ 1995');
  assert.equal(reads('title:'), 'title contains ""');
});

test('a syntax error names the character, not a line and column', () => {
  assert.match(compileSearch('AC/DC').error!.message, /^"\/" is not query syntax here/);
  assert.equal(compileSearch('AC/DC').error!.kind, 'syntax');
  assert.equal(compileSearch('year:>abc').error!.kind, 'meaning', 'valid syntax, wrong value');
  assert.match(compileSearch('title:"unclosed').error!.message, /unclosed quote/);
});

test('a non-parser failure is not dressed up as a syntax error', () => {
  assert.throws(() => parseQuery(123 as never), (e) => !(e instanceof QuerySyntaxError));
  assert.throws(() => compileSearch(undefined as never), (e) => !(e instanceof QuerySyntaxError));
});

test('stored search keys follow every write, including one made without them', () => {
  const d = db.getDb()!;
  assert.deepEqual(ids('title:thunder'), ['acdc']);
  // As an older controller (or any connection without this code) would write.
  d.prepare(`UPDATE tracks SET title = 'Highway Song' WHERE id = 'acdc'`).run();
  assert.deepEqual(ids('title:thunder'), [], 'the old key is gone');
  assert.deepEqual(ids('title:highway'), ['acdc'], 'the new title is found');
  d.prepare(`UPDATE tracks SET title = 'Thunderstruck' WHERE id = 'acdc'`).run();
  // A row with no artist, album or genres keys to empty, not to a crash.
  d.prepare(`INSERT INTO tracks (id, title, moods) VALUES ('bare', 'Bare Song', '["neutral"]')`).run();
  assert.deepEqual(ids('bare'), ['bare']);
  assert.deepEqual(ids('artist:="x" OR genre:pop').includes('bare'), false);
  d.prepare(`DELETE FROM tracks WHERE id = 'bare'`).run();
});

test('migration 29 fills the keys at startup, not on the first search', async () => {
  const d = db.getDb()!;
  // As a database an older build left behind: keys stale, version below 29.
  d.prepare('UPDATE tracks SET search_fresh = NULL, title_key = NULL').run();
  d.pragma('user_version = 28');
  db.close();
  await db.open({ embeddingDim: 4 });
  const row = db.getDb()!.prepare(`SELECT title_key, search_fresh FROM tracks WHERE id = 'acdc'`).get();
  assert.deepEqual(row, { title_key: 'thunderstruck', search_fresh: 1 });
});

test('an upsert that changes nothing leaves the keys fresh', () => {
  const d = db.getDb()!;
  ids('thunder'); // every row fresh
  // As a tagger walk writes every track: the source columns named, unchanged.
  d.prepare('UPDATE tracks SET title = title, artist = artist, album = album, genres = genres').run();
  assert.equal(d.prepare('SELECT COUNT(*) FROM tracks WHERE search_fresh IS NULL').pluck().get(), 0);
});

test('migration 29 replaces an older stale trigger', async () => {
  const d = db.getDb()!;
  // The first definition fired on every write that named a source column.
  d.exec(`DROP TRIGGER tracks_search_stale;
    CREATE TRIGGER tracks_search_stale AFTER UPDATE OF title ON tracks
    BEGIN UPDATE tracks SET search_fresh = NULL WHERE id = NEW.id; END;`);
  d.pragma('user_version = 28');
  db.close();
  await db.open({ embeddingDim: 4 });
  const sql = db.getDb()!.prepare(`SELECT sql FROM sqlite_master WHERE name = 'tracks_search_stale'`).pluck().get();
  assert.match(String(sql), /WHEN NEW\.title IS NOT OLD\.title/);
});

test('genres in every stored shape key like show-filter reads them', () => {
  const d = db.getDb()!;
  const add = d.prepare(`INSERT INTO tracks (id, title, artist, genres, moods, audio_moods) VALUES (?, ?, ?, ?, ?, ?)`);
  add.run('osub', 'Shape One', null, JSON.stringify([{ name: 'Synth Pop' }, { id: 1 }]), '["neutral"]', null);
  add.run('nogenre', 'Shape Three', 'Someone', null, '["neutral"]', '["eerie"]');
  // Untagged, so Browse never lists it, but its keys are still built.
  add.run('untagged', 'Shape Four', 'Someone', null, null, null);
  try {
    assert.deepEqual(ids('genre:pop title:shape'), ['osub'], 'OpenSubsonic { name } objects');
    assert.deepEqual(ids('title:shape -genre:pop'), ['nogenre'], 'no genres key as none');
    assert.deepEqual(ids('mood:eerie'), ['nogenre'], 'audio moods are moods');
  } finally {
    assert.equal(d.prepare(`SELECT search_fresh FROM tracks WHERE id = 'untagged'`).pluck().get(), 1);
    d.prepare(`DELETE FROM tracks WHERE id IN ('osub', 'nogenre', 'untagged')`).run();
  }
});

test('a page past the end still reports the total', () => {
  const r = db.filter({ query: compileSql(parseQuery('genre:pop')), limit: 2, offset: 50 });
  assert.deepEqual({ rows: r.rows.length, total: r.total }, { rows: 0, total: 3 });
  assert.equal(db.filter({ query: compileSql(parseQuery('genre:pop')), limit: 2 }).total, 3, 'from the window on a page');
});

test('a list wildcard does not run from one tag into the next', () => {
  // acdc carries "hard rock" and "r&b": `tag:rock*r` would match across them on the joined list.
  assert.deepEqual(ids('tag:rock*r'), []);
  assert.deepEqual(ids('tag:har*rock'), ['acdc', 'gnr']);
});

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});
