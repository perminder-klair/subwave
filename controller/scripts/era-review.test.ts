// Era-suspect albums: review, reason and export.
//
// The walk already decides an album's era is untrustworthy (era-suspect.ts,
// #1418); this is the operator surface for that decision: the reason and the
// album artist stored at walk time (columns added by name, schema.ts
// ensureNamedColumns), the per-album override
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

const yearOf = (id: string) => d()
  .prepare('SELECT original_year AS y, original_year_source AS s FROM tracks WHERE id = ?')
  .get(id) as { y: number | null; s: string | null };

// ── (a) the era columns and table, added by name ─────────────────────────────

test('opening an older db adds era_reason, album_artist, album_kind and the era_override table, by name', () => {
  // Remove exactly what the era review owns, then reopen and watch it come
  // back. No user_version is involved, so a parallel change's migration step
  // can never skip it.
  const version = d().pragma('user_version', { simple: true }) as number;
  // idx_tracks_era_open (a count accelerator, rebuilt at every open) names
  // album_artist, and SQLite refuses to drop an indexed column.
  d().exec(`
    DROP INDEX IF EXISTS idx_tracks_era_open;
    DROP TABLE era_override;
    DROP INDEX idx_tracks_album_kind;
    DROP INDEX idx_tracks_era_album_key;
    ALTER TABLE tracks DROP COLUMN era_reason;
    ALTER TABLE tracks DROP COLUMN album_artist;
    ALTER TABLE tracks DROP COLUMN album_kind;
  `);
  assert.equal(cols().has('era_reason'), false);
  assert.equal(hasTable('era_override'), false);

  db.close();
  return db.open({ embeddingDim: 8, adoptStoredDim: true }).then(() => {
    for (const c of ['era_reason', 'album_artist', 'album_kind']) assert.equal(cols().has(c), true, c);
    assert.equal(hasTable('era_override'), true);
    const oc = (d().pragma('table_info(era_override)') as Array<{ name: string }>).map(c => c.name);
    assert.deepEqual(oc, ['album_key', 'verdict', 'forced_year', 'kind', 'set_at']);
    assert.equal(d().pragma('user_version', { simple: true }) as number, version, 'no migration step claimed');
    // A kind alone (no decision) is a valid row; an unknown decision is not.
    d().prepare(`INSERT INTO era_override (album_key, verdict, kind, set_at) VALUES (?, NULL, 'dj-mix', 'now')`).run('k\u0000only');
    assert.throws(() => d().prepare(`INSERT INTO era_override (album_key, verdict, set_at) VALUES (?, 'maybe', 'now')`).run('k\u0000bad'));
    d().exec(`DELETE FROM era_override`);
  });
});

