// Era review, second shape: album KINDS (pre-filled from the title, set by the
// operator) and the three DECISIONS that take an album out of the review list —
// the album year is right, one year for every track, per-track years — plus a
// show's excludedAlbumKinds, which rides the excluded-playlist set into every
// pick path.
//
// Run: npm test -- era-kinds

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const dir = mkdtempSync(join(tmpdir(), 'subwave-era-kinds-'));
process.env.STATE_DIR = dir;
process.env.ADMIN_USER = 'era-kinds-admin';
process.env.ADMIN_PASS = 'era-kinds-pass';

const express = (await import('express')).default;
const db = await import('../src/music/library-db.js');
const era = await import('../src/music/era-review.js');
const kinds = await import('../src/music/album-kind.js');
const { resolveExcludedPlaylistIds } = await import('../src/music/show-playlist.js');
const { resolveShowById } = await import('../src/settings/persona.js');
const { showSchema, repairShowForLoad } = await import('../src/schemas/show.js');
const { router: eraRoutes } = await import('../src/routes/library/era.js');
const { listen: listenHttp } = await import('./test-utils/http.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const app = express();
app.use(express.json());
app.use(eraRoutes);
const { server, url: base } = await listenHttp(app);
server.unref();
after(async () => { db.close(); await removeTempDir(dir); });

const d = () => db.getDb()!;
const auth = `Basic ${Buffer.from('era-kinds-admin:era-kinds-pass').toString('base64')}`;
const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const track = (id: string) => d().prepare(
  `SELECT era_untrusted, album_kind, original_year, original_year_source FROM tracks WHERE id = ?`,
).get(id) as { era_untrusted: number | null; album_kind: string | null; original_year: number | null; original_year_source: string | null };

// A walked album: every track flagged with the walk's reason and suggestion.
function walkAlbum(prefix: string, album: string, albumArtist: string, reason: string, n: number, year = 2004) {
  const ov = era.loadEraOverrides(d());
  for (let i = 1; i <= n; i++) {
    const f = era.eraWalkFields({ album, albumArtist, albumEraUntrusted: true, albumEraReason: reason }, ov);
    db.upsertTrackMeta(`${prefix}${i}`, { title: `${album} ${i}`, artist: `A${i}`, album, year, ...f });
    era.applyWalkForcedYear(`${prefix}${i}`, f.forcedYear);
  }
  return era.albumEraKey(albumArtist, album);
}

test('the kind is pre-filled from the title, the detector reason only breaking ties', () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['DJ-Kicks', 'many-artists', 'dj-mix'],
    ['Fabric 25: Carl Craig', 'many-artists', 'dj-mix'],
    ['Pulp Fiction (Original Motion Picture Soundtrack)', 'various-artists', 'soundtrack'],
    ['A Tribute to Nick Drake', 'many-artists', 'tribute'],
    ['Mojo Presents: Revolver Reloaded', 'various-artists', 'sampler'],
    ['Abbey Road (2019 Remaster)', 'title-year-range', 'reissue'],
    ['The Complete Recordings', 'title-compilation', 'box-set'],
    ['Live at Montreux Jazz Festival', 'many-artists', 'live'],
    ['Selected by Gilles Peterson', 'many-artists', 'dj-choice'],
    ["Now That's What I Call Music! 45", 'various-artists', 'chart'],
    ['Techno 2019', 'various-artists', 'chart'],
    ['Ninja Tune Records Presents', 'various-artists', 'label'],
    ['Celebration of 100 Releases', 'compilation-flag', 'label'],
    ['Greatest Hits', 'title-compilation', 'best-of'],
    ['Scott: The Collection 1967-1970', 'title-compilation', 'best-of'],
    ['Singles 1968-1974', 'title-year-range', 'best-of'],
    ['Années 80', 'many-artists', 'themed'],
    // A box, but a themed one: Box Set is a single artist's career set.
    ['Cowabunga! The Surf Box', 'various-artists', 'themed'],
    ['Rumours', 'compilation-flag', null],
  ];
  for (const [album, reason, want] of cases) {
    assert.equal(kinds.suggestAlbumKind({ album, reason }), want, album);
  }
  assert.equal(kinds.suggestedDecision('original-album'), 'trusted');
  assert.equal(kinds.suggestedDecision('reissue'), 'year');
  assert.equal(kinds.suggestedDecision('best-of'), 'suspect');
  assert.equal(kinds.suggestedDecision(null), null);
});

