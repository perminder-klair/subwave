// Era-suspect albums: review, reason and export.
//
// The walk already decides an album's era is untrustworthy (era-suspect.ts,
// #1418); this is the operator surface for that decision: the reason and the
// album artist stored at walk time (schema step 38), the per-album override
// table that outlives a walk, the grouped listing the admin Library → Era tab
// reads, the CSV export, and the routes over them.
//
// The walk itself is not run here (it needs Navidrome); the override-aware
// per-song write is era-review.eraWalkFields, the exact computation
// walkNavidrome feeds into upsertTrackMeta, pinned here the way
// scene-vocab.test.ts pins the walk's field mapping.
//
// Run: npm test -- era-review

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-era-review-'));
process.env.STATE_DIR = dir;
// requireAdmin reads these at import time, so they must be set before the
// route module (and with it middleware/auth.js) is first imported below.
process.env.ADMIN_USER = 'era-test-admin';
process.env.ADMIN_PASS = 'era-test-pass';

const express = (await import('express')).default;
const db = await import('../src/music/library-db.js');
const era = await import('../src/music/era-review.js');
const { listen: listenHttp } = await import('./test-utils/http.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const eraSuspect = await import('../src/music/era-suspect.js');
const { ERA_YEAR_SQL } = await import('../src/music/library-db/browse.js');
const { router: eraRoutes } = await import('../src/routes/library/era.js');
const app = express();
app.use(express.json());
app.use(eraRoutes);
const { server, url: base } = await listenHttp(app);
server.unref();

// The HTTP server is unref()ed, so it never needs closing for exit.
after(async () => { db.close(); await removeTempDir(dir); });

const d = () => db.getDb()!;
const cols = () => new Set((d().pragma('table_info(tracks)') as Array<{ name: string }>).map(c => c.name));
const hasTable = (name: string) =>
  !!d().prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
const row = (id: string) => d()
  .prepare('SELECT era_untrusted, era_reason, album_artist, text_vector_dirty, year, original_year, original_year_checked_at FROM tracks WHERE id = ?')
  .get(id) as { era_untrusted: number | null; era_reason: string | null; album_artist: string | null; text_vector_dirty: number; year: number | null; original_year: number | null; original_year_checked_at: string | null } | undefined;

// ── (a) schema step 38 ───────────────────────────────────────────────────────

test('step 38 adds era_reason, album_artist, album_kind and the era_override table on an older db', () => {
  // A fresh open already ran every step; wind the db back to before 38 by
  // removing exactly what that step owns, then reopen and watch it rebuild.
  assert.equal(d().pragma('user_version', { simple: true }) as number >= 38, true);
  d().exec(`
    DROP TABLE era_override;
    ALTER TABLE tracks DROP COLUMN era_reason;
    ALTER TABLE tracks DROP COLUMN album_artist;
    ALTER TABLE tracks DROP COLUMN album_kind;
  `);
  d().pragma('user_version = 37');
  assert.equal(cols().has('era_reason'), false);
  assert.equal(hasTable('era_override'), false);

  db.close();
  return db.open({ embeddingDim: 8, adoptStoredDim: true }).then(() => {
    for (const c of ['era_reason', 'album_artist', 'album_kind']) assert.equal(cols().has(c), true, c);
    assert.equal(hasTable('era_override'), true);
    const oc = (d().pragma('table_info(era_override)') as Array<{ name: string }>).map(c => c.name);
    assert.deepEqual(oc, ['album_key', 'verdict', 'forced_year', 'kind', 'set_at']);
    assert.equal(d().pragma('user_version', { simple: true }) as number, 38);
    // A kind alone (no decision) is a valid row; an unknown decision is not.
    d().prepare(`INSERT INTO era_override (album_key, verdict, kind, set_at) VALUES (?, NULL, 'dj-mix', 'now')`).run('k\u0000only');
    assert.throws(() => d().prepare(`INSERT INTO era_override (album_key, verdict, set_at) VALUES (?, 'maybe', 'now')`).run('k\u0000bad'));
    d().exec(`DELETE FROM era_override`);
  });
});

test('step 38 on a db that already has its columns and table adds nothing and keeps the rows', () => {
  // A db wound back below the step keeps what it already has (see step 28).
  d().prepare(`INSERT INTO era_override (album_key, verdict, set_at) VALUES (?, 'trusted', '2026-10-24T00:00:00Z')`).run('a\u0000b');
  d().pragma('user_version = 37');
  db.close();
  return db.open({ embeddingDim: 8, adoptStoredDim: true }).then(() => {
    assert.equal(d().pragma('user_version', { simple: true }) as number, 38);
    const row = d().prepare(`SELECT verdict, set_at FROM era_override WHERE album_key = ?`).get('a\u0000b') as any;
    assert.deepEqual({ ...row }, { verdict: 'trusted', set_at: '2026-10-24T00:00:00Z' });
    d().exec(`DELETE FROM era_override`);
  });
});

test('era_override refuses a verdict outside trusted/suspect/year', () => {
  assert.throws(() => d()
    .prepare(`INSERT INTO era_override(album_key, verdict, set_at) VALUES ('k', 'maybe', 'now')`)
    .run());
});

// ── (b) the walk persists reason and album artist ────────────────────────────

test('upsertTrackMeta stores era_reason and album_artist, and a writer without them keeps them', () => {
  db.upsertTrackMeta('p1', {
    title: 'Song', artist: 'Someone', album: 'Greatest Hits',
    eraUntrusted: true, eraReason: 'title-compilation', albumArtist: 'Someone',
  });
  assert.deepEqual(row('p1') && {
    era_untrusted: row('p1')!.era_untrusted,
    era_reason: row('p1')!.era_reason,
    album_artist: row('p1')!.album_artist,
  }, { era_untrusted: 1, era_reason: 'title-compilation', album_artist: 'Someone' });
  // A manual edit or analyzer top-up has neither; COALESCE keeps them.
  db.upsertTrackMeta('p1', { title: 'Song (single edit)' });
  assert.equal(row('p1')!.era_reason, 'title-compilation');
  assert.equal(row('p1')!.album_artist, 'Someone');
  // Neutralise it so the listing fixtures below count only their own albums.
  db.upsertTrackMeta('p1', { eraUntrusted: false });
});

// ── (c) the override-aware walk write ────────────────────────────────────────

test('a trusted override stores 0 while the walk reason survives', () => {
  const overrides = new Map([[era.albumEraKey('Various Artists', 'Summer 1998'), { verdict: 'trusted' as const, forcedYear: null, kind: null }]]);
  const f = era.eraWalkFields({
    albumArtist: 'Various Artists', album: 'Summer 1998',
    albumEraUntrusted: true, albumEraReason: 'various-artists',
  }, overrides);
  assert.deepEqual(f, { eraUntrusted: false, eraReason: 'various-artists', albumArtist: 'Various Artists', albumKind: 'chart', forcedYear: null });
  db.upsertTrackMeta('w1', { title: 'Track One', artist: 'Band', album: 'Summer 1998', ...f });
  assert.equal(row('w1')!.era_untrusted, 0);
  assert.equal(row('w1')!.era_reason, 'various-artists', 'the walk reason is audit truth, the override never rewrites it');
});

test('a suspect override flips a walk verdict that was clear', () => {
  const overrides = new Map([[era.albumEraKey('Solo Artist', 'The Anthology 1970-1975'), { verdict: 'suspect' as const, forcedYear: null, kind: null }]]);
  const f = era.eraWalkFields({
    albumArtist: 'Solo Artist', album: 'The Anthology 1970-1975',
    albumEraUntrusted: false, albumEraReason: null,
  }, overrides);
  assert.equal(f.eraUntrusted, true);
  assert.equal(f.eraReason, null);
});

// ── (d) the override survives repeated walks ─────────────────────────────────

test('trusted override survives a second walk and a third', () => {
  const overrides = new Map([[era.albumEraKey('Various Artists', 'Summer 1998'), { verdict: 'trusted' as const, forcedYear: null, kind: null }]]);
  for (let i = 0; i < 2; i++) {
    const f = era.eraWalkFields({
      albumArtist: 'Various Artists', album: 'Summer 1998',
      albumEraUntrusted: true, albumEraReason: 'various-artists',
    }, overrides);
    db.upsertTrackMeta('w1', { title: 'Track One', artist: 'Band', album: 'Summer 1998', ...f });
    assert.equal(row('w1')!.era_untrusted, 0, `walk ${i + 2}`);
  }
  // Without the override in the map (i.e. after a Reset), the same walk flips
  // the row back — that is how Reset takes effect.
  const f = era.eraWalkFields({
    albumArtist: 'Various Artists', album: 'Summer 1998',
    albumEraUntrusted: true, albumEraReason: 'various-artists',
  }, new Map());
  db.upsertTrackMeta('w1', { title: 'Track One', artist: 'Band', album: 'Summer 1998', ...f });
  assert.equal(row('w1')!.era_untrusted, 1);
  // Put it back for the listing fixtures below.
  db.upsertTrackMeta('w1', { eraUntrusted: false });
});

// ── (e) setEraOverride applies immediately ───────────────────────────────────

test('setEraOverride flips existing rows at once and marks text_vector_dirty only where the value actually changes', () => {
  // Four tracks on one album key, in each stored state, all clean to start.
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, text_vector_dirty, year)
    VALUES
      ('x1', 'One',   'QA', 'QA Album', 'QA Artist', 1,    'compilation-flag', 0, 1994),
      ('x2', 'Two',   'QA', 'QA Album', 'QA Artist', 1,    'compilation-flag', 0, 1994),
      ('x3', 'Three', 'QA', 'QA Album', 'QA Artist', 0,    NULL,               0, 1994),
      ('x4', 'Four',  'QA', 'QA Album', 'QA Artist', NULL, NULL,               0, 1994);
  `);
  const key = era.albumEraKey('QA Artist', 'QA Album');
  const affected = era.setEraOverride(d(), key, 'trusted');
  // x3 was already 0: not flipped, not dirty. x1, x2, x4 all change value.
  assert.equal(affected, 3);
  assert.equal(row('x1')!.era_untrusted, 0);
  assert.equal(row('x1')!.text_vector_dirty, 1);
  assert.equal(row('x2')!.text_vector_dirty, 1);
  assert.equal(row('x3')!.text_vector_dirty, 0, 'already trusted: untouched');
  assert.equal(row('x4')!.era_untrusted, 0, 'NULL means no evidence, trusted normalizes it to 0');
  assert.equal(row('x4')!.text_vector_dirty, 1);
  // And the override itself is recorded, so the next walk agrees.
  assert.equal(era.loadEraOverrides(d()).get(key)!.verdict, 'trusted');

  // Suspect over a trusted row flips it the other way.
  assert.equal(era.setEraOverride(d(), key, 'suspect'), 4);
  assert.equal(row('x3')!.era_untrusted, 1);
  assert.equal(row('x3')!.text_vector_dirty, 1);
  assert.equal(row('x1')!.text_vector_dirty, 1, 'stays dirty; no second marking needed');
});

test('Reset drops the override and restores the walk verdict at once, from the stored reason', () => {
  const key = era.albumEraKey('QA Artist', 'QA Album');
  era.setEraOverride(d(), key, 'trusted');
  assert.equal(row('x1')!.era_untrusted, 0);
  assert.equal(row('x3')!.era_untrusted, 0);
  d().exec(`UPDATE tracks SET text_vector_dirty = 0 WHERE id IN ('x1','x2','x3','x4')`);
  // x1/x2 carry the walk's reason, so the walk flagged them: back to 1. x3/x4
  // have none, so the walk found nothing: they stay 0 and are not touched.
  assert.equal(era.setEraOverride(d(), key, null), 2, 'tracks whose verdict changed');
  assert.equal(era.loadEraOverrides(d()).has(key), false);
  assert.equal(row('x1')!.era_untrusted, 1);
  assert.equal(row('x2')!.era_untrusted, 1);
  assert.equal(row('x1')!.text_vector_dirty, 1);
  assert.equal(row('x3')!.era_untrusted, 0);
  assert.equal(row('x3')!.text_vector_dirty, 0, 'unchanged, so not dirty');
  // The album stays on the list across the Reset (it never drops off between
  // the click and the next walk).
  assert.ok(era.listEraAlbums(d()).some(a => a.albumKey === key));
  // The next walk agrees with what Reset restored.
  const f = era.eraWalkFields(
    { albumArtist: 'QA Artist', album: 'QA Album', albumEraUntrusted: true, albumEraReason: 'compilation-flag' },
    era.loadEraOverrides(d()),
  );
  assert.equal(f.eraUntrusted, true);
  // Resetting a key with no override is a no-op, not an error.
  assert.equal(era.setEraOverride(d(), era.albumEraKey('Nobody', 'Nowhere'), null), 0);
});

test('Reset leaves a row the walk has not judged since the update to the walk', () => {
  // Pre-step-32 rows: flagged, but no album artist and no reason stored yet.
  d().exec(`INSERT INTO tracks (id, title, artist, album, era_untrusted) VALUES ('u1', 'Old', 'Old', 'Old Album', 1)`);
  const key = era.albumEraKey(null, 'Old Album');
  assert.equal(era.albumScanned(d(), key), false);
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.scanned, false);
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.verdict, null);
  assert.equal(era.setEraOverride(d(), key, null), 0);
  assert.equal(row('u1')!.era_untrusted, 1, 'a missing reason on an unscanned row says nothing');
  d().exec(`DELETE FROM tracks WHERE id = 'u1'`);
});

test('the walk writes its reason with its verdict, so an album it no longer flags loses the old reason', () => {
  db.upsertTrackMeta('r1', { title: 'R', artist: 'R', album: 'Best Of R', albumArtist: 'R', eraUntrusted: true, eraReason: 'title-compilation' });
  assert.equal(row('r1')!.era_reason, 'title-compilation');
  db.upsertTrackMeta('r1', { title: 'R', artist: 'R', album: 'R', albumArtist: 'R', eraUntrusted: false, eraReason: null });
  assert.equal(row('r1')!.era_reason, null);
  assert.equal(row('r1')!.era_untrusted, 0);
});

test('an override re-embeds only tracks whose Era: line moves: no resolved year, and a file year', () => {
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, text_vector_dirty, year, original_year)
    VALUES
      ('v1', 'Open',     'V', 'V Album', 'V Artist', 1, 'many-artists', 0, 1988, NULL),
      ('v2', 'Resolved', 'V', 'V Album', 'V Artist', 1, 'many-artists', 0, 1988, 1969),
      ('v3', 'No year',  'V', 'V Album', 'V Artist', 1, 'many-artists', 0, NULL, NULL);
  `);
  const key = era.albumEraKey('V Artist', 'V Album');
  assert.equal(era.setEraOverride(d(), key, 'trusted'), 3, 'all three verdicts change');
  assert.equal(row('v1')!.text_vector_dirty, 1, 'its era goes from unknown to 1988');
  assert.equal(row('v2')!.text_vector_dirty, 0, 'the resolved 1969 wins either way: vector kept');
  assert.equal(row('v3')!.text_vector_dirty, 0, 'no year either way: vector kept');
  era.setEraOverride(d(), key, null);
  d().exec(`DELETE FROM tracks WHERE id IN ('v1','v2','v3')`);
});

