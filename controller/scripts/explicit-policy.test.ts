// music/explicit-policy.ts and the small consumers with no pick to drive: the
// no-repeat universe, the journey destination, the editor's count and the
// coast's show identity. The pick paths themselves are in
// explicit-pick-paths.test.ts, the coast in explicit-coast.test.ts, requests in
// explicit-requests.test.ts.
// Run: `npm test -- explicit-policy`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-explicit-policy-'));
process.env.STATE_DIR = dir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const {
  anyCleanShow, excludesExplicit, explicitGate, heldBackFromShow, trackExplicitStatus, withoutExplicit,
} = await import('../src/music/explicit-policy.js');
const { requireDb } = await import('../src/music/library-db/handle.js');
const { airableAnchorTracks, showNoRepeatGuard, strictShowLibraryPool } = await import('../src/music/show-recency.js');
const { showDestinationPool } = await import('../src/music/journey-destination.js');
const { buildShowCandidateDiagnostic, diagnoseShowCandidates } = await import('../src/music/show-candidates.js');
const { autoPlaylistShowKey } = await import('../src/broadcast/auto-playlist-show.js');
await library.load();
after(async () => { library.shutdown(); await removeTempDir(dir); });

const EXPLICIT = { id: 'e', title: 'E', artist: 'A', explicitStatus: 'explicit', genres: ['Jazz'], durationSec: 200 };
const CLEAN = { id: 'c', title: 'C', artist: 'B', explicitStatus: 'clean', genres: ['Jazz'], durationSec: 200 };
const NO_TAG = { id: 'n', title: 'N', artist: 'C', explicitStatus: null, genres: ['Rock'], durationSec: 200 };
const ROWS = [EXPLICIT, CLEAN, NO_TAG];
const ids = (rows: Array<{ id?: string | null }>) => rows.map(r => r.id);

test('only literal true turns a show clean', () => {
  assert.equal(excludesExplicit({ excludeExplicit: true }), true);
  for (const show of [null, undefined, {}, { excludeExplicit: false }, { excludeExplicit: 'yes' }, { excludeExplicit: 1 }]) {
    assert.equal(excludesExplicit(show), false, JSON.stringify(show));
  }
});

test('a candidate that carries the field is judged on it, whatever the library says', () => {
  db.upsertTrackMeta('row', { title: 'r', explicitStatus: 'explicit' });
  assert.equal(trackExplicitStatus({ id: 'row', explicitStatus: 'clean' }), 'clean');
  assert.equal(trackExplicitStatus({ id: 'row', explicitStatus: '' }), null, "the server's live answer: no tag");
  assert.equal(trackExplicitStatus({ id: 'row', explicitStatus: null }), null, "a library row's own column");
  assert.equal(trackExplicitStatus({ id: 'gone', explicitStatus: 'explicit' }), 'explicit', 'a raw child with no library row');
});

test('a candidate that never reported it falls back to the library', () => {
  db.upsertTrackMeta('walked', { title: 'w', explicitStatus: 'explicit' });
  db.upsertTrackMeta('untagged', { title: 'u', explicitStatus: null });
  assert.equal(trackExplicitStatus({ id: 'walked' }), 'explicit');
  assert.equal(trackExplicitStatus({ id: 'untagged' }), null);
  assert.equal(trackExplicitStatus({ id: 'no-such-row' }), null, 'unknown');
  assert.equal(trackExplicitStatus({}), null);
  assert.equal(trackExplicitStatus(null), null);
});

test('the failure direction: clean, no tag and unknown all pass, only a positive tag drops', () => {
  const unknown = { id: 'never-heard-of-it', title: 'U', artist: 'D' };
  assert.deepEqual(ids(withoutExplicit([...ROWS, unknown], true)), ['c', 'n', 'never-heard-of-it']);
});