test('a show\'s excluded kinds and every per-album lookup read an index, never the wide rows', () => {
  // The same SQL shapes as tracks.albumKindTrackIds and the era-review.ts
  // per-album reads. An expression index serves only the identical expression,
  // so the key lookup must use ERA_ALBUM_KEY_SQL itself.
  const plan = (sql: string, ...args: unknown[]) =>
    (d().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(r => r.detail).join(' | ');
  assert.match(plan(`SELECT id FROM tracks WHERE album_kind IN (?, ?)`, 'dj-mix', 'live'), /USING INDEX idx_tracks_album_kind/);
  assert.match(plan(`SELECT id FROM tracks WHERE ${era.ERA_ALBUM_KEY_SQL} = ?`, 'k'), /USING INDEX idx_tracks_era_album_key/);
  assert.match(plan(`SELECT t.id FROM tracks t WHERE ${era.ERA_ALBUM_KEY_SQL} = ?`, 'k'), /USING INDEX idx_tracks_era_album_key/);
});

test('a db that already has its era columns and table keeps them and their rows', () => {
  d().prepare(`INSERT INTO era_override (album_key, verdict, set_at) VALUES (?, 'trusted', '2026-10-24T00:00:00Z')`).run('a\u0000b');
  db.close();
  return db.open({ embeddingDim: 8, adoptStoredDim: true }).then(() => {
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
  assert.deepEqual(f, { eraUntrusted: false, eraReason: 'various-artists', albumArtist: 'Various Artists', albumKind: 'chart', forcedYear: null, originalYear: null });
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

test('a Suspect decision outranks a detector that stops flagging the album: its tag year is never recorded, and the tracks stay due', () => {
  const album = 'Anthology Unflagged';
  // What the walk sees: the album tag says 1972, the files say 1999.
  const walk = (id: string, flagged: boolean) => {
    const f = era.eraWalkFields({
      albumArtist: 'S Artist', album, albumOriginalYear: 1972, year: 1999,
      albumEraUntrusted: flagged, albumEraReason: flagged ? 'many-artists' : null,
    }, era.liveEraOverrides(d()));
    db.upsertTrackMeta(id, { title: id, artist: 'S', album, year: 1999, ...f });
    return f;
  };
  // Control: with no decision, an album the detector does not flag records it.
  walk('sx0', false);
  assert.deepEqual([yearOf('sx0').y, yearOf('sx0').s], [1972, 'album-tag']);
  d().exec(`DELETE FROM tracks WHERE id = 'sx0'`);

  walk('sx1', true);                     // flagged: withheld, as before
  assert.equal(yearOf('sx1').y, null);
  const key = era.albumEraKey('S Artist', album);
  era.setEraOverride(d(), key, 'suspect');
  assert.equal(walk('sx1', false).originalYear, null, 'the operator\'s Suspect withholds it');
  assert.equal(yearOf('sx1').y, null, 'the detector stopped flagging: the tag year is still not written');
  assert.equal(db.getTrack('sx1')!.yearUntrusted, true);
  assert.ok(db.yearLookupDueIds(Date.now()).includes('sx1'), 'still due for a lookup');
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.done, false, 'and the album is not done');
  // A tag year recorded before the decision is dropped by the next walk.
  d().prepare(`UPDATE tracks SET original_year = 1972, original_year_source = 'album-tag' WHERE id = 'sx1'`).run();
  walk('sx1', false);
  assert.equal(yearOf('sx1').y, null, 'the earlier album-tag year goes');
  era.setEraOverride(d(), key, null);
  d().exec(`DELETE FROM tracks WHERE id = 'sx1'`);
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

// A text vector built from the era the row resolves to now, so it starts clean.
function embed(...ids: string[]): void {
  for (const id of ids) db.upsertTrackVector(id, new Array(8).fill(0.1), db.resolvedEraYearForTrack(id));
  d().exec(`UPDATE tracks SET text_vector_dirty = 0 WHERE id IN (${ids.map(i => `'${i}'`).join(',')})`);
}

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
  embed('x1', 'x2', 'x3', 'x4');
  const key = era.albumEraKey('QA Artist', 'QA Album');
  const affected = era.setEraOverride(d(), key, 'trusted');
  // x3 was already 0: not flipped, not dirty. x1, x2, x4 all change value.
  assert.equal(affected, 3);
  assert.equal(row('x1')!.era_untrusted, 0);
  assert.equal(row('x1')!.text_vector_dirty, 1);
  assert.equal(row('x2')!.text_vector_dirty, 1);
  assert.equal(row('x3')!.text_vector_dirty, 0, 'already trusted: untouched');
  assert.equal(row('x4')!.era_untrusted, 0, 'NULL means no evidence, trusted normalizes it to 0');
  assert.equal(row('x4')!.text_vector_dirty, 0, 'its era was 1994 before and after: the vector is still right');
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

test('an override re-embeds only tracks whose Era: line moves, and only tracks that have a vector', () => {
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, text_vector_dirty, year, original_year)
    VALUES
      ('v1', 'Open',      'V', 'V Album', 'V Artist', 1, 'many-artists', 0, 1988, NULL),
      ('v2', 'Resolved',  'V', 'V Album', 'V Artist', 1, 'many-artists', 0, 1988, 1969),
      ('v3', 'No year',   'V', 'V Album', 'V Artist', 1, 'many-artists', 0, NULL, NULL),
      ('v4', 'No vector', 'V', 'V Album', 'V Artist', 1, 'many-artists', 0, 1988, NULL);
  `);
  embed('v1', 'v2', 'v3');
  const key = era.albumEraKey('V Artist', 'V Album');
  assert.equal(era.setEraOverride(d(), key, 'trusted'), 4, 'all four verdicts change');
  assert.equal(row('v1')!.text_vector_dirty, 1, 'its era goes from unknown to 1988');
  assert.equal(row('v2')!.text_vector_dirty, 0, 'the resolved 1969 wins either way: vector kept');
  assert.equal(row('v3')!.text_vector_dirty, 0, 'no year either way: vector kept');
  assert.equal(row('v4')!.text_vector_dirty, 0, 'its era moves, but there is no vector to mark');
  // And back: Reset moves v1's era again, and only v1's.
  embed('v1');
  era.setEraOverride(d(), key, null);
  assert.equal(row('v1')!.text_vector_dirty, 1);
  assert.equal(row('v2')!.text_vector_dirty, 0);
  assert.equal(row('v4')!.text_vector_dirty, 0);
  d().exec(`DELETE FROM tracks WHERE id IN ('v1','v2','v3','v4')`);
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

test('exportEraCsv: a cell a spreadsheet would run as a formula is prefixed with \'', () => {
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, year, file_path)
    VALUES
      ('fx1', '=HYPERLINK("http://x","y")', 'QA', 'Formula LP', 'QA Artist', 1, 'compilation-flag', 2020, '/m/x/01.flac'),
      ('fx2', '+1', '-dash', 'Formula LP', 'QA Artist', 1, 'compilation-flag', 2020, '@/m/x/02.flac'),
      ('fx3', 'Safe = fine', 'QA', 'Formula LP', 'QA Artist', 1, 'compilation-flag', 2020, '/m/x/03.flac');
  `);
  const lines = era.exportEraCsv(d()).trimEnd().split('\r\n');
  const x1 = lines.find(l => l.startsWith('fx1,'))!;
  const x2 = lines.find(l => l.startsWith('fx2,'))!;
  const x3 = lines.find(l => l.startsWith('fx3,'))!;
  assert.ok(x1.includes(`,"'=HYPERLINK(""http://x"",""y"")",`), x1);
  assert.ok(x2.startsWith(`fx2,'-dash,'+1,`), x2);
  assert.ok(x2.includes(`,'@/m/x/02.flac,`), x2);
  assert.ok(x3.includes(',Safe = fine,'), 'only a leading sign is a formula');
  d().exec(`DELETE FROM tracks WHERE id IN ('fx1','fx2','fx3')`);
});

test('a walk reads each album record as it reaches it: a decision removed mid-run is not applied', () => {
  const key = era.albumEraKey('Band M', 'Midrun LP');
  d().prepare(`INSERT INTO era_override (album_key, verdict, forced_year, set_at) VALUES (?, 'year', 1977, 'now')`).run(key);
  const lookup = era.liveEraOverrides(d());   // taken when the run starts
  assert.deepEqual(lookup.get(key), { verdict: 'year', forcedYear: 1977, kind: null });
  d().prepare(`DELETE FROM era_override WHERE album_key = ?`).run(key);   // the operator's click, mid-run
  assert.equal(lookup.get(key), null, 'the run sees the removal');
  const song = { album: 'Midrun LP', albumArtist: 'Band M', artist: 'Band M', isCompilation: false, year: 2012 } as any;
  const f = era.eraWalkFields(song, lookup);
  assert.equal(f.forcedYear ?? null, null, 'no year is forced from a removed decision');
});

// ── (g2) a one-year decision and the years tracks already hold ───────────────
//
// The decision writes its year as each track's manual year, but a year the
// operator typed is never the decision's, and removing the decision gives each
// track back exactly what it held (tracks.era_forced_from).

const yearState = (id: string) => {
  const r = d().prepare(
    `SELECT original_year AS y, original_year_source AS s, original_year_checked_at AS c, era_forced_from AS f
       FROM tracks WHERE id = ?`,
  ).get(id) as { y: number | null; s: string | null; c: string | null; f: string | null };
  return { ...r };
};
const yearFacet = (id: string) => {
  const r = d().prepare(`SELECT status, reason FROM track_facet_status WHERE track_id = ? AND facet = 'year'`).get(id) as
    { status: string; reason: string | null } | undefined;
  return r ? { ...r } : null;
};
const eraYearSql = (id: string) =>
  (d().prepare(`SELECT ${ERA_YEAR_SQL} AS y FROM tracks WHERE id = ?`).get(id) as { y: number | null }).y;

// A walked, flagged album with one track per starting state.
function yearAlbum(album: string): string {
  for (const id of ['hand', 'mb', 'miss', 'none', 'same', 'samemb']) {
    db.upsertTrackMeta(`${album}-${id}`, {
      title: `${album} ${id}`, artist: 'Y', album, albumArtist: 'Y Artist', year: 2001,
      eraUntrusted: true, eraReason: 'many-artists',
    });
  }
  db.setManualOriginalYear(`${album}-hand`, 1980);
  db.setOriginalYear(`${album}-mb`, 1968, 'musicbrainz');
  db.setOriginalYear(`${album}-miss`, null);
  db.setManualOriginalYear(`${album}-same`, 1975);
  db.setOriginalYear(`${album}-samemb`, 1975, 'discogs');
  return era.albumEraKey('Y Artist', album);
}
// The listing fixtures below count their own albums only.
function dropYearAlbum(album: string): void {
  d().prepare(`DELETE FROM tracks WHERE album = ?`).run(album);
  d().prepare(`DELETE FROM era_override WHERE album_key = ?`).run(era.albumEraKey('Y Artist', album));
}

test('a one-year decision never overwrites a year typed by hand, and removing it gives every track back what it had', () => {
  const key = yearAlbum('YearOne');
  const id = (s: string) => `YearOne-${s}`;
  const before = new Map(['hand', 'mb', 'miss', 'none', 'same', 'samemb'].map(s => [s, yearState(id(s))]));
  const facetBefore = new Map(['hand', 'mb', 'miss', 'none', 'same', 'samemb'].map(s => [s, yearFacet(id(s))]));
  assert.ok(db.yearLookupDueIds(Date.now()).includes(id('none')), 'nothing yet: due');

  era.setEraOverride(d(), key, 'year', { year: 1975 });
  // The hand-set track keeps, and reads as, its own year everywhere.
  assert.deepEqual(yearState(id('hand')), before.get('hand'), 'hand-set: untouched');
  assert.equal(db.resolvedEraYearForTrack(id('hand')), 1980);
  assert.equal(eraYearSql(id('hand')), 1980);
  const listed = era.listEraAlbumTracks(d(), key).find(t => t.id === id('hand'))!;
  assert.deepEqual([listed.originalYear, listed.originalYearSource], [1980, 'manual'], 'the Era tab shows the same year');
  // Every other track reads the decision's year.
  for (const s of ['mb', 'miss', 'none', 'samemb']) {
    assert.deepEqual([yearState(id(s)).y, yearState(id(s)).s], [1975, 'manual'], s);
    assert.equal(db.resolvedEraYearForTrack(id(s)), 1975, s);
    assert.equal(eraYearSql(id(s)), 1975, s);
  }
  assert.equal(db.yearLookupDueIds(Date.now()).includes(id('none')), false, 'resolved while the decision stands');

  era.setEraOverride(d(), key, null);
  for (const s of ['hand', 'mb', 'miss', 'none', 'same', 'samemb']) {
    assert.deepEqual(yearState(id(s)), before.get(s), `${s}: exactly what it held`);
    assert.deepEqual(yearFacet(id(s)), facetBefore.get(s), `${s}: the year facet row too`);
  }
  assert.equal(yearState(id('hand')).y, 1980, 'hand-set 1980 is still 1980');
  assert.deepEqual([yearState(id('mb')).y, yearState(id('mb')).s], [1968, 'musicbrainz'], 'the looked-up year is back');
  assert.deepEqual(yearFacet(id('mb')), { status: 'ok', reason: 'musicbrainz' });
  assert.deepEqual(yearFacet(id('miss')), { status: 'unmeasurable', reason: 'not-found' }, 'a settled miss stays settled');
  assert.equal(yearState(id('none')).y, null, 'a track with no year loses the decision\'s');
  assert.equal(yearFacet(id('none')), null, 'and has no year row: not done');
  assert.ok(db.yearLookupDueIds(Date.now()).includes(id('none')), 'so it is due for a lookup again');
  assert.equal(db.yearLookupDueIds(Date.now()).includes(id('mb')), false, 'a restored answer is not re-asked');
  assert.deepEqual([yearState(id('same')).y, yearState(id('same')).s], [1975, 'manual'], 'its own 1975 is not the decision\'s to clear');
  assert.deepEqual([yearState(id('samemb')).y, yearState(id('samemb')).s], [1975, 'discogs'], 'nor a looked-up 1975');
  dropYearAlbum('YearOne');
});

test('a one-year decision: a change of year keeps each track\'s own record, and a year typed since is the operator\'s', () => {
  const key = yearAlbum('YearTwo');
  const id = (s: string) => `YearTwo-${s}`;
  const mbBefore = yearState(id('mb'));
  era.setEraOverride(d(), key, 'year', { year: 1975 });
  era.setEraOverride(d(), key, 'year', { year: 1977 });
  assert.equal(yearState(id('mb')).y, 1977);
  // The operator types a year over one the decision wrote: it is theirs now.
  db.setManualOriginalYear(id('none'), 1990);
  assert.equal(yearState(id('none')).f, null, 'typing drops the decision\'s record');
  // A track the walk brings in later gets the year, recorded as the decision's.
  db.upsertTrackMeta(id('late'), {
    title: 'late', artist: 'Y', album: 'YearTwo', albumArtist: 'Y Artist', year: 2001,
    eraUntrusted: true, eraReason: 'many-artists',
  });
  const f = era.eraWalkFields({ album: 'YearTwo', albumArtist: 'Y Artist', albumEraUntrusted: true, albumEraReason: 'many-artists' }, era.liveEraOverrides(d()));
  assert.equal(era.applyWalkForcedYear(id('late'), key, f.forcedYear), true);
  assert.equal(yearState(id('late')).y, 1977);
  assert.equal(era.applyWalkForcedYear(id('hand'), key, f.forcedYear), false, 'the walk never forces a hand-set year either');

  era.setEraOverride(d(), key, 'trusted');
  assert.deepEqual(yearState(id('mb')), mbBefore, 'back to the looked-up year, not the first decision\'s 1975');
  assert.equal(yearState(id('none')).y, 1990, 'the year typed since stays');
  assert.equal(yearState(id('late')).y, null, 'the late track had nothing, and has nothing again');
  assert.equal(yearState(id('hand')).y, 1980);
  dropYearAlbum('YearTwo');
});

// The walk's own steps for one song: the row takes the album it read, then the
// album's one-year decision (or its absence) is applied (tag-library/flags.ts).
function walkTo(id: string, album: string, albumArtist = 'Y Artist'): boolean {
  db.upsertTrackMeta(id, { album, albumArtist });
  const f = era.eraWalkFields({ album, albumArtist, albumEraUntrusted: true, albumEraReason: 'many-artists' }, era.liveEraOverrides(d()));
  return era.applyWalkForcedYear(id, era.albumEraKey(albumArtist, album), f.forcedYear);
}
const recordKey = (id: string) => {
  const f = yearState(id).f;
  return f == null ? null : (JSON.parse(f) as { albumKey?: string }).albumKey;
};

test('a track that leaves a one-year album for one without a decision gets its own year back (#2319)', () => {
  const key = yearAlbum('YearMove');
  const id = (s: string) => `YearMove-${s}`;
  const before = new Map(['hand', 'mb', 'none'].map(s => [s, yearState(id(s))]));
  era.setEraOverride(d(), key, 'year', { year: 1975 });
  assert.equal(recordKey(id('mb')), key, 'the record names the album whose decision wrote it');

  // Retagged to another album: restored at once, exactly as removing the decision would.
  assert.equal(walkTo(id('mb'), 'Elsewhere'), true);
  assert.deepEqual(yearState(id('mb')), before.get('mb'), 'the looked-up 1968 is back');
  assert.equal(walkTo(id('none'), 'Elsewhere'), true);
  assert.deepEqual(yearState(id('none')), before.get('none'), 'a track that had nothing has nothing');
  // A hand-set year was never the decision's: it moves with the track untouched.
  assert.equal(walkTo(id('hand'), 'Elsewhere'), false);
  assert.deepEqual(yearState(id('hand')), before.get('hand'));
  // A track still on the album keeps the decision's year.
  assert.equal(walkTo(id('miss'), 'YearMove'), false);
  assert.deepEqual([yearState(id('miss')).y, yearState(id('miss')).s], [1975, 'manual']);
  // A second walk over the moved track does nothing more.
  assert.equal(walkTo(id('mb'), 'Elsewhere'), false);

  // The album renamed: treated as a move, so the year comes back and the album
  // (whose key the decision no longer matches) returns to review.
  assert.equal(walkTo(id('miss'), 'YearMove (Remastered)'), true);
  assert.deepEqual([yearState(id('miss')).y, yearState(id('miss')).f], [null, null]);
  dropYearAlbum('YearMove'); dropYearAlbum('Elsewhere'); dropYearAlbum('YearMove (Remastered)');
});

test('a track that moves between two one-year albums keeps its own year in its record, which now names the new album (#2319)', () => {
  const keyA = yearAlbum('YearFrom');
  const keyB = era.albumEraKey('Y Artist', 'YearTo');
  db.upsertTrackMeta('YearTo-1', { title: 'to', artist: 'Y', album: 'YearTo', albumArtist: 'Y Artist', year: 2001, eraUntrusted: true, eraReason: 'many-artists' });
  era.setEraOverride(d(), keyA, 'year', { year: 1975 });
  era.setEraOverride(d(), keyB, 'year', { year: 1983 });
  const id = 'YearFrom-mb';
  const own = JSON.parse(yearState(id).f!) as { year: number; source: string };

  assert.equal(walkTo(id, 'YearTo'), true, 'takes the new album\'s year');
  assert.equal(yearState(id).y, 1983);
  assert.equal(recordKey(id), keyB);
  assert.deepEqual((({ year, source }) => ({ year, source }))(JSON.parse(yearState(id).f!)), { year: own.year, source: own.source }, 'still its own 1968, not 1975');

  // Same year on both albums: nothing to write, but the record still follows.
  era.setEraOverride(d(), keyA, 'year', { year: 1983 });
  assert.equal(walkTo(id, 'YearFrom'), false);
  assert.equal(recordKey(id), keyA);
  assert.equal(walkTo(id, 'YearTo'), false);
  assert.equal(recordKey(id), keyB);

  // Removing the new album's decision now finds it and restores its own year.
  era.setEraOverride(d(), keyB, null);
  assert.deepEqual([yearState(id).y, yearState(id).s, yearState(id).f], [1968, 'musicbrainz', null]);
  dropYearAlbum('YearFrom'); dropYearAlbum('YearTo');
});

test('a decision record with no album key (written before #2319) is left as it is when its track moves', () => {
  const key = yearAlbum('YearOld');
  era.setEraOverride(d(), key, 'year', { year: 1975 });
  const id = 'YearOld-mb';
  const legacy = JSON.parse(yearState(id).f!) as Record<string, unknown>;
  delete legacy.albumKey;
  d().prepare('UPDATE tracks SET era_forced_from = ? WHERE id = ?').run(JSON.stringify(legacy), id);
  const held = yearState(id);

  assert.equal(walkTo(id, 'Elsewhere Old'), false);
  assert.deepEqual(yearState(id), held, 'kept, record and all');
  // Nor is it given a key by reaching another year decision.
  const keyB = era.albumEraKey('Y Artist', 'YearOldTo');
  db.upsertTrackMeta('YearOldTo-1', { title: 'to', artist: 'Y', album: 'YearOldTo', albumArtist: 'Y Artist', year: 2001, eraUntrusted: true, eraReason: 'many-artists' });
  era.setEraOverride(d(), keyB, 'year', { year: 1990 });
  assert.equal(walkTo(id, 'YearOldTo'), true);
  assert.equal(recordKey(id), undefined);
  dropYearAlbum('YearOld'); dropYearAlbum('Elsewhere Old'); dropYearAlbum('YearOldTo');
});

test('a walk whose server leaves out the album artist does not read the track as leaving its album (#2319)', () => {
  const key = yearAlbum('YearNoAA');
  era.setEraOverride(d(), key, 'year', { year: 1975 });
  const id = 'YearNoAA-mb';
  // The upsert keeps the stored album artist; only the walk's own key differs.
  db.upsertTrackMeta(id, { album: 'YearNoAA', albumArtist: null });
  const f = era.eraWalkFields({ album: 'YearNoAA', albumArtist: null }, era.liveEraOverrides(d()));
  assert.equal(era.applyWalkForcedYear(id, era.albumEraKey(null, 'YearNoAA'), f.forcedYear), false);
  assert.deepEqual([yearState(id).y, yearState(id).s], [1975, 'manual'], 'the decision\'s year stays');
  dropYearAlbum('YearNoAA');
});

test('Trust <-> one year of the file\'s own year leaves the vector clean: the Era: line never moves (#2319)', () => {
  d().exec(`
    INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, text_vector_dirty, year)
    VALUES
      ('ty1', 'Same',  'T', 'TY Album', 'TY Artist', 1, 'many-artists', 0, 1975),
      ('ty2', 'Other', 'T', 'TY Album', 'TY Artist', 1, 'many-artists', 0, 1990);
  `);
  const key = era.albumEraKey('TY Artist', 'TY Album');
  era.setEraOverride(d(), key, 'trusted');
  embed('ty1', 'ty2');
  assert.ok(era.setEraOverride(d(), key, 'year', { year: 1975 }) > 0);
  assert.equal(row('ty1')!.text_vector_dirty, 0, 'trusted 1975 -> decided 1975');
  assert.equal(row('ty2')!.text_vector_dirty, 1, 'trusted 1990 -> decided 1975 moves');
  embed('ty1', 'ty2');
  era.setEraOverride(d(), key, 'trusted');
  assert.equal(row('ty1')!.text_vector_dirty, 0, 'decided 1975 -> trusted 1975');
  assert.equal(row('ty2')!.text_vector_dirty, 1, 'decided 1975 -> trusted 1990 moves');
  embed('ty1', 'ty2');
  era.setEraOverride(d(), key, null);
  assert.equal(row('ty1')!.text_vector_dirty, 1, 'reset: back to the walk\'s suspect verdict, era unknown');
  d().exec(`DELETE FROM tracks WHERE album = 'TY Album'`);
  d().prepare('DELETE FROM era_override WHERE album_key = ?').run(key);
});

test('a one-year decision gives a failed lookup back its history: attempts, reason and retry delay', () => {
  db.upsertTrackMeta('YearErr-1', {
    title: 'err', artist: 'Y', album: 'YearErr', albumArtist: 'Y Artist', year: 2001,
    eraUntrusted: true, eraReason: 'many-artists',
  });
  db.recordOriginalYearOutcome('YearErr-1', { kind: 'error', reason: 'timeout', source: 'musicbrainz' });
  db.recordOriginalYearOutcome('YearErr-1', { kind: 'error', reason: 'timeout again', source: 'musicbrainz' });
  const facetRow = () => ({ ...(d().prepare(
    `SELECT status, reason, attempts, version, source, at FROM track_facet_status WHERE track_id = 'YearErr-1' AND facet = 'year'`,
  ).get() as object) });
  const before = facetRow();
  assert.equal((before as { attempts: number }).attempts, 2);
  assert.equal(db.yearLookupDueIds(Date.now()).includes('YearErr-1'), false, 'waiting out its retry delay');

  const key = era.albumEraKey('Y Artist', 'YearErr');
  era.setEraOverride(d(), key, 'year', { year: 1975 });
  era.setEraOverride(d(), key, null);
  assert.deepEqual(facetRow(), before, 'the failed row comes back as it stood');
  assert.equal(db.yearLookupDueIds(Date.now()).includes('YearErr-1'), false, 'still waiting, not re-asked at once');
  dropYearAlbum('YearErr');
});

test('removing a one-year decision leaves a track whose record cannot be read alone, and never throws', () => {
  const key = yearAlbum('YearBad');
  era.setEraOverride(d(), key, 'year', { year: 1975 });
  d().prepare(`UPDATE tracks SET era_forced_from = 'not json{' WHERE id = 'YearBad-mb'`).run();
  d().prepare(`UPDATE tracks SET era_forced_from = '{"year":"abc","source":null,"checkedAt":null}' WHERE id = 'YearBad-miss'`).run();
  assert.doesNotThrow(() => era.setEraOverride(d(), key, null));
  for (const s of ['mb', 'miss']) {
    const st = yearState(`YearBad-${s}`);
    assert.deepEqual([st.y, st.s, st.f], [1975, 'manual', null], `${s}: keeps the decision's year, no guessed one`);
  }
  assert.deepEqual([yearState('YearBad-none').y, yearState('YearBad-none').f], [null, null], 'a readable record is still restored');
  dropYearAlbum('YearBad');
});

// ── (i) one stored verdict for every era reader ──────────────────────────────


test('storedYearUntrusted: the walk verdict wins once known, the raw flag only before it, and SQL agrees', () => {
  const cases: Array<[number | null, number | null, boolean | null]> = [
    // [is_compilation, era_untrusted, expected]
    [null, null, null], [0, null, false], [1, null, true],
    [null, 0, false],   [0, 0, false],    [1, 0, false],   // [1, 0]: a Trust override, or a stale flag (music.md)
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

test('a stale compilation flag reads as trusted once a walk judges the row without it (a stated behaviour change)', () => {
  const base = { title: 'Stale', artist: 'A', album: 'Stale Comp', albumArtist: 'Various Artists', year: 1991 };
  db.upsertTrackMeta('sf1', { ...base, isCompilation: true, eraUntrusted: true, eraReason: 'compilation-flag' });
  // Navidrome stops sending isCompilation at all; the walk, judging without
  // it, finds nothing. The stored flag is kept (a field left out is not cleared).
  db.upsertTrackMeta('sf1', { ...base, eraUntrusted: false, eraReason: null });
  const r = d().prepare(`SELECT is_compilation, era_untrusted FROM tracks WHERE id = 'sf1'`).get() as { is_compilation: number; era_untrusted: number };
  assert.deepEqual({ ...r }, { is_compilation: 1, era_untrusted: 0 });
  assert.equal(db.getTrack('sf1')!.yearUntrusted, false, 'the old OR read this as suspect');
  assert.equal(era.listEraAlbums(d()).some(a => a.album === 'Stale Comp'), false, 'and it leaves the Era tab');
  d().exec(`DELETE FROM tracks WHERE id = 'sf1'`);
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
  assert.ok(db.yearLookupDueIds(Date.now()).includes('k1'));

  era.setEraOverride(d(), era.albumEraKey('Various Artists', 'Hits Compilation'), 'trusted');
  assert.equal(db.getTrack('k1')!.yearUntrusted, false);
  assert.equal(db.resolvedEraYearForTrack('k1'), 1975);
  assert.ok(inEra(), 'trusted: its own year counts');
  assert.equal(db.idsNeedingOriginalYear().includes('k1'), false, 'no lookup for a trusted album');
  assert.equal(db.yearLookupDueIds(Date.now()).includes('k1'), false);
  // The override re-derives the year facet row itself, with no walk.
  const yr = d().prepare(`SELECT status, reason FROM track_facet_status WHERE track_id = 'k1' AND facet = 'year'`).get() as { status: string; reason: string } | undefined;
  assert.deepEqual(yr && { ...yr }, { status: 'ok', reason: 'not-needed' }, 'the year facet row is re-derived at once');
  // Even with no facet row (a row synced before the facet existed), the due
  // query itself reads the stored verdict.
  d().exec(`DELETE FROM track_facet_status WHERE track_id = 'k1' AND facet = 'year'`);
  assert.equal(db.yearLookupDueIds(Date.now()).includes('k1'), false);

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

test('the other era readers follow the stored verdict too: lite row, album facts, decade buckets, candidates, pool rows, vector freshness, the walk\'s facet re-derive', () => {
  const comp = { title: 'Comp', artist: 'A', album: 'Comp LP', albumArtist: 'Various Artists', year: 1983, isCompilation: true };
  db.upsertTrackMeta('k2', { ...comp, eraUntrusted: true, eraReason: 'compilation-flag' });
  // A walk writing a trusted verdict on a flagged compilation (what an
  // override makes it do) re-derives the year facet like any era change.
  db.upsertTrackMeta('k2', { ...comp, eraUntrusted: false, eraReason: 'compilation-flag' });
  const yr = d().prepare(`SELECT reason FROM track_facet_status WHERE track_id = 'k2' AND facet = 'year'`).get() as { reason: string };
  assert.equal(yr.reason, 'not-needed');
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
  // One year window for every typed year (schemas/library.ts originalYearMax).
  const next = new Date().getUTCFullYear() + 1;
  for (const year of [1899, next + 1, 1977.5, '1977', undefined]) {
    res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: 'year', year });
    assert.equal(res.status, 400, String(year));
    assert.match(((await res.json()) as any).error, /year must be a whole year between 1900 and /);
  }
  res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: 'year', year: next });
  assert.equal(res.status, 200, 'next year (a pre-release) is in the window, as for a per-track year');
  res = await post({ album: 'Lounging 1970-1975', albumArtist: 'Band L', verdict: null });
  assert.equal(res.status, 200);

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