test('albumEraKey folds the way SQLite does, so non-ASCII names key the same on both sides', () => {
  const names: Array<[string | null, string]> = [
    ['Serge Gainsbourg', "Volume 7 L'Homme À La Tête De Chou 1975-1978"],
    ['Erlend Øye', 'DJ-Kicks'],
    ['  Ça Va  ', ' ÉTÉ '],
    [null, 'Bare Album'],
    ['\tTabbed', 'Album\u00a0'],
  ];
  const sql = d().prepare(`SELECT ${era.ERA_ALBUM_KEY_SQL} AS k FROM (SELECT ? AS album_artist, ? AS album)`);
  for (const [artist, album] of names) {
    assert.equal(era.albumEraKey(artist, album), (sql.get(artist, album) as { k: string }).k, `${artist} / ${album}`);
  }
  // And end to end: an override on such an album is accepted and applied.
  db.upsertTrackMeta('n1', { title: 'N', artist: 'Serge Gainsbourg', album: names[0][1], albumArtist: 'Serge Gainsbourg',
    year: 1989, eraUntrusted: true, eraReason: 'title-year-range' });
  const key = era.albumEraKey('Serge Gainsbourg', names[0][1]);
  assert.equal(era.albumScanned(d(), key), true);
  assert.equal(era.setEraOverride(d(), key, 'trusted'), 1);
  assert.equal(row('n1')!.era_untrusted, 0);
  era.setEraOverride(d(), key, null);
  d().exec(`DELETE FROM tracks WHERE id = 'n1'`);
});