test('off is the input, and on or off the answer is never the input array', () => {
  assert.deepEqual(withoutExplicit(ROWS, false), ROWS);
  assert.notEqual(withoutExplicit(ROWS, false), ROWS);
  const none = [CLEAN];
  assert.notEqual(withoutExplicit(none, true), none);
  const off = explicitGate<typeof EXPLICIT>({});
  assert.notEqual(off.pass(ROWS as any), ROWS);
  assert.deepEqual(off.pass(ROWS as any), ROWS);
  assert.deepEqual(off.held(), [], 'off holds nothing back');
  assert.equal(off.on, false);
});

test('a gate remembers what it held, once per track, across a whole build', () => {
  const gate = explicitGate<any>({ excludeExplicit: true });
  assert.deepEqual(ids(gate.pass(ROWS)), ['c', 'n']);
  gate.pass([EXPLICIT]);
  assert.deepEqual(ids(gate.held()), ['e']);
});

test('a track is held back only by a clean show, and only for a positive tag', () => {
  const clean = { excludeExplicit: true };
  assert.equal(heldBackFromShow(EXPLICIT, clean), true);
  assert.equal(heldBackFromShow(CLEAN, clean), false);
  assert.equal(heldBackFromShow(NO_TAG, clean), false);
  assert.equal(heldBackFromShow(EXPLICIT, {}), false);
  assert.equal(heldBackFromShow(EXPLICIT, null), false);
});

test('whether any show is clean, for a station that has none to pay nothing', () => {
  assert.equal(anyCleanShow([{ excludeExplicit: false }, { excludeExplicit: true }]), true);
  for (const shows of [[], [{}], [{ excludeExplicit: false }], null, undefined]) {
    assert.equal(anyCleanShow(shows), false, JSON.stringify(shows));
  }
});

test('a library that cannot answer reads as unknown, so the check never stops the music', () => {
  // A real read failure: the table is gone, so better-sqlite3 throws on prepare.
  db.upsertTrackMeta('readable', { title: 'r', explicitStatus: 'explicit' });
  const d = requireDb();
  d.exec('ALTER TABLE tracks RENAME TO tracks_gone');
  try {
    assert.equal(trackExplicitStatus({ id: 'readable' }), null);
    assert.deepEqual(ids(withoutExplicit([{ id: 'readable' }], true)), ['readable'], 'unknown passes');
    assert.equal(trackExplicitStatus({ id: 'readable', explicitStatus: 'explicit' }), 'explicit', 'the field needs no library');
  } finally {
    d.exec('ALTER TABLE tracks_gone RENAME TO tracks');
  }
});

test('an anchor loses its tagged tracks before a never-starve lock can bring them back', () => {
  // The only Rock track is tagged. Read last, the Rock lock would keep it; read
  // first, the lock finds nothing and is the one that gives way.
  const taggedRock = { ...EXPLICIT, id: 'er', genres: ['Rock'] };
  const anchor = [taggedRock, CLEAN];
  const opts = { excludedIds: null, resolvedGenres: ['Rock'] };
  assert.deepEqual(ids(airableAnchorTracks(anchor, { ...opts, show: { filtersStrict: true, excludeExplicit: true } })), ['c']);
  assert.deepEqual(ids(airableAnchorTracks(anchor, { ...opts, show: { filtersStrict: true } })), ['er'], 'off: as before');
});

test('an anchor of nothing but tagged tracks has nothing airable', () => {
  assert.deepEqual(airableAnchorTracks([EXPLICIT], { show: { excludeExplicit: true }, excludedIds: null }), []);
});

test('a full rotation and the hard window count only what can air', () => {
  const anchor = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, artist: 'A', explicitStatus: i < 4 ? 'explicit' : null }));
  const show = { playlistStrict: true, playlistExhaust: true, excludeExplicit: true };
  const guard = showNoRepeatGuard(0, 0, { show, playlistTracks: anchor, excludedIds: null });
  assert.equal(guard.rotation?.length, 8);
  assert.equal(guard.window, 6);
  assert.ok(guard.rotation!.every(t => t.explicitStatus !== 'explicit'));
  const off = showNoRepeatGuard(0, 0, { show: { ...show, excludeExplicit: false }, playlistTracks: anchor, excludedIds: null });
  assert.equal(off.rotation?.length, 12);
});

