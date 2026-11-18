// Track recency relaxes for the discovery list as a whole, never per source
// (#2320). collect() filters each tool's answer on its own, and a source left
// with only already-shown or just-played tracks used to fall through to the
// mode that drops the track-recency guard, so just-played tracks reached the
// shortlist beside a dozen fresh ones. Reported live on artist episodes: one
// song three times in an hour, every repeat from the second or third source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPickerCandidates } from '../src/music/recency.js';
import { buildPickerContext, pickerScope } from '../src/llm/internal/tools/picker/scope.js';

const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Song ${i}`, artist: 'The Artist' }));

test('allowTrackRelaxation: false keeps the track guard in every mode, and the default is unchanged', () => {
  const all = tracks(4);
  const recentIds = new Set(['t0', 't1']);
  const pool = [all[0], all[1], all[2]];
  const opts = { recentIds, seenIds: new Set(['t2']) };
  assert.deepEqual(filterPickerCandidates(pool, opts).map(t => t.id), ['t0', 't1'], 'the default still relaxes a starved pool');
  assert.deepEqual(filterPickerCandidates(pool, { ...opts, seenIds: new Set(['t2']), allowTrackRelaxation: false }), []);
  // With the artist guard locked too, and with the album stage in front.
  assert.deepEqual(filterPickerCandidates(pool, { ...opts, seenIds: new Set(['t2']), allowTrackRelaxation: false, allowArtistRelaxation: false }), []);
  assert.deepEqual(filterPickerCandidates(pool, { ...opts, seenIds: new Set(['t2']), allowTrackRelaxation: false, recentAlbums: new Set(['x']) }), []);
  // A fresh candidate still passes, and the hard window still holds.
  assert.deepEqual(filterPickerCandidates(all, { recentIds, hardRecentIds: new Set(['t3']), allowTrackRelaxation: false }).map(t => t.id), ['t2']);
});

test('a later source cannot bring just-played tracks in beside a fresh shortlist (#2320)', () => {
  const all = tracks(28);
  const recentIds = new Set(all.slice(0, 10).map(t => t.id));
  const ctx = buildPickerContext(pickerScope({ recentIds }));
  // episodeArtistTracks: the artist's fresh tracks fill its 12.
  const first = ctx.collect(all, 12, { order: 'source', maxPerArtist: Infinity });
  assert.equal(first.length, 12);
  assert.ok(first.every(t => !recentIds.has(t.id)));
  // showPlaylistTracks over the same artist: five just played, five already shown.
  const second = ctx.collect([...all.slice(0, 5), ...all.slice(10, 15)], 8, { order: 'source', maxPerArtist: Infinity });
  assert.deepEqual(second, [], 'nothing new to offer, so nothing; the recent five stay out');
  assert.ok([...ctx.seen.keys()].every(id => !recentIds.has(id)));
});

test('a list with nothing fresh yet still relaxes, so the pick is never starved by recency alone', () => {
  const all = tracks(6);
  const recentIds = new Set(all.map(t => t.id));
  const ctx = buildPickerContext(pickerScope({ recentIds }));
  assert.equal(ctx.collect(all.slice(0, 3), 8, { order: 'source' }).length, 3, 'all recent, nothing fresh anywhere: relaxed as before');
  // Still no fresh candidate in the list, so the next source relaxes too.
  assert.equal(ctx.collect(all.slice(3), 8, { order: 'source' }).length, 3);
});

test('a fresh candidate merged into seen from elsewhere counts too', () => {
  const all = tracks(4);
  const recentIds = new Set(['t0', 't1']);
  const ctx = buildPickerContext(pickerScope({ recentIds }));
  ctx.seen.set('t3', all[3]);
  assert.deepEqual(ctx.collect(all.slice(0, 2), 8, { order: 'source' }), []);
});