// ── (f) listing + summary ────────────────────────────────────────────────────

test('listEraAlbums groups by (album, album_artist) over suspect-or-overridden tracks, biggest first', () => {
  // Album "QA Album" (4 tracks) sits un-overridden and trusted from the Reset
  // test above; make it suspect again through the override, so it is listed
  // with `overridden` set. Add a two-track override album and an ordinary
  // album that must never appear.
  era.setEraOverride(d(), era.albumEraKey('QA Artist', 'QA Album'), 'suspect');
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason)
    VALUES
      ('g1', 'G1', 'Band L', 'Lounging 1970-1975', 'Band L', 1, 'title-year-range'),
      ('g2', 'G2', 'Band L', 'Lounging 1970-1975', 'Band L', 1, 'title-year-range'),
      ('g3', 'G3', 'Ordinary', 'Normal Album',     'Ordinary', 0, NULL);
  `);
  era.setEraOverride(d(), era.albumEraKey('Band L', 'Lounging 1970-1975'), 'trusted');
  era.setEraOverride(d(), era.albumEraKey('Band L', 'Lounging 1970-1975'), 'suspect');

  const albums = era.listEraAlbums(d());
  const qa = albums.find(a => a.album === 'QA Album')!;
  assert.equal(qa.albumKey, era.albumEraKey('QA Artist', 'QA Album'));
  assert.equal(qa.albumArtist, 'QA Artist');
  assert.equal(qa.tracks, 4);
  assert.equal(qa.reason, 'compilation-flag');
  assert.equal(qa.overridden, true);
  assert.equal(qa.verdict, 'suspect');
  assert.equal(qa.scanned, true);
  const ll = albums.find(a => a.album === 'Lounging 1970-1975')!;
  assert.equal(ll.tracks, 2);
  assert.equal(ll.overridden, true);
  // year_state tallies: g-rows are unchecked (no original_year, no stamp);
  // give x1 a resolved year and x2 a not-found stamp.
  d().prepare(`UPDATE tracks SET original_year = 1971 WHERE id = 'x1'`).run();
  d().prepare(`UPDATE tracks SET original_year_checked_at = '2026-10-01T00:00:00Z' WHERE id = 'x2'`).run();
  const qa2 = era.listEraAlbums(d()).find(a => a.album === 'QA Album')!;
  assert.equal(qa2.yearResolved, 1);
  assert.equal(qa2.yearNotFound, 1);
  assert.equal(qa2.yearUnchecked, 2);
  // Ordinary albums never show up.
  assert.equal(albums.some(a => a.album === 'Normal Album'), false);
  // Ordered by track count descending.
  const counts = era.listEraAlbums(d()).map(a => a.tracks);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));

  const summary = era.countEraSummary(d());
  assert.equal(summary.albums, 2);
  assert.equal(summary.tracks, 6);
  assert.equal(summary.overridden, 2);
  // byReason counts tracks per stored walk reason; x3/x4 and the g-rows'
  // NULL-reason tracks appear in `tracks` but under no reason key.
  assert.deepEqual(summary.byReason, { 'compilation-flag': 2, 'title-year-range': 2 });
});

// ── (g) CSV export ───────────────────────────────────────────────────────────

test('exportEraCsv: RFC4180 header, quoting, and year_state values', () => {
  // A title with a comma and a quote exercises both halves of RFC4180 here.
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, year, original_year, file_path, file_suffix, bit_rate, file_size, duration_sec)
    VALUES
      ('c1', 'Hello, "World"', 'QA', 'QA Album', 'QA Artist', 1, 'compilation-flag', 2020, NULL, '/m/qa/01.flac', 'flac', 900, 12345, 210),
      ('c2', 'Plain',          'QA', 'QA Album', 'QA Artist', 1, 'compilation-flag', 2020, 1971, '/m/qa/02.flac', 'flac', 900, 12346, 180);
  `);
  const csv = era.exportEraCsv(d());
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(
    lines[0],
    'id,artist,title,album,album_artist,era_reason,album_kind,decision,forced_year,overridden,year,original_year,original_year_source,year_state,file_path,file_suffix,bit_rate,file_size,duration_sec',
  );
  assert.ok(lines.some(l => l.includes('"Hello, ""World"""')), 'comma/quote title is quoted and escaped');
  const c1 = lines.find(l => l.startsWith('c1,'))!;
  const c2 = lines.find(l => l.startsWith('c2,'))!;
  assert.ok(c1.includes(',unchecked,'), 'no original year and no lookup stamp reads unchecked');
  assert.ok(c2.includes(',resolved,'), 'a resolved original year reads resolved');
  // A checked miss reads not found.
  d().prepare(`UPDATE tracks SET original_year_checked_at = '2026-10-01T00:00:00Z' WHERE id = 'c1'`).run();
  assert.ok(era.exportEraCsv(d()).split('\r\n').find(l => l.startsWith('c1,'))!.includes(',not found,'));
  // Ordinary albums are not in the export.
  assert.equal(era.exportEraCsv(d()).split('\r\n').some(l => l.includes('Normal Album')), false);
});

