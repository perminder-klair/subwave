// "Never play" on the Dash's now-playing track: what the operator is told
// after the confirm dialog, and the read the optional skip is decided on. The
// block is the existing POST /library/blocklist (absolute, requests included);
// the skip is the existing POST /dj/skip and is the operator's choice in the
// dialog.
//
// Run: npm test -- never-play

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onlineManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { toast } from 'sonner';
import { blockPlayingTrack, neverPlayToast, notifyNeverPlay, refetchOnAirId, skipDecision } from './never-play';
import { dashKeys, removeQueuedRow } from './queries';
import type { DashStatus } from './types';
import type { BlockEntry } from '../library/types';

const T = { title: 'Blindspot', artist: 'Bomb the Bass' };

test('blocked and left to finish', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'not-asked' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · it finishes now',
  });
});

test('blocked and skipped', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'done' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · skipped',
  });
});

test('queued copies dropped by the purge are counted', () => {
  assert.equal(
    neverPlayToast({ ...T, block: 'added', skip: 'done', purged: 2 }).text,
    '“Blindspot” — Bomb the Bass will never air again · skipped · 2 dropped from queue',
  );
});

test('already on the list is not an error, and the skip still happens', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'already', skip: 'done' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass was already on the never-play list · skipped',
  });
});

// The block landed; only the skip failed. That must read as a partial
// success, never as "nothing happened", or the operator retries a block.
test('a failed skip after a block is a warning naming what did land', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'failed', skipError: 'liquidsoap telnet down' }), {
    tone: 'err',
    text: '“Blindspot” — Bomb the Bass will never air again · skip failed: liquidsoap telnet down',
  });
});

test('no artist: the title alone', () => {
  assert.equal(
    neverPlayToast({ title: 'Untitled', block: 'added', skip: 'not-asked' }).text,
    '“Untitled” will never air again · it finishes now',
  );
});

// The track can change while the block request is in flight (a slow
// Navidrome getSong has no upper bound). The skip is decided on a FRESH
// read taken after the block lands, never on the status the click saw.
test('skip decision: still on air after the block, so skip', () => {
  assert.equal(skipDecision({ targetId: 'a', onAirId: 'a' }), 'skip');
});

test('skip decision: the track changed during the block, so nothing is skipped', () => {
  assert.equal(skipDecision({ targetId: 'a', onAirId: 'b' }), 'moot');
});

test('skip decision: no fresh on-air track is never skipped', () => {
  assert.equal(skipDecision({ targetId: 'a', onAirId: undefined }), 'unconfirmed');
});

// The skip is decided on the server's answer to a status refetch sent once
// the block has landed. These drive a real QueryClient with the Dash's status
// query mounted, as the panel mounts it.

/** The station behind the Dash's status poll. A read is answered with what is
 *  on air when it is served; while `held`, reads wait on the wire. */
function station(onAir: string) {
  const waiting: Array<() => void> = [];
  const s = {
    onAir,
    held: false,
    failing: false,
    reads: 0,
    release() {
      s.held = false;
      for (const serve of waiting.splice(0)) serve();
    },
    queryFn: ({ signal }: { signal: AbortSignal }) => new Promise<DashStatus>((resolve, reject) => {
      s.reads++;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      const serve = () => {
        if (s.failing) reject(new Error('controller unreachable'));
        else resolve({
          nowPlaying: s.onAir ? { subsonic_id: s.onAir, title: s.onAir } : null,
          queue: { upcoming: [{ subsonic_id: 'q1', title: 'Queued' }] },
        });
      };
      if (s.held) waiting.push(serve);
      else serve();
    }),
  };
  return s;
}

/** The Dash mounted, with its first poll in the cache. */
async function mountedDash(s: ReturnType<typeof station>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver<DashStatus>(client, {
    queryKey: dashKeys.status(), queryFn: s.queryFn, staleTime: 0,
  });
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch({ cancelRefetch: false });
  return {
    client,
    unmount: unsubscribe,
    cachedOnAir: () => client.getQueryData<DashStatus>(dashKeys.status())?.nowPlaying?.subsonic_id,
    done: () => {
      unsubscribe();
      client.clear();
    },
  };
}

