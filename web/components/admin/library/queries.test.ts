// Regression pin for cache-side era overrides (#1418).
// Run from web/: `npm test -- library/queries`.

import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { applyEraYearEvent, libraryKeys, rowsOf } from './queries';
import type { Track } from './types';

const qc = new QueryClient();
const target: Track = { id: 'target', title: 'Song A', artist: 'Artist A', album: 'Greatest Hits' };
const sibling: Track = { id: 'sibling', title: 'Song B', artist: 'Artist A', album: 'Greatest Hits' };
const namesake: Track = { id: 'namesake', title: 'Song C', artist: 'Artist B', album: 'Greatest Hits' };

qc.setQueryData(libraryKeys.recent(), [target, sibling, namesake]);

applyEraYearEvent(qc, {
  originalYear: 1978,
  // The endpoint returns the authoritative target ids. Album titles are not
  // identities: unrelated artists commonly publish records with this name.
  trackIds: ['target', 'sibling'],
});

const rows = rowsOf(qc.getQueryData(libraryKeys.recent()));
assert.equal(rows.find((r) => r.id === 'target')?.originalYear, 1978);
assert.equal(rows.find((r) => r.id === 'sibling')?.originalYear, 1978);
assert.equal(rows.find((r) => r.id === 'namesake')?.originalYear, undefined,
  'a same-title album outside the server response must remain untouched');

// The Era tab's album track list shows the saved year at once, not its old
// one until the refetch (the field falls back to the album year meanwhile).
const eraKey = libraryKeys.eraAlbum('greatest-hits');
qc.setQueryData(eraKey, { tracks: [
  { id: 'target', originalYear: null, originalYearSource: null, yearState: 'unchecked' },
  { id: 'other', originalYear: 1990, originalYearSource: 'musicbrainz', yearState: 'resolved' },
] });
applyEraYearEvent(qc, { originalYear: 1975, trackIds: ['target'] });
const era = qc.getQueryData<{ tracks: Array<{ id: string; originalYear: number | null; originalYearSource: string | null; yearState: string }> }>(eraKey);
assert.deepEqual(era?.tracks.find((t) => t.id === 'target'),
  { id: 'target', originalYear: 1975, originalYearSource: 'manual', yearState: 'resolved' });
assert.equal(era?.tracks.find((t) => t.id === 'other')?.originalYear, 1990, 'another line keeps its year');
// A clear waits for the refetch: the lookup year it falls back to is unknown here.
applyEraYearEvent(qc, { originalYear: null, trackIds: ['target'] });
assert.equal(qc.getQueryData<{ tracks: Array<{ id: string; originalYear: number | null }> }>(eraKey)?.tracks[0]?.originalYear, 1975);

console.log('era-year cache targeting passed');
