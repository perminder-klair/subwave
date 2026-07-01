// Unit tests for the pure playlist-anchor merge helper. Side-effect-free, so
// it's pinned here without touching Subsonic. Run via `npm test`.
// node:assert-via-tsx style, matching scripts/recent-plays.test.ts.

import assert from 'node:assert/strict';
import { mergePlaylistTracks } from '../src/music/show-playlist.js';

// Empty / falsy inputs → empty pool.
assert.deepEqual(mergePlaylistTracks([]), [], 'no lists → empty');
assert.deepEqual(mergePlaylistTracks([[], []]), [], 'empty lists → empty');
assert.deepEqual(mergePlaylistTracks([null as any, undefined as any]), [], 'null/undefined lists tolerated');

// Single list passes through, preserving order.
assert.deepEqual(
  mergePlaylistTracks([[{ id: 'a' }, { id: 'b' }]]).map(t => t.id),
  ['a', 'b'],
  'single list preserves order',
);

// Union across lists, first occurrence wins (dedupe by id).
assert.deepEqual(
  mergePlaylistTracks([
    [{ id: 'a', n: 1 }, { id: 'b', n: 1 }],
    [{ id: 'b', n: 2 }, { id: 'c', n: 2 }],
  ]).map(t => `${t.id}:${t.n}`),
  ['a:1', 'b:1', 'c:2'],
  'union dedupes by id, first occurrence wins',
);

// Entries without an id are dropped (a playlist row Subsonic returned malformed).
assert.deepEqual(
  mergePlaylistTracks([[{ id: 'a' }, { title: 'no id' } as any, { id: '' } as any, { id: 'b' }]]).map(t => t.id),
  ['a', 'b'],
  'entries without an id are dropped',
);

// Duplicates WITHIN one list also collapse.
assert.deepEqual(
  mergePlaylistTracks([[{ id: 'a' }, { id: 'a' }, { id: 'a' }]]).map(t => t.id),
  ['a'],
  'intra-list duplicates collapse',
);

console.log('show-playlist merge checks passed');