// ── (i) one stored verdict for every era reader ──────────────────────────────


test('storedYearUntrusted: the walk verdict wins once known, the raw flag only before it, and SQL agrees', () => {
  const cases: Array<[number | null, number | null, boolean | null]> = [
    // [is_compilation, era_untrusted, expected]
    [null, null, null], [0, null, false], [1, null, true],
    [null, 0, false],   [0, 0, false],    [1, 0, false],   // [1, 0] only via a Trust override
    [null, 1, true],    [0, 1, true],     [1, 1, true],
  ];
  d().exec(`CREATE TEMP TABLE era_cases (id INTEGER, is_compilation INTEGER, era_untrusted INTEGER)`);
  const ins = d().prepare(`INSERT INTO era_cases VALUES (?, ?, ?)`);
  cases.forEach(([c, e], i) => ins.run(i, c, e));
  const sql = d().prepare(`SELECT id, ${eraSuspect.eraSuspectSql()} AS s FROM era_cases ORDER BY id`).all() as Array<{ s: number | null }>;
  cases.forEach(([c, e, want], i) => {
    assert.equal(eraSuspect.storedYearUntrusted(c, e), want, `JS comp=${c} era=${e}`);
    assert.equal(sql[i].s == null ? null : sql[i].s === 1, want, `SQL comp=${c} era=${e}`);
  });
  d().exec(`DROP TABLE era_cases`);
});