test('a strict show\'s small-pool catalogue excludes what it cannot air', () => {
  const show = { filtersStrict: true, excludeExplicit: true };
  assert.deepEqual(ids(strictShowLibraryPool(ROWS, { show, excludedIds: null, resolvedGenres: ['Jazz'] })!), ['c']);
});

test('a journey never heads for a tagged track', () => {
  const show = { genres: ['Jazz'], excludeExplicit: true };
  const pool = showDestinationPool({ show, playlistTracks: null, libraryRows: () => ROWS, resolvedGenres: ['Jazz'], excludedIds: null });
  assert.deepEqual(ids(pool!), ['c']);
  const off = showDestinationPool({ show: { genres: ['Jazz'] }, playlistTracks: null, libraryRows: () => ROWS, resolvedGenres: ['Jazz'], excludedIds: null });
  assert.deepEqual(ids(off!), ['e', 'c']);
});

test('the editor\'s count leaves out what the show holds back, and off counts as before', () => {
  const locks = { genres: [], eras: [], moods: [], energies: [], vocals: null };
  const on = buildShowCandidateDiagnostic({ show: { excludeExplicit: true }, libraryRows: ROWS, playlistRows: [EXPLICIT, CLEAN], excludedIds: null, locks });
  assert.deepEqual(on.library, { indexed: 3, matchingFilters: 2, afterExclusions: 2, effective: 2 });
  assert.deepEqual(on.playlist, { total: 2, matchingFilters: 1, afterExclusions: 1, effective: 1 });
  const off = buildShowCandidateDiagnostic({ show: {}, libraryRows: ROWS, playlistRows: null, excludedIds: null, locks });
  assert.deepEqual(off.library, { indexed: 3, matchingFilters: 3, afterExclusions: 3, effective: 3 });
});

test('the editor says when a clean show has nothing to hold back, and how much it does', async () => {
  db.getDb()!.exec('UPDATE tracks SET explicit_status = NULL');
  db.upsertTrackMeta('count-a', { title: 'a', artist: 'A' });
  const none = await diagnoseShowCandidates({ excludeExplicit: true });
  assert.ok(none.warnings.some(w => /No library track is tagged explicit yet/.test(w)), none.warnings.join(' | '));
  assert.ok(none.warnings.some(w => /only read when you run Reconcile with Navidrome/.test(w)), 'nothing reads them by itself, so it names the step');
  db.upsertTrackMeta('count-b', { title: 'b', artist: 'B', explicitStatus: 'explicit' });
  db.upsertTrackMeta('count-c', { title: 'c', artist: 'C', explicitStatus: 'explicit' });
  const two = await diagnoseShowCandidates({ excludeExplicit: true });
  assert.ok(two.warnings.some(w => /^2 library tracks are tagged explicit and held back/.test(w)), two.warnings.join(' | '));
  const off = await diagnoseShowCandidates({});
  assert.ok(!off.warnings.some(w => /tagged explicit/.test(w)), off.warnings.join(' | '));
});

test('turning a show clean is a new coast identity', () => {
  const show = { id: 's', name: 'S', genres: ['Jazz'] };
  assert.notEqual(autoPlaylistShowKey({ ...show, excludeExplicit: true }), autoPlaylistShowKey(show));
  assert.equal(autoPlaylistShowKey({ ...show, excludeExplicit: false }), autoPlaylistShowKey(show), 'absent reads as off');
  assert.equal(autoPlaylistShowKey({ ...show, excludeExplicit: 'yes' }), autoPlaylistShowKey(show));
});
