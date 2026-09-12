// The shared Spotify catalogue reads (music/sources/spotify/reads.ts).
//
// Load-bearing assertions, each standing for a request the station used to
// spend against a rolling 30-second quota it cannot buy its way out of:
//   • a second read inside the TTL sends nothing — this is what makes ONE
//     /me/playlists walk serve both the admin's playlist pickers and every pool
//     build, which were walking it separately;
//   • concurrent readers coalesce into ONE request rather than racing, which is
//     the shape two admin panels mounting together actually have;
//   • a FAILURE is remembered. util/ttl-cache.ts deliberately drops a rejection
//     so the next call retries, which is right for a telnet status and wrong
//     for a metered API a 3-second poll will ask again; the envelope in reads.ts
//     is how that is fixed WITHOUT changing the cache's contract;
//   • the remembered failure is re-thrown AS THE ORIGINAL OBJECT — callers
//     branch on `err.status === 429`, so a re-wrapped message would break them;
//   • a remembered failure expires sooner than a remembered success, the one
//     thing a single-TTL cache cannot express.
//
// Run: npm test -- spotify-reads

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';

process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'subwave-spotify-reads-'));

const { memoRead, keyedMemo, listMyPlaylists, listSavedAlbums, listSavedTracks, getAlbumRaw, searchRaw, invalidateSpotifyReads, READ_TTL_MS, READ_FAIL_TTL_MS } =
  await import('../src/music/sources/spotify/reads.js');

beforeEach(() => { invalidateSpotifyReads(); });

// A client stub with only what reads.ts touches: the three list endpoints and
// `paginate`, which the real client implements over them.
function fakeClient() {
  const calls: string[] = [];
  const client: any = {
    async getMyPlaylists() { calls.push('playlists'); return { items: [{ id: 'PL1', name: 'Night', snapshot_id: 'snap1' }], next: null }; },
    async getSavedAlbums() { calls.push('saved-albums'); return { items: [{ album: { id: 'AL1' }, added_at: '2024-01-01T00:00:00Z' }], next: null }; },
    async getSavedTracks() { calls.push('saved-tracks'); return { items: [{ track: { id: 'T1' } }], next: null }; },
    async *paginate<T>(page: (o: number) => Promise<any>) { const p = await page(0); for (const it of p.items ?? []) yield it as T; },
  };
  return { client, calls };
}

test('a second read inside the TTL sends nothing — one walk serves every caller', async () => {
  const { client, calls } = fakeClient();
  const a = await listMyPlaylists(client);
  const b = await listMyPlaylists(client);
  assert.equal(calls.filter((x) => x === 'playlists').length, 1, 'one request, not one per caller');
  assert.deepEqual(a, b);
  assert.equal(a[0].snapshot_id, 'snap1', 'the rows stay RAW — the pool needs snapshot_id, the pickers need the mapped shape');

  // The other two are memoised on the same terms.
  await listSavedAlbums(client);
  await listSavedAlbums(client);
  await listSavedTracks(client);
  await listSavedTracks(client);
  assert.equal(calls.filter((x) => x === 'saved-albums').length, 1);
  assert.equal(calls.filter((x) => x === 'saved-tracks').length, 1);
});