test('Trust on a Navidrome compilation reaches every era reader: track, resolver, era filter, year lookups', () => {
  db.upsertTrackMeta('k1', {
    title: 'Hit', artist: 'Singer', album: 'Hits Compilation', albumArtist: 'Various Artists', year: 1975,
    isCompilation: true, eraUntrusted: true, eraReason: 'compilation-flag',
  });
  const inEra = () => d().prepare(`SELECT 1 FROM tracks WHERE id = 'k1' AND ${ERA_YEAR_SQL} BETWEEN 1970 AND 1979`).get();
  assert.equal(db.getTrack('k1')!.yearUntrusted, true);
  assert.equal(db.resolvedEraYearForTrack('k1'), null);
  assert.equal(inEra(), undefined, 'suspect: the reissue year never places it in the 70s');
  assert.ok(db.idsNeedingOriginalYear().includes('k1'));

  era.setEraOverride(d(), era.albumEraKey('Various Artists', 'Hits Compilation'), 'trusted');
  assert.equal(db.getTrack('k1')!.yearUntrusted, false);
  assert.equal(db.resolvedEraYearForTrack('k1'), 1975);
  assert.ok(inEra(), 'trusted: its own year counts');
  assert.equal(db.idsNeedingOriginalYear().includes('k1'), false, 'no lookup for a trusted album');

  // A later walk keeps it trusted, and Reset hands it back.
  db.upsertTrackMeta('k1', { title: 'Hit', isCompilation: true, ...era.eraWalkFields(
    { albumArtist: 'Various Artists', album: 'Hits Compilation', albumEraUntrusted: true, albumEraReason: 'compilation-flag' },
    era.loadEraOverrides(d()),
  ) });
  assert.equal(db.getTrack('k1')!.yearUntrusted, false);
  era.setEraOverride(d(), era.albumEraKey('Various Artists', 'Hits Compilation'), null);
  assert.equal(db.getTrack('k1')!.yearUntrusted, true);
  assert.equal(db.resolvedEraYearForTrack('k1'), null);
  d().exec(`DELETE FROM tracks WHERE id = 'k1'`);
});