test('the walk writes the operator kind over the suggestion, and nothing on an unflagged album', () => {
  const ov = new Map([[era.albumEraKey('VA', 'Techno 2019'), { verdict: null, forcedYear: null, kind: 'dj-mix' as const }]]);
  assert.equal(era.eraWalkFields({ album: 'Techno 2019', albumArtist: 'VA', albumEraUntrusted: true, albumEraReason: 'various-artists' }, new Map()).albumKind, 'chart');
  assert.equal(era.eraWalkFields({ album: 'Techno 2019', albumArtist: 'VA', albumEraUntrusted: true, albumEraReason: 'various-artists' }, ov).albumKind, 'dj-mix');
  assert.equal(era.eraWalkFields({ album: 'Greatest Hits', albumArtist: 'X', albumEraUntrusted: false, albumEraReason: null }, new Map()).albumKind, null);
  // A kind alone leaves the verdict to the walk.
  assert.equal(era.eraWalkFields({ album: 'Techno 2019', albumArtist: 'VA', albumEraUntrusted: true, albumEraReason: 'various-artists' }, ov).eraUntrusted, true);
});

test('the walk clears the kind of an album it stops flagging, unless the operator set one', () => {
  walkAlbum('uf', 'Greatest Hits', 'Unflagged Later', 'title-compilation', 1);
  assert.equal(track('uf1').album_kind, 'best-of');
  const clear = era.eraWalkFields({ album: 'Greatest Hits', albumArtist: 'Unflagged Later', albumEraUntrusted: false, albumEraReason: null }, era.loadEraOverrides(d()));
  db.upsertTrackMeta('uf1', { title: 'x', album: 'Greatest Hits', ...clear });
  assert.equal(track('uf1').album_kind, null, 'no suggestion on an unflagged album, and nothing carried over');
});

test('setEraKind applies at once, null goes back to the suggestion, and an empty record is dropped', () => {
  const key = walkAlbum('dk', 'DJ-Kicks', 'Erlend Øye', 'many-artists', 3);
  assert.equal(track('dk1').album_kind, 'dj-mix', 'pre-filled by the walk');
  assert.equal(era.setEraKind(d(), key, 'dj-choice'), 3);
  assert.equal(track('dk2').album_kind, 'dj-choice');
  assert.equal(era.loadEraOverrides(d()).get(key)!.kind, 'dj-choice');
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.kindSet, true);
  assert.equal(era.setEraKind(d(), key, null), 3);
  assert.equal(track('dk3').album_kind, 'dj-mix', 'back to the title suggestion');
  assert.equal(era.loadEraOverrides(d()).has(key), false, 'no kind and no decision: no row');
  const row = era.listEraAlbums(d()).find(a => a.albumKey === key)!;
  assert.equal(row.kind, 'dj-mix');
  assert.equal(row.kindSet, false);
  // The kind survives a decision change, and the decision a kind change.
  era.setEraKind(d(), key, 'dj-mix');
  era.setEraOverride(d(), key, 'trusted');
  assert.equal(era.loadEraOverrides(d()).get(key)!.kind, 'dj-mix');
  era.setEraKind(d(), key, 'live');
  assert.equal(era.loadEraOverrides(d()).get(key)!.verdict, 'trusted');
});

test('one year for every track: manual years, the album done, and undone cleanly', () => {
  const key = walkAlbum('sm', 'Summer Selection', 'Some Label', 'various-artists', 3, 2011);
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.done, false);
  // One track already holds a looked-up year; one-year overrides it too.
  db.setOriginalYear('sm1', 1999);
  assert.equal(era.setEraOverride(d(), key, 'year', { year: 2010 }), 3);
  for (const id of ['sm1', 'sm2', 'sm3']) {
    assert.deepEqual({ y: track(id).original_year, s: track(id).original_year_source }, { y: 2010, s: 'manual' }, id);
  }
  const row = era.listEraAlbums(d()).find(a => a.albumKey === key)!;
  assert.equal(row.done, true);
  assert.equal(row.verdict, 'year');
  assert.equal(row.forcedYear, 2010);
  assert.equal(db.resolvedEraYearForTrack('sm2'), 2010);
  // A track the walk brings in later gets the year; one set by hand keeps its own.
  walkAlbum('sm', 'Summer Selection', 'Some Label', 'various-artists', 4, 2011);
  assert.equal(track('sm4').original_year, 2010);
  db.setManualOriginalYear('sm3', 1987);
  walkAlbum('sm', 'Summer Selection', 'Some Label', 'various-artists', 4, 2011);
  assert.equal(track('sm3').original_year, 1987, 'a hand-set year is never re-forced');
  // Replacing the decision clears only the years it wrote.
  era.setEraOverride(d(), key, 'suspect');
  assert.equal(track('sm1').original_year, null, 'the forced year is gone (the old lookup answer with it)');
  assert.equal(track('sm3').original_year, 1987, 'the hand-set one stays');
  assert.equal(track('sm2').era_untrusted, 1);
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.done, false, 'per-track with years missing');
  assert.throws(() => era.setEraOverride(d(), key, 'year'), /needs a year/);
});

