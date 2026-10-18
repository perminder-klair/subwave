// A strict-filter show is a closed catalogue, like a strict playlist:
// - the hard no-repeat window is sized from the show's own eligible pool, not
//   the whole library (a 290-play window against a 49-track show withheld
//   every track within hours and starved every discovery source);
// - when that pool is small, the agent is handed it through showPoolTracks
//   instead of probing searches that mostly return nothing.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-show-pool-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://show-pool.invalid';
const { showNoRepeatGuard, strictShowLibraryPool } = await import('../src/music/show-recency.js');
const { buildPickerTools, pickerScope } = await import('../src/llm/internal/tools/picker/index.js');
const { SMALL_SHOW_POOL_MAX } = await import('../src/llm/internal/tools/picker/tools/show-pool-tracks.js');
const library = await import('../src/music/library.js');
await library.load();
after(() => rmSync(stateRoot, { recursive: true, force: true }));

const row = (i: number, genre: string, extra: Record<string, unknown> = {}) => ({
  id: `t-${i}`, title: `Track ${i}`, artist: `Artist ${i % 17}`, genres: [genre], genre, durationSec: 200, ...extra,
});
// 49 Electronic tracks in a 1,000-track library: Night Signal's shape.
const libraryRows = [
  ...Array.from({ length: 49 }, (_, i) => row(i, 'Electronic')),
  ...Array.from({ length: 951 }, (_, i) => row(1000 + i, 'Punjabi')),
];
const strictShow = { filtersStrict: true, genres: ['Electronic'] };

test('the pool is the show\'s strict catalogue, and absent for a non-strict show', () => {
  assert.equal(strictShowLibraryPool(libraryRows, { show: strictShow, excludedIds: null })?.length, 49);
  assert.equal(strictShowLibraryPool(libraryRows, { show: { filtersStrict: false, genres: ['Electronic'] }, excludedIds: null }), null);
  assert.equal(strictShowLibraryPool(null, { show: strictShow, excludedIds: null }), null);
  const pool = strictShowLibraryPool(
    [...libraryRows, row(5000, 'Electronic', { durationSec: 40 })],
    { show: strictShow, excludedIds: new Set(['t-0', 't-1']), minTrackSec: 120 },
  );
  assert.equal(pool?.length, 47, 'exclusions and the length floor apply, as for a strict anchor');
  assert.equal(strictShowLibraryPool(libraryRows, { show: strictShow, excludedIds: null, resolvedGenres: [] })?.length, 1000,
    'an unresolved genre is no lock, so the pool is the library');
});

test('the hard window fits the show\'s pool, not the library', () => {
  const pool = strictShowLibraryPool(libraryRows, { show: strictShow, excludedIds: null });
  const opts = { show: strictShow, playlistTracks: null, excludedIds: null };
  assert.equal(showNoRepeatGuard(290, 10_159, opts).window, 290, 'without the pool: the library-wide window (the bug)');
  assert.equal(showNoRepeatGuard(290, 10_159, { ...opts, showLibraryPool: pool }).window, 18,
    '49 × 0.375 = 18, so 31 tracks stay pickable');
  assert.equal(showNoRepeatGuard(290, 10_159, { ...opts, showLibraryPool: pool!.slice(0, 30) }).window, 0,
    'a pool too small to carry a window hands over to the relaxable cascade');
  assert.equal(showNoRepeatGuard(10, 10_159, { ...opts, showLibraryPool: pool }).window, 0,
    'a configured window under the floor stays off');
});

test('a strict playlist keeps its own clamp; the library pool does not override it', () => {
  const playlist = Array.from({ length: 200 }, (_, i) => row(i, 'Electronic'));
  const guard = showNoRepeatGuard(290, 10_159, {
    show: { playlistStrict: true, filtersStrict: true, genres: ['Electronic'] },
    playlistTracks: playlist, excludedIds: null,
    showLibraryPool: strictShowLibraryPool(libraryRows, { show: strictShow, excludedIds: null }),
  });
  assert.equal(guard.window, 75, '200 × 0.375, from the playlist');
});

test('showPoolTracks is offered only for a small strict pool', () => {
  const small = libraryRows.slice(0, 49);
  assert.ok('showPoolTracks' in buildPickerTools(pickerScope({ showPool: small })).tools);
  assert.ok('showPoolTracks' in buildPickerTools(pickerScope({ showPool: libraryRows.slice(0, SMALL_SHOW_POOL_MAX) })).tools);
  assert.ok(!('showPoolTracks' in buildPickerTools(pickerScope({ showPool: libraryRows.slice(0, SMALL_SHOW_POOL_MAX + 1) })).tools),
    'a large pool is searched, not handed over');
  assert.ok(!('showPoolTracks' in buildPickerTools(pickerScope({ showPool: [] })).tools));
  assert.ok(!('showPoolTracks' in buildPickerTools(pickerScope()).tools));
});

async function call(tools: Record<string, any>) {
  return tools.showPoolTracks.execute({}, { toolCallId: 't', messages: [] });
}

test('showPoolTracks names the pool size and still honours the hard no-repeat guard', async () => {
  const pool = libraryRows.slice(0, 49);
  const { tools, seen } = buildPickerTools(pickerScope({
    showPool: pool,
    hardRecentIds: new Set(pool.slice(0, 40).map(t => t.id)),
  }));
  assert.match(String(tools.showPoolTracks.description), /allow only 49 tracks/);
  const out = await call(tools);
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 9, 'only the 9 tracks outside the hard window come back');
  assert.ok(out.every((t: any) => !pool.slice(0, 40).some(p => p.id === t.id)));
  assert.equal(seen.size, 9, 'returned tracks are resolvable picks');
});

test('an all-recent pool answers with a note, never a bare []', async () => {
  const pool = libraryRows.slice(0, 20);
  const { tools } = buildPickerTools(pickerScope({ showPool: pool, hardRecentIds: new Set(pool.map(t => t.id)) }));
  const out = await call(tools);
  assert.ok(!Array.isArray(out));
  assert.match(out.note, /20 matching track\(s\) exist/);
  assert.match(out.rule, /Never invent a song id/);
});
