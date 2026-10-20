// The query language (music/search-query.ts): liqe parses, compileSql turns the
// AST into a WHERE over library-db `tracks`. Run against a temp library-db.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-search-query-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { compileSearch, compileSql, describeQuery, parseQuery, QuerySyntaxError } = await import('../src/music/search-query.js');
const { ensureSearchIndex, ensureSearchKeys, refreshSearchKeys } = await import('../src/music/library-db/search-keys.js');
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

test('a text regex sees the name folded as every other text form does', () => {
  assert.deepEqual(ids("title:/don't/"), ['gnr'], 'a straight apostrophe finds "Don’t"');
  assert.deepEqual(ids('title:/don’t/'), ['gnr'], 'and a curly one the same');
  assert.equal(describeQuery(parseQuery("title:/don't/")), 'title contains "don\'t"', 'which is what the box says it ran');
  assert.deepEqual(ids("/n' roses/"), ['gnr'], 'the implicit field too');
});

test('a query takes one regex: a second is refused before liqe reads it', () => {
  for (const q of ['title:/live/ OR title:/remix/', '-title:/live/ -title:/remix/']) {
    const { error, readsAs } = compileSearch(q);
    assert.equal(error?.kind, 'meaning', q);
    assert.match(error!.message, /one \/regex\/.* title:\/a\|b\//, q);
    assert.equal(error!.offset, q.indexOf('/remix/'), 'at the second one');
    assert.equal(readsAs, '');
  }
  // liqe's readings double with every regex: 22 in 87 characters ran out of memory.
  const many = Array(22).fill('/a/').join(' ');
  const started = performance.now();
  assert.equal(compileSearch(many).error?.offset, 4);
  assert.ok(performance.now() - started < 100, 'refused in one pass');
  assert.match(compileSearch(many).error!.message, / as \/a\|b\/$/, 'no field to name');
  assert.deepEqual(search('title:/live|remix/'), { ids: ['live', 'liver', 'remix'], error: null }, 'the alternatives in one');
  // A quote hides a slash only until a regex opens: after one, in some reading
  // the quote sits inside it, and the readings multiply there just the same.
  assert.equal(compileSearch('title:/a/ "x /b/ /c/"').error?.kind, 'meaning');
  assert.deepEqual(search('"/b/ /c/" title:/song/'), { ids: [], error: null }, 'a phrase before the regex is only a phrase');
  assert.equal(compileSearch('"say \\"hi /x/" title:/live/').error, null, 'and an escaped quote does not end it');
  assert.equal(compileSearch('title:/a\\/b/ live').error, null, 'an escaped slash closes nothing');
  assert.equal(compileSearch('AC/DC/ACDC').error?.kind, 'syntax', 'nor does a slash inside a word open one');
});

test('anything else liqe throws on a string is a query error, never a 500', (t) => {
  // liqe trims the text first: make that one call fail as a parser bug would.
  t.mock.method(String.prototype, 'trim', () => { throw new RangeError('a parser bug'); }, { times: 1 });
  const { error, query } = compileSearch('title:live');
  assert.deepEqual({ message: error?.message, offset: error?.offset, kind: error?.kind }, { message: 'This query could not be read', offset: 0, kind: 'meaning' });
  assert.deepEqual(db.filter({ query, limit: 50 }).rows.map((r) => r.id).sort(), [], 'searched as plain text');
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
  const group = compileSearch('title:(live OR remix)').error!;
  assert.equal(group.kind, 'meaning', 'a field-scoped group gets no "search as written" offer, which would find nothing');
  assert.match(group.message, /write title:a OR title:b, or title:\/a\|b\//);
  assert.equal(compileSearch('-(live OR remix)').error!.kind, 'syntax', 'a bracket after no field is still syntax');
  assert.equal(compileSearch('Re:(mix)').error!.kind, 'syntax', 'nor after a word that is not a field');
  assert.equal(compileSearch('year:>abc').error!.kind, 'meaning', 'valid syntax, wrong value');
  assert.match(compileSearch('title:"unclosed').error!.message, /unclosed quote/);
});

test('only text that is no query at all gets the "search as written" offer', () => {
  assert.equal(compileSearch('AC/DC').error!.kind, 'syntax');
  assert.equal(compileSearch("Guns N' Roses").error!.kind, 'syntax');
  assert.equal(compileSearch('year:[1990 TO *]').error!.kind, 'meaning', 'it names a field: a query with a mistake in it');
  assert.equal(compileSearch('Re:(mix) title:x').error!.kind, 'meaning');
  assert.equal(compileSearch('title:live OR').error!.kind, 'incomplete', 'most often still being typed');
  assert.equal(compileSearch('"live at').error!.kind, 'incomplete');
  assert.equal(compileSearch('12" mixes').error!.kind, 'syntax', 'a quote inside a word opens nothing: not a query');
  assert.equal(compileSearch('-title:(live OR remix)').error!.kind, 'meaning', 'a negated field-scoped group names its field');
  // The box's examples (BrowseFilters QUERY_EXAMPLES), typed a key at a time.
  const examples = ['title:/^love/', 'artist:="ABBA"', '-genre:pop year:[1990 TO 1999]', 'title:/\\(live\\)$/',
    'title:/\\blove\\b/', 'title:live OR title:remix', 'bpm:>140', 'mood:calm tag:christmas', 'live'];
  for (const ex of examples) {
    for (let i = 1; i <= ex.length; i++) {
      assert.notEqual(compileSearch(ex.slice(0, i)).error?.kind, 'syntax', ex.slice(0, i));
    }
  }
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

const staleCount = () => db.getDb()!.prepare('SELECT COUNT(*) FROM tracks WHERE search_fresh IS NULL').pluck().get() as number;

test('an open replaces a stale trigger definition, at any user_version', async () => {
  const d = db.getDb()!;
  // The first draft's definition fired on every write that named a source column.
  d.exec(`DROP TRIGGER tracks_search_stale;
    CREATE TRIGGER tracks_search_stale AFTER UPDATE OF title ON tracks
    BEGIN UPDATE tracks SET search_fresh = NULL WHERE id = NEW.id; END;`);
  assert.equal(d.pragma('user_version', { simple: true }), 29, 'already upgraded, so no migration runs');
  db.close();
  await db.open({ embeddingDim: 4 });
  const sql = db.getDb()!.prepare(`SELECT sql FROM sqlite_master WHERE name = 'tracks_search_stale'`).pluck().get();
  assert.match(String(sql), /WHEN NEW\.title IS NOT OLD\.title/);
  assert.ok(staleCount() > 0, 'a replaced trigger may have missed writes, so every row is re-keyed');
  assert.deepEqual(ids('title:thunder'), ['acdc']);
  assert.equal(staleCount(), 0);
});

test('an open puts back the trigger and index a table rebuild dropped', async () => {
  const d = db.getDb()!;
  // A migration that rebuilds tracks drops its triggers and indexes with it,
  // and a write made before the next open goes unmarked.
  d.exec('DROP TRIGGER tracks_search_stale; DROP INDEX tracks_search_stale_idx;');
  d.prepare(`UPDATE tracks SET title = 'Highway Song' WHERE id = 'acdc'`).run();
  assert.equal(staleCount(), 0, 'nothing marked the edit');
  db.close();
  await db.open({ embeddingDim: 4 });
  const names = db.getDb()!.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'tracks_search_stale%' ORDER BY name`).pluck().all();
  assert.deepEqual(names, ['tracks_search_stale', 'tracks_search_stale_idx']);
  assert.deepEqual(ids('title:highway'), ['acdc'], 'the unmarked edit is re-keyed');
  db.getDb()!.prepare(`UPDATE tracks SET title = 'Thunderstruck' WHERE id = 'acdc'`).run();
});

test('a search re-keys one chunk and leaves the rest to the background', async () => {
  const d = db.getDb()!;
  d.prepare('UPDATE tracks SET search_fresh = NULL').run();
  const total = staleCount();
  assert.equal(refreshSearchKeys({ rows: 2 }), false, 'rows left for the background');
  assert.equal(staleCount(), total - 2, 'only the budget, before the search answers');
  for (let i = 0; i < 5 && staleCount(); i++) await new Promise((r) => setImmediate(r));
  assert.equal(staleCount(), 0, 'the drain finishes the rest');
});

// Enough rows for three chunks; tagged, so Browse lists them.
const addBulk = () => {
  const d = db.getDb()!;
  const ins = d.prepare(`INSERT INTO tracks (id, title, moods) VALUES (?, ?, '["neutral"]')`);
  d.transaction(() => { for (let i = 0; i < 2500; i++) ins.run(`bulk-${i}`, `Bulk ${i}`); })();
};
const dropBulk = () => db.getDb()!.prepare(`DELETE FROM tracks WHERE id LIKE 'bulk-%'`).run();
const turns = async (n: number) => { for (let i = 0; i < n && staleCount(); i++) await new Promise((r) => setImmediate(r)); };

test('a bulk re-key drains one chunk per turn of the event loop', async () => {
  addBulk();
  try {
    const total = staleCount();
    assert.ok(total > 2000);
    refreshSearchKeys();
    assert.equal(staleCount(), total - 1000, 'one chunk before the search answers');
    refreshSearchKeys({ rows: 0 });
    await new Promise((r) => setImmediate(r));
    assert.equal(staleCount(), total - 2000, 'then one chunk per turn, from a single drain');
    await turns(5);
    assert.equal(staleCount(), 0);
  } finally {
    dropBulk();
  }
});

test('a drain that loses the lock or the database stops, and the next search resumes', async () => {
  addBulk();
  const other = new Database(join(stateDir, 'library.db'));
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    refreshSearchKeys();
    const left = staleCount();
    other.exec('BEGIN IMMEDIATE');
    await turns(3);
    assert.equal(staleCount(), left, 'a busy chunk re-keys nothing');
    assert.equal(warnings.length, 1);
    other.exec('COMMIT');
    refreshSearchKeys();
    assert.equal(staleCount(), left - 1000, 'the next search resumes');
    db.close();
    await new Promise((r) => setImmediate(r));
    await db.open({ embeddingDim: 4 });
    assert.equal(staleCount(), left - 1000, 'a closed database ends the drain');
    refreshSearchKeys({ rows: Infinity });
    assert.equal(staleCount(), 0);
  } finally {
    console.warn = warn;
    if (other.inTransaction) other.exec('ROLLBACK');
    other.close();
    dropBulk();
  }
});

test('an ensure that cannot write warns and reports it, and never throws', () => {
  const d = db.getDb()!;
  d.exec('DROP TRIGGER tracks_search_stale');
  const readonly = new Database(join(stateDir, 'library.db'), { readonly: true });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    assert.equal(ensureSearchKeys(readonly), false);
    assert.match(warnings[0] ?? '', /search keys not ensured/);
    assert.equal(ensureSearchKeys(d), true, 'the writable handle puts it back');
  } finally {
    console.warn = warn;
    readonly.close();
  }
  assert.deepEqual(ids('title:thunder'), ['acdc']);
});

test('a held write lock neither stalls a search nor fails it', () => {
  const d = db.getDb()!;
  d.prepare('UPDATE tracks SET search_fresh = NULL').run();
  // As the tagger, mid-write, from its own process.
  const other = new Database(join(stateDir, 'library.db'));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    other.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    assert.deepEqual(ids('title:thunder'), ['acdc'], 'answers from the keys it has');
    assert.equal(db.filter({ query: compileSql(parseQuery('title:thunder')), limit: 1 }).reindexing, true, 'and says it may be missing tracks');
    assert.ok(performance.now() - started < 2000, 'well short of the 5 s busy timeout');
    assert.equal(warnings.length, 1, 'one warning for a run of failures');
    assert.match(warnings[0]!, /search keys not refreshed/);
    other.exec('COMMIT');
    ids('title:thunder');
    assert.equal(staleCount(), 0, 'the next search catches up');
  } finally {
    console.warn = warn;
    if (other.inTransaction) other.exec('ROLLBACK');
    other.close();
  }
});

test('stored lists key as the row reads them, and never throw', () => {
  const d = db.getDb()!;
  const add = d.prepare(`INSERT INTO tracks (id, title, artist, genres, moods, audio_moods) VALUES (?, ?, ?, ?, ?, ?)`);
  add.run('osub', 'Shape One', null, JSON.stringify(['Synth Pop', { name: 'Disco' }, { id: 1 }]), '["neutral"]', null);
  // Valid JSON the generated `genre` column accepts, but not a list.
  add.run('scalar', 'Shape Two', 'Someone', '"Rock"', '["neutral"]', null);
  add.run('nogenre', 'Shape Three', 'Someone', null, '["neutral"]', '["eerie"]');
  // Untagged, so Browse never lists it, but its keys are still built.
  add.run('untagged', 'Shape Four', 'Someone', null, null, null);
  try {
    assert.deepEqual(ids('genre:pop title:shape'), ['osub'], 'the string entries');
    assert.deepEqual(ids('genre:disco'), [], 'not an object entry, which rowToTrack drops too');
    assert.deepEqual(ids('title:shape -genre:pop'), ['nogenre', 'scalar'], 'no genres, or not a list, key as none');
    assert.deepEqual(ids('title:shape genre:/rock|disco/'), [], 'and a genre regex reads them the same way');
    assert.deepEqual(ids('title:shape genre:/^synth pop$/'), ['osub']);
    assert.deepEqual(ids('mood:eerie'), ['nogenre'], 'audio moods are moods');
  } finally {
    assert.equal(d.prepare(`SELECT search_fresh FROM tracks WHERE id = 'untagged'`).pluck().get(), 1);
    d.prepare(`DELETE FROM tracks WHERE id IN ('osub', 'scalar', 'nogenre', 'untagged')`).run();
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
  assert.deepEqual(ids('-tag:rock*r title:thunder'), ['acdc'], 'and NOT of one that passes only the list-wide LIKE holds');
});

test('a list wildcard and regex see a tag spaced as its key is', () => {
  const d = db.getDb()!;
  d.prepare(`INSERT INTO tracks (id, title, moods, lastfm_tags) VALUES ('spaced', 'Spaced', '["neutral"]', '["Hip  Hop"]')`).run();
  try {
    assert.deepEqual(ids('tag:"hip hop"'), ['spaced'], 'the stored key');
    assert.deepEqual(ids('tag:hip?hop'), ['spaced'], 'a wildcard, tag by tag');
    assert.deepEqual(ids('tag:/^hip hop$/'), ['spaced'], 'a regex, tag by tag');
  } finally {
    d.prepare(`DELETE FROM tracks WHERE id = 'spaced'`).run();
  }
});

test('malformed list JSON neither fails a search nor matches it', () => {
  const d = db.getDb()!;
  // Writers JSON.stringify these, so only a hand edit or a foreign writer gets here.
  d.prepare(`INSERT INTO tracks (id, title, moods, lastfm_tags, audio_moods) VALUES ('broken', 'Broken', '["neutral"]', 'not json', '{"eerie"')`).run();
  try {
    for (const q of ['tag:/json/', 'tag:no*', 'mood:/eer/', 'mood:ee*', 'genre:/json/']) assert.deepEqual(ids(q), [], q);
    assert.deepEqual(ids('title:broken tag:/^neutral$/'), ['broken'], 'its well-formed list still matches');
  } finally {
    d.prepare(`DELETE FROM tracks WHERE id = 'broken'`).run();
  }
});

test('a search reads the covering index, never the wide rows (#1937)', () => {
  const d = db.getDb()!;
  const tracksPlan = (q: string) => {
    const { query } = compileSearch(q);
    return (d.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM tracks WHERE ${query.sql}`).all(...query.params) as Array<{ detail: string }>)
      .map((r) => r.detail).filter((s) => /\btracks\b/.test(s));
  };
  // One query per compiled form, and the plain-text fallback.
  const queries = ['live', 'title:live', 'title:son*', 'title:="x"', 'artist:="x"', 'title:/^l/', '/x/', 'genre:pop', 'genre:="pop"',
    'genre:/po/', 'tag:calm', 'tag:="calm"', 'tag:c*m', 'mood:/ca/', 'mood:calm', 'year:[1990 TO 1999]', 'bpm:>100', 'energy:high',
    '-genre:pop (year:1990 OR bpm:<90)', 'AC/DC'];
  const check = (label: string) => {
    for (const q of queries) {
      const plan = tracksPlan(q);
      assert.ok(plan.length > 0 && plan.every((s) => /^(SCAN|SEARCH) tracks USING COVERING INDEX /.test(s)), `${label} ${q}: ${plan.join(' | ')}`);
    }
  };
  check('no ANALYZE');
  d.exec('ANALYZE');
  try {
    check('ANALYZE');
  } finally {
    d.exec('DROP TABLE IF EXISTS sqlite_stat1');
  }
});

const coverSql = () => db.getDb()!.prepare(`SELECT sql FROM sqlite_master WHERE name = 'tracks_search_idx'`).pluck().get() as string | undefined;

test('an open builds the covering index, and replaces one that differs', async () => {
  const want = coverSql();
  assert.match(String(want), /\(title_key, .*, era_untrusted, bpm, energy\)$/);
  // As a station that ran migration 29 before the index existed: no migration runs.
  db.getDb()!.exec('DROP INDEX tracks_search_idx');
  db.close();
  await db.open({ embeddingDim: 4 });
  assert.equal(coverSql(), want);
  db.getDb()!.exec('DROP INDEX tracks_search_idx; CREATE INDEX tracks_search_idx ON tracks(title_key)');
  db.close();
  await db.open({ embeddingDim: 4 });
  assert.equal(coverSql(), want, 'a changed definition is replaced');
  assert.deepEqual(ids('title:thunder'), ['acdc']);
});

test('a covering index that cannot be built warns, and searches still answer', () => {
  const d = db.getDb()!;
  d.exec('DROP INDEX tracks_search_idx');
  const readonly = new Database(join(stateDir, 'library.db'), { readonly: true });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    ensureSearchIndex(readonly);
    assert.match(warnings[0] ?? '', /search index not built/);
    assert.deepEqual(ids('title:thunder'), ['acdc'], 'from the table, slower but exact');
  } finally {
    console.warn = warn;
    readonly.close();
    ensureSearchIndex(d);
  }
  assert.ok(coverSql());
});