test('per-track years: done once every track has a year, and the track list says which', () => {
  const key = walkAlbum('bo', 'Greatest Hits', 'Someone', 'title-compilation', 2, 2005);
  era.setEraOverride(d(), key, 'suspect');
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.done, false);
  const tracks = era.listEraAlbumTracks(d(), key);
  assert.deepEqual(tracks.map(t => t.yearState), ['unchecked', 'unchecked']);
  db.setManualOriginalYear('bo1', 1971);
  db.setOriginalYear('bo2', 1974);
  assert.equal(era.listEraAlbums(d()).find(a => a.albumKey === key)!.done, true);
  assert.deepEqual(era.listEraAlbumTracks(d(), key).map(t => [t.originalYear, t.originalYearSource]), [[1971, 'manual'], [1974, 'musicbrainz']]);
});

test('a show leaves out whole album kinds through the excluded-playlist set', async () => {
  walkAlbum('mx', 'DJ-Kicks', 'Kruder & Dorfmeister', 'many-artists', 2);
  db.upsertTrackMeta('plain', { title: 'Plain', artist: 'P', album: 'Plain LP', year: 1990 });
  const ids = await resolveExcludedPlaylistIds({ excludedAlbumKinds: ['dj-mix'], excludedPlaylistIds: [] });
  assert.ok(ids!.has('mx1') && ids!.has('mx2'));
  assert.equal(ids!.has('plain'), false);
  assert.equal(await resolveExcludedPlaylistIds({ excludedAlbumKinds: [], excludedPlaylistIds: [] }), null);
  // The resolved show the pick paths read carries the field (the #779 no-op).
  const resolved = resolveShowById('s_mixfree', { shows: [{ id: 's_mixfree', name: 'x', personaId: '', excludedAlbumKinds: ['dj-mix'] }], personas: [] } as any);
  assert.deepEqual(resolved!.excludedAlbumKinds, ['dj-mix']);
});

test('excludedAlbumKinds: strict save refuses an unknown kind, the load path drops it', () => {
  const ctx = { personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null };
  const ok = showSchema(ctx).parse({ id: 's_one', name: 'One', personaId: '', excludedAlbumKinds: ['dj-mix', 'dj-mix'] });
  assert.deepEqual(ok.excludedAlbumKinds, ['dj-mix']);
  assert.deepEqual(showSchema(ctx).parse({ id: 's_two', name: 'Two', personaId: '' }).excludedAlbumKinds, []);
  assert.equal(showSchema(ctx).safeParse({ id: 's_three', name: 'Three', personaId: '', excludedAlbumKinds: ['nope'] }).success, false);
  assert.deepEqual(repairShowForLoad({ excludedAlbumKinds: ['nope', 'dj-mix', 3] }, null).excludedAlbumKinds, ['dj-mix']);
});

test('routes: a year decision needs a whole year, kinds are checked, and an album lists its tracks', async () => {
  walkAlbum('rt', 'Ibiza 2004', 'Various Artists', 'various-artists', 2);
  let res = await post('/library/era/override', { album: 'Ibiza 2004', albumArtist: 'Various Artists', verdict: 'year' });
  assert.equal(res.status, 400);
  res = await post('/library/era/override', { album: 'Ibiza 2004', albumArtist: 'Various Artists', verdict: 'year', year: 2004.5 });
  assert.equal(res.status, 400);
  res = await post('/library/era/override', { album: 'Ibiza 2004', albumArtist: 'Various Artists', verdict: 'year', year: 2004 });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).affected, 2);
  res = await post('/library/era/kind', { album: 'Ibiza 2004', albumArtist: 'Various Artists', kind: 'bogus' });
  assert.equal(res.status, 400);
  res = await post('/library/era/kind', { album: 'Ibiza 2004', albumArtist: 'Various Artists', kind: 'dj-mix' });
  assert.equal(res.status, 200);
  assert.equal(track('rt1').album_kind, 'dj-mix');
  res = await post('/library/era/kind', { album: 'Never Scanned', kind: 'dj-mix' });
  assert.equal(res.status, 409);
  res = await fetch(`${base}/library/era/album?album=${encodeURIComponent('Ibiza 2004')}&albumArtist=${encodeURIComponent('Various Artists')}`, { headers: { authorization: auth } });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.deepEqual(body.tracks.map((t: any) => t.originalYear), [2004, 2004]);
  const listed = (await (await fetch(`${base}/library/era`, { headers: { authorization: auth } })).json() as any)
    .albums.find((a: any) => a.album === 'Ibiza 2004');
  assert.deepEqual({ kind: listed.kind, kindSet: listed.kindSet, verdict: listed.verdict, forcedYear: listed.forcedYear, done: listed.done },
    { kind: 'dj-mix', kindSet: true, verdict: 'year', forcedYear: 2004, done: true });
  assert.equal(listed.suggestedVerdict, 'trusted');
});

