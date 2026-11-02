// The never-play list's shared track writes (block-actions.ts), used by the
// Library page and the Dash's Never play.
//
// Run: npm test -- block-actions

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { deleteBlockEntry, liftedText, postBlock, restampCachedBlockMarks } from './block-actions';
import { libraryKeys, rowsOf } from './queries';
import type { Track } from './types';

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetcher };
}

test('block: posted as { type, trackId }, the 201 body returned as is', async () => {
  const entry = { type: 'track', id: 'a', name: 'Blindspot' };
  const s = stubFetch(201, { entry, purged: 1 });
  assert.deepEqual(await postBlock(s.fetcher, 'track', 'a'), { entry, purged: 1 });
  const [call] = s.calls;
  assert.ok(call);
  assert.equal(call.path, '/library/blocklist');
  assert.equal(call.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(call.init?.body)), { type: 'track', trackId: 'a' });
});

test('block: a 409 throws, so each caller decides what "already" means', async () => {
  const s = stubFetch(409, { error: 'already blocked' });
  await assert.rejects(() => postBlock(s.fetcher, 'track', 'a'));
});

test('unblock: DELETE on the entry path, id encoded', async () => {
  const s = stubFetch(200, { removed: true });
  await deleteBlockEntry(s.fetcher, { type: 'track', id: 'a/b' });
  const [call] = s.calls;
  assert.ok(call);
  assert.equal(call.path, '/library/blocklist/track/a%2Fb');
  assert.equal(call.init?.method, 'DELETE');
});

// Lifted from the Blocked tab, another tab or MCP before Undo was pressed:
// the entry is gone, which is what Undo asked for.
test('unblock: a 404 is already lifted, not a failure', async () => {
  const s = stubFetch(404, { error: 'not blocked' });
  await deleteBlockEntry(s.fetcher, { type: 'track', id: 'a' });
});

test('unblock: any other failure still throws', async () => {
  const s = stubFetch(500, { error: 'boom' });
  await assert.rejects(() => deleteBlockEntry(s.fetcher, { type: 'track', id: 'a' }));
});

// Called from the Dash, where the Library's lists may never have loaded.
test('restamp: nothing cached means no request at all', async () => {
  const qc = new QueryClient();
  const s = stubFetch(200, { blocked: {} });
  await restampCachedBlockMarks(qc, s.fetcher);
  assert.equal(s.calls.length, 0);
});

// Re-marks the loaded rows in place rather than invalidating them, which
// would refetch every list from Navidrome on the Library's next mount.
test('restamp: cached rows are re-marked from one check, never invalidated', async () => {
  const qc = new QueryClient();
  const a: Track = { id: 'a', title: 'Blindspot', artist: 'Bomb the Bass', album: 'Unknown Territory' };
  const b: Track = { id: 'b', title: 'Winter in July', artist: 'Bomb the Bass', album: 'Unknown Territory' };
  qc.setQueryData(libraryKeys.recent(), [a, b]);
  const mark = { type: 'track', id: 'a', name: 'Blindspot' };
  const s = stubFetch(200, { blocked: { a: mark, b: null } });
  await restampCachedBlockMarks(qc, s.fetcher);

  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]?.path, '/library/blocklist/check');
  assert.deepEqual(JSON.parse(String(s.calls[0]?.init?.body)).tracks.map((t: { id: string }) => t.id), ['a', 'b']);
  const rows = rowsOf(qc.getQueryData(libraryKeys.recent()));
  assert.deepEqual(rows.find(r => r.id === 'a')?.blockedBy, mark);
  assert.equal(rows.find(r => r.id === 'b')?.blockedBy, null);
  assert.equal(qc.getQueryState(libraryKeys.recent())?.isInvalidated, false);
});

test('the lifted copy names the entry, falling back to its id', () => {
  assert.equal(liftedText({ id: 'a', name: 'Blindspot' }), '“Blindspot” can play again');
  assert.equal(liftedText({ id: 'a', name: null }), '“a” can play again');
});