// The block request's round trip: every poll before it is older than the block.
const blockLands = () => new Promise(resolve => setTimeout(resolve, 5));

test('fresh read: the refetch after the block names what is on air now', async () => {
  const s = station('a');
  const dash = await mountedDash(s);
  await blockLands();
  assert.equal(await refetchOnAirId(dash.client), 'a');
  // The track changed while the block was in flight.
  s.onAir = 'b';
  assert.equal(await refetchOnAirId(dash.client), 'b');
  assert.equal(skipDecision({ targetId: 'a', onAirId: 'b' }), 'moot');
  dash.done();
});

// #2018. Removing a queue row cancels the status read in flight, then writes
// the pre-block status back minus the row. That write is stamped as fresh as
// any read, and it still names the blocked track after the server has moved
// on, so a skip decided on the cache cut the next song for every listener.
test('fresh read: a queue row removed while the refetch is on the wire is no read', async () => {
  const s = station('a');
  const dash = await mountedDash(s);
  await blockLands();
  s.onAir = 'b';
  s.held = true;
  const read = refetchOnAirId(dash.client);
  await removeQueuedRow(dash.client, 'q1');
  s.release();
  const onAirId = await read;
  // The trap: the cache names the blocked track, just written.
  assert.equal(dash.cachedOnAir(), 'a');
  assert.equal(onAirId, undefined);
  assert.equal(skipDecision({ targetId: 'a', onAirId }), 'unconfirmed');
  dash.done();
});

// Another Dash action's invalidation cancels the refetch and starts its own:
// that read was sent later still, so its answer stands.
test('fresh read: a newer read that supersedes the refetch answers for it', async () => {
  const s = station('a');
  const dash = await mountedDash(s);
  await blockLands();
  s.held = true;
  const read = refetchOnAirId(dash.client);
  void dash.client.invalidateQueries({ queryKey: dashKeys.status() });
  s.onAir = 'b';
  s.release();
  assert.equal(await read, 'b');
  assert.equal(s.reads, 3);
  dash.done();
});

// A poll already answered when the refetch goes out is past cancelling, and
// writes its answer a tick later, inside the window. The refetch's own answer
// lands after it and must be the one that stands: the LAST success counts.
test('fresh read: a poll answered as the refetch goes out is overruled by the refetch', async () => {
  const s = station('a');
  const dash = await mountedDash(s);
  s.held = true;
  void dash.client.invalidateQueries({ queryKey: dashKeys.status() });
  await blockLands();
  s.release();
  s.onAir = 'b';
  // The poll has resolved but not yet written its answer to the cache.
  await Promise.resolve();
  assert.equal(await refetchOnAirId(dash.client), 'b');
  assert.equal(s.reads, 3);
  dash.done();
});

// refetchQueries swallows a failed fetch and returns at once while offline,
// leaving a poll taken before the block landed in the cache: the very read the
// guard refuses, so it must not decide a skip.
test('fresh read: a failed refetch leaves no read at all', async () => {
  const s = station('a');
  const dash = await mountedDash(s);
  await blockLands();
  s.failing = true;
  const onAirId = await refetchOnAirId(dash.client);
  assert.equal(onAirId, undefined);
  assert.equal(skipDecision({ targetId: 'a', onAirId }), 'unconfirmed');
  dash.done();
});

test('fresh read: offline, the refetch returns at once with no read', async () => {
  const s = station('a');
  const dash = await mountedDash(s);
  await blockLands();
  onlineManager.setOnline(false);
  try {
    assert.equal(await refetchOnAirId(dash.client), undefined);
  } finally {
    onlineManager.setOnline(true);
  }
  dash.done();
});

// Unmounting cancels the read and reverts the query: TanStack then hands the
// fetch's caller the CACHED data as its result, which is why the answer is
// taken from the fetch's own success and not from what the fetch returns.
test('fresh read: the Dash unmounting mid-read leaves no read', async () => {
  const s = station('a');
  const dash = await mountedDash(s);
  await blockLands();
  s.onAir = 'b';
  s.held = true;
  const read = refetchOnAirId(dash.client);
  dash.unmount();
  s.release();
  assert.equal(await read, undefined);
  dash.done();
});