test('a sampler filed under a label folder is a label compilation; an artist\'s own is not', () => {
  const tracks = ['Hoomidaas', 'Ben Böhmer', 'Lila Drew'];
  const adid = '/music/DISCOTHEQUE/OK/All Day I Dream/A Winter Sampler (2019)/01.flac';
  assert.equal(kinds.ownerFolderOf(adid), 'All Day I Dream');
  // The folder names the label even when the album artist says "Various Artists".
  assert.equal(kinds.labelOwner({ albumArtist: 'Various Artists', path: adid, trackArtists: tracks }), 'All Day I Dream');
  // No real path (Navidrome builds it from the tags): the album artist answers.
  assert.equal(kinds.labelOwner({ albumArtist: 'All Day I Dream', path: 'All Day I Dream/A Winter Sampler/01.flac', trackArtists: tracks }), 'All Day I Dream');
  // An artist credited on the record filed it: not a label.
  assert.equal(kinds.labelOwner({ albumArtist: 'Oliver Koletzki', path: '/m/D/Oliver Koletzki/Schneeweiß 9 (2018)/01.flac', trackArtists: ['Oliver Koletzki & Fran', 'Niko Schwind'] }), null);
  // An owner who is an artist elsewhere in the library made a selection, not a label release.
  const artistsElsewhere = (n: string) => ['andrew weatherall', 'bob sinclar'].some(a => n.toLowerCase().includes(a));
  assert.equal(kinds.labelOwner({ albumArtist: 'Andrew Weatherall', path: '/m/D/Andrew Weatherall/London Xpress (2004)/01.flac', trackArtists: ['Two Lone Swordsmen', 'Battant'] }, { isArtist: artistsElsewhere }), null);
  assert.equal(kinds.labelOwner({ albumArtist: 'Kamai Music', path: '/m/D/Kamai Music/Inside The Mirror (2020)/01.flac', trackArtists: ['Mira', 'Reiche'] }, { isArtist: artistsElsewhere }), 'Kamai Music');
  // A sorting folder of the library is no owner: the album artist decides, here "Various Artists".
  assert.equal(kinds.labelOwner({ albumArtist: 'Various Artists', path: '/m/DISCOTHEQUE/Discothèque/Bossa Nova (2008)/01.flac', trackArtists: tracks }, { isContainerFolder: f => f === 'Discothèque' }), null);
  // Generic owners and single-artist records never name a label.
  assert.equal(kinds.labelOwner({ albumArtist: 'Various Artists', path: '/m/VA/Cowpilation #6/01.mp3', trackArtists: tracks }), null);
  assert.equal(kinds.labelOwner({ albumArtist: 'Traum', path: null, trackArtists: ['Kai Mono', 'Kai Mono'] }), null);

  assert.equal(kinds.suggestAlbumKind({ album: 'A Winter Sampler', reason: 'many-artists', label: 'All Day I Dream' }), 'label');
  assert.equal(kinds.suggestAlbumKind({ album: 'A Winter Sampler', reason: 'many-artists' }), 'sampler', 'no label folder: the title still says sampler');
  assert.equal(kinds.suggestAlbumKind({ album: 'Khonsu', reason: 'many-artists', label: 'Sounds Of Khemit' }), 'label', 'over the themed fallback');
  assert.equal(kinds.suggestAlbumKind({ album: 'Fabric 09 - Slam', reason: 'many-artists', label: 'Fabric' }), 'dj-mix', 'a specific title rule still wins');
});

test('Reset to the suggestion reads the label from the stored rows', () => {
  const ins = d().prepare(`INSERT INTO tracks (id, title, artist, album, album_artist, era_untrusted, era_reason, file_path)
    VALUES (?, ?, ?, 'Spring Sampler 2', 'Amulanga', 1, 'many-artists', ?)`);
  ins.run('ls1', 'One', 'Vegim', '/music/D/NEW/Amulanga/Spring Sampler 2 (2023)/01.flac');
  ins.run('ls2', 'Two', 'Rodriguez Jr.', '/music/D/NEW/Amulanga/Spring Sampler 2 (2023)/02.flac');
  const key = era.albumEraKey('Amulanga', 'Spring Sampler 2');
  era.setEraKind(d(), key, 'themed');
  era.setEraKind(d(), key, null);
  const k = d().prepare(`SELECT DISTINCT album_kind FROM tracks WHERE id IN ('ls1','ls2')`).all() as Array<{ album_kind: string }>;
  assert.deepEqual(k.map(r => r.album_kind), ['label']);
});
