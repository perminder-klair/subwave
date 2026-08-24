// Regression pin for cache-side era overrides (#1418).
// Run from the repo root: npx tsx web/components/admin/library/queries.test.ts

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

console.log('era-year cache targeting passed');