test('fresh read: one naming no track gives no id', async () => {
  const s = station('');
  const dash = await mountedDash(s);
  assert.equal(await refetchOnAirId(dash.client), undefined);
  dash.done();
});

test('fresh read: a Dash that never read its status has nothing to refetch', async () => {
  assert.equal(await refetchOnAirId(new QueryClient()), undefined);
});

test('a skip asked for but moot says so, rather than "it finishes now"', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'moot' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · no longer on air, nothing skipped',
  });
});

// No fresh read: the track may well still be on air, so "no longer on air"
// would be a guess.
test('a skip with no fresh read says it was not confirmed, not that the track left', () => {
  assert.deepEqual(neverPlayToast({ ...T, block: 'added', skip: 'unconfirmed' }), {
    tone: 'ok',
    text: '“Blindspot” — Bomb the Bass will never air again · not confirmed on air, nothing skipped',
  });
});

// The controller contract the block relies on: 201 { entry, purged } on a
// new entry, 409 on a duplicate, anything else is a failure.
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, fetcher };
}

test('block: 201 carries the entry and the purge count, posted as a track block', async () => {
  const entry = { type: 'track', id: 'a', name: 'Blindspot' };
  const s = stubFetch(201, { entry, purged: 2 });
  assert.deepEqual(await blockPlayingTrack(s.fetcher, 'a'), { block: 'added', purged: 2, entry });
  const [call] = s.calls;
  assert.ok(call);
  assert.equal(call.path, '/library/blocklist');
  assert.equal(call.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(call.init?.body)), { type: 'track', trackId: 'a' });
});

test('block: 409 already blocked is an outcome, not an error', async () => {
  const s = stubFetch(409, { error: 'already blocked' });
  assert.deepEqual(await blockPlayingTrack(s.fetcher, 'a'), { block: 'already' });
});

test('block: any other failure throws, so nothing is skipped', async () => {
  const s = stubFetch(500, { error: 'boom' });
  await assert.rejects(() => blockPlayingTrack(s.fetcher, 'a'));
});

// The block landed whatever happened to the skip, so a new entry always keeps
// its Undo: the same label, the same 10s, the same lift.
const ENTRY: BlockEntry = {
  type: 'track', id: 'a', name: 'Blindspot', artist: 'Bomb the Bass', album: null, addedAt: '2026-10-20T12:00:00Z',
};

function lastToast() {
  const t = toast.getHistory().at(-1);
  assert.ok(t && !('dismiss' in t && t.dismiss));
  return t as { type?: string; title?: unknown; duration?: number; action?: { label: string; onClick: (e: unknown) => void } };
}

test('a failed skip after a new block is an error that still offers Undo', async () => {
  const lifted: BlockEntry[] = [];
  const t = neverPlayToast({ ...T, block: 'added', skip: 'failed', skipError: 'liquidsoap telnet down' });
  notifyNeverPlay(t, ENTRY, async e => { lifted.push(e); });
  const shown = lastToast();
  assert.equal(shown.type, 'error');
  assert.equal(shown.title, t.text);
  assert.equal(shown.duration, 10_000);
  assert.equal(shown.action?.label, 'Undo');
  shown.action?.onClick({});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lifted, [ENTRY]);
  assert.equal(lastToast().title, '“Blindspot” can play again');
});

test('a landed block and skip is the success toast with Undo, as before', () => {
  notifyNeverPlay(neverPlayToast({ ...T, block: 'added', skip: 'done' }), ENTRY, async () => {});
  const shown = lastToast();
  assert.equal(shown.type, 'success');
  assert.equal(shown.action?.label, 'Undo');
});

// "Already blocked" has no new entry to lift, so nothing to undo.
test('no new entry: no Undo, error or not', () => {
  notifyNeverPlay(neverPlayToast({ ...T, block: 'already', skip: 'failed' }), undefined, async () => {});
  assert.equal(lastToast().type, 'error');
  assert.equal(lastToast().action, undefined);
  notifyNeverPlay(neverPlayToast({ ...T, block: 'already', skip: 'done' }), undefined, async () => {});
  assert.equal(lastToast().type, 'success');
  assert.equal(lastToast().action, undefined);
});