test('the other era readers follow the stored verdict too: lite row, album facts, decade buckets, candidates, pool rows, vector freshness', () => {
  const comp = { title: 'Comp', artist: 'A', album: 'Comp LP', albumArtist: 'Various Artists', year: 1983, isCompilation: true };
  db.upsertTrackMeta('k2', { ...comp, eraUntrusted: true, eraReason: 'compilation-flag' });
  // A walk writing a trusted verdict on a flagged compilation (what an
  // override makes it do).
  db.upsertTrackMeta('k2', { ...comp, eraUntrusted: false, eraReason: 'compilation-flag' });
  assert.equal(db.getTrackLite('k2')!.yearUntrusted, false);
  assert.equal(db.getAlbumFacts('k2')!.yearUntrusted, false);
  assert.ok([...db.trackIdsByGenreDecade().entries()].some(([k, ids]) => k.endsWith('|1980') && ids.includes('k2')));
  assert.equal(db.candidateFilterTracks().find(t => t.id === 'k2')!.yearUntrusted, false);
  const raw = d().prepare(`SELECT * FROM tracks WHERE id = 'k2'`).get() as any;
  assert.equal(db.rowToEnergyPool(raw).yearUntrusted, false);
  // A vector built from the trusted era (1983) is current, so not dirty.
  db.upsertTrackVector('k2', new Array(8).fill(0.1), 1983);
  assert.equal(row('k2')!.text_vector_dirty, 0);
  d().exec(`DELETE FROM tracks WHERE id = 'k2'`);
});