test('an ensure that finds the index built by a rival opener leaves it alone', () => {
  const d = db.getDb()!;
  // The first look misses it, as before a rival opener's build commits.
  let first = true;
  const racing = new Proxy(d, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => {
          if (first && sql.includes('sqlite_master')) { first = false; return { all: () => [] }; }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const log = console.log;
  const logs: string[] = [];
  console.log = (msg: string) => { logs.push(msg); };
  try {
    ensureSearchIndex(racing);
  } finally {
    console.log = log;
  }
  assert.equal(first, false);
  assert.deepEqual(logs, [], 'no second build');
  assert.ok(coverSql());
});

test('a search says when its keys are still being rebuilt', async () => {
  addBulk();
  try {
    const query = compileSql(parseQuery('title:bulk'));
    const during = db.filter({ query, limit: 5 });
    assert.deepEqual({ reindexing: during.reindexing, total: during.total }, { reindexing: true, total: 1000 }, 'one chunk keyed, the rest still draining');
    await turns(5);
    const after = db.filter({ query, limit: 5 });
    assert.deepEqual({ reindexing: after.reindexing, total: after.total }, { reindexing: false, total: 2500 });
    assert.equal(db.filter({ limit: 1 }).reindexing, undefined, 'a browse with no query says nothing');
    dropBulk();
    // Exactly one chunk stale: the search keys them all, and says it is whole.
    const ins = db.getDb()!.prepare(`INSERT INTO tracks (id, title, moods) VALUES (?, ?, '["neutral"]')`);
    db.getDb()!.transaction(() => { for (let i = 0; i < 1000; i++) ins.run(`bulk-${i}`, `Bulk ${i}`); })();
    assert.equal(refreshSearchKeys(), true);
    assert.equal(staleCount(), 0);
  } finally {
    dropBulk();
  }
});

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});