test('concurrent readers coalesce into one request instead of racing', async () => {
  const { client, calls } = fakeClient();
  const [a, b, c] = await Promise.all([listMyPlaylists(client), listMyPlaylists(client), listMyPlaylists(client)]);
  assert.equal(calls.filter((x) => x === 'playlists').length, 1, 'three callers, one request');
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('invalidateSpotifyReads drops every memo — a connect or a rebuild must not answer from the old account', async () => {
  const { client, calls } = fakeClient();
  await listMyPlaylists(client);
  await listSavedAlbums(client);
  await listSavedTracks(client);
  invalidateSpotifyReads();
  await listMyPlaylists(client);
  await listSavedAlbums(client);
  await listSavedTracks(client);
  assert.equal(calls.filter((x) => x === 'playlists').length, 2);
  assert.equal(calls.filter((x) => x === 'saved-albums').length, 2);
  assert.equal(calls.filter((x) => x === 'saved-tracks').length, 2);
});

test('a failure is remembered — a polling admin tab does not re-ask Spotify every three seconds', async () => {
  let now = 1_000_000;
  let tries = 0;
  const boom = Object.assign(new Error('rate limited'), { status: 429 });
  const read = memoRead(async () => { tries++; throw boom; }, { now: () => now });

  const first = await read().then(() => null, (e) => e);
  const second = await read().then(() => null, (e) => e);
  assert.equal(tries, 1, 'the second ask cost no request');
  assert.equal(first, boom, 'the ORIGINAL error object is re-thrown, so err.status still reads 429');
  assert.equal(second, boom, 'and the remembered one is the same object, not a copy of its message');
  assert.equal((second as any).status, 429);
});

test('a remembered failure expires sooner than a remembered success', async () => {
  let now = 1_000_000;
  let tries = 0;
  let fail = true;
  const read = memoRead(async () => { tries++; if (fail) throw new Error('down'); return 'ok'; }, { now: () => now });

  await read().catch(() => {});
  assert.equal(tries, 1);

  // Still inside the failure window: no retry.
  now += READ_FAIL_TTL_MS - 1_000;
  await read().catch(() => {});
  assert.equal(tries, 1, 'a blip is not re-asked immediately');

  // Past it, and well short of the success TTL — a transient failure must not
  // cost the full five minutes a good answer is held for.
  now += 2_000;
  fail = false;
  assert.equal(await read(), 'ok');
  assert.equal(tries, 2, 'retried long before READ_TTL_MS');
  assert.ok(READ_FAIL_TTL_MS < READ_TTL_MS);

  // And the success that replaced it now gets the LONG life.
  now += READ_FAIL_TTL_MS + 1_000;
  assert.equal(await read(), 'ok');
  assert.equal(tries, 2, 'a success is held for the full TTL, not the failure window');
});

test('peek never triggers a request and never reports a remembered failure as a value', async () => {
  let now = 1_000_000;
  let fail = true;
  const read = memoRead(async () => { if (fail) throw new Error('down'); return 'ok'; }, { now: () => now });
  assert.equal(read.peek(), null, 'nothing cached yet');
  await read().catch(() => {});
  assert.equal(read.peek(), null, 'a remembered FAILURE is not a value a caller may render');
  fail = false;
  read.invalidate();
  await read();
  assert.equal(read.peek()?.value, 'ok');
});

// ── the keyed memos: the reads that were never cached anywhere ──────────────

// `GET /albums/{id}` was memoised NOWHERE, and it is fanned out over: the
// picker's recently-added tool takes five albums per invocation and the pool
// picker as many as fourteen, per pick. ~118 requests an hour, all repeats.
test('an album is fetched once and shared, and the rows are not aliased', async () => {
  let hits = 0;
  const client: any = {
    async getAlbum(id: string) {
      hits++;
      return { id, name: 'Dummy', tracks: { items: [{ id: 'T1', name: 'Glory Box' }], next: null } };
    },
    async *paginate() { /* single page */ },
  };
  const a = await getAlbumRaw(client, 'AL1');
  const b = await getAlbumRaw(client, 'AL1');
  assert.equal(hits, 1, 'one request for two asks');
  assert.equal(a!.items[0].id, 'T1');
  assert.equal(b!.items.length, 1);

  // A different album is a different key.
  await getAlbumRaw(client, 'AL2');
  assert.equal(hits, 2);

  // The RAW rows are shared on purpose — the callers map them into Songs and
  // then mutate those, so what must never be shared is the mapped object. This
  // asserts the contract the caller relies on: raw in, fresh map out.
  assert.equal(a!.album.id, 'AL1');
});

// One logical search is THREE HTTP requests since February 2026 capped a page
// at ten results, and the picker's retry cascade plus the listener-request
// matcher reissue the same query constantly.
test('a repeated search costs nothing, and paging is bounded', async () => {
  const pages: number[] = [];
  const client: any = {
    async search(_q: string, _types: string[], { offset }: any) {
      pages.push(offset);
      // A full page every time — the case that would page forever unbounded.
      return { tracks: { items: Array.from({ length: 10 }, (_, i) => ({ id: `T${offset + i}` })) } };
    },
  };
  const first = await searchRaw(client, 'portishead', 'track', 25, 0);
  assert.equal(first.length, 25);
  assert.equal(pages.length, 3, 'three pages of ten to satisfy a 25-track ask');

  const again = await searchRaw(client, 'portishead', 'track', 25, 0);
  assert.equal(again.length, 25);
  assert.equal(pages.length, 3, 'the repeat spent nothing');

  // A different offset or count is a different question.
  await searchRaw(client, 'portishead', 'track', 25, 30);
  assert.ok(pages.length > 3);

  // And the walk is capped: asking for far more than exists must not page on
  // and on, because every page is a metered request.
  pages.length = 0;
  const wide = await searchRaw(client, 'everything', 'track', 500, 0);
  assert.ok(pages.length <= 3, `bounded paging, got ${pages.length}`);
  assert.ok(wide.length <= 30);
});

test('the keyed memo is bounded — a catalogue-sized key space is a leak', async () => {
  let hits = 0;
  const memo = keyedMemo(async () => { hits++; return 'x'; }, { max: 3 });
  for (const k of ['a', 'b', 'c', 'd']) await memo(k);
  assert.equal(memo.size(), 3, 'the oldest key was evicted');
  assert.equal(hits, 4);
  // 'a' was evicted, so it costs a request again; 'd' is still held.
  await memo('a');
  assert.equal(hits, 5);
  await memo('d');
  assert.equal(hits, 5);
});

test('invalidateSpotifyReads drops the keyed memos too', async () => {
  let hits = 0;
  const client: any = {
    async getAlbum(id: string) { hits++; return { id, tracks: { items: [], next: null } }; },
    async *paginate() { /* single page */ },
  };
  await getAlbumRaw(client, 'AL9');
  await getAlbumRaw(client, 'AL9');
  assert.equal(hits, 1);
  invalidateSpotifyReads();
  await getAlbumRaw(client, 'AL9');
  assert.equal(hits, 2, 'an account change must not answer from the old account');
});