// ── (h) routes ───────────────────────────────────────────────────────────────

const auth = `Basic ${Buffer.from('era-test-admin:era-test-pass').toString('base64')}`;

test('routes answer 401 without admin credentials', async () => {
  assert.equal((await fetch(`${base}/library/era`)).status, 401);
  assert.equal((await fetch(`${base}/library/era/csv`)).status, 401);
  assert.equal((await fetch(`${base}/library/era/override`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ album: 'QA Album', verdict: 'trusted' }),
  })).status, 401);
});

test('GET /library/era returns { summary, albums }', async () => {
  const res = await fetch(`${base}/library/era`, { headers: { authorization: auth } });
  if (res.status !== 200) throw new Error(`body: ${await res.text()}`);
  const body = await res.json() as any;
  assert.deepEqual(Object.keys(body).sort(), ['albums', 'summary']);
  assert.equal(body.summary.albums, 2, JSON.stringify(body.albums.map((a: any) => a.albumKey)));
  assert.equal(body.albums.find((a: any) => a.album === 'QA Album').tracks, 6); // c1+c2 joined QA
  assert.equal(body.albums.every((a: any) => typeof a.albumKey === 'string'), true);
});

test('POST /library/era/override trusts, suspects and removes; respond carries {ok, affected}', async () => {
  const post = (body: unknown) => fetch(`${base}/library/era/override`, {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: 'trusted' });
  assert.equal(res.status, 200);
  let out = await res.json() as any;
  assert.deepEqual(Object.keys(out).sort(), ['affected', 'ok']);
  assert.equal(out.ok, true);
  assert.equal(out.affected, 2, 'both g-rows flipped to trusted');
  assert.equal(row('g1')!.era_untrusted, 0);

  res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: null });
  out = await res.json() as any;
  assert.equal(out.ok, true);
  assert.equal(out.affected, 2, 'removal counts the tracks restored to the walk verdict');
  assert.equal(row('g1')!.era_untrusted, 1, 'back to what the walk said');
  assert.equal(era.loadEraOverrides(d()).has(era.albumEraKey('Band L', 'Lounging 1970-1975')), false);

  res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: 'maybe' });
  assert.equal(res.status, 400);
  res = await post({ albumArtist: 'Band L', verdict: 'trusted' });
  assert.equal(res.status, 400, 'album is required');

  // An album no scan has judged since the update has no stored album artist,
  // so an override would key on the wrong pair: refused, nothing written.
  d().exec(`INSERT INTO tracks (id, title, artist, album, era_untrusted) VALUES ('u2', 'Old', 'Old', 'Unscanned LP', 1)`);
  res = await post({ album: 'Unscanned LP', albumArtist: null, verdict: 'trusted' });
  assert.equal(res.status, 409);
  assert.equal(row('u2')!.era_untrusted, 1);
  assert.equal(era.loadEraOverrides(d()).has(era.albumEraKey(null, 'Unscanned LP')), false);
  d().exec(`DELETE FROM tracks WHERE id = 'u2'`);
});

test('GET /library/era/csv streams the export with a download filename', async () => {
  const res = await fetch(`${base}/library/era/csv`, { headers: { authorization: auth } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="era-suspects.csv"');
  const text = await res.text();
  assert.ok(text.startsWith('id,artist,title,'));
  assert.ok(text.includes('QA Album'));
});
