// Regression coverage for PR #1640's stale-socket policy. These use a real
// loopback HTTP server because a fetch stub that throws before dispatch cannot
// model the dangerous case: Navidrome commits a mutation, then its response is
// lost. Reads and explicitly idempotent operations retry; unknown writes do not.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

type RequestHandler = (endpoint: string, url: URL, res: ServerResponse) => void;

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-subsonic-retry-review-'));
let handler: RequestHandler = (_endpoint, _url, res) => ok(res);

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const endpoint = url.pathname.split('/').pop() || '';
  handler(endpoint, url, res);
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});

const address = server.address() as AddressInfo;
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = `http://127.0.0.1:${address.port}`;
process.env.NAVIDROME_USER = 'review-fixture';
process.env.NAVIDROME_PASS = 'review-fixture-secret';

const subsonic = await import('../src/music/subsonic.js');
const realWarn = console.warn;

function response(payload: Record<string, unknown> = {}) {
  return { 'subsonic-response': { status: 'ok', ...payload } };
}

function ok(res: ServerResponse, payload: Record<string, unknown> = {}) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response(payload)));
}

function loseCommittedResponse(res: ServerResponse) {
  // The application has already mutated its state. Closing the downstream TCP
  // connection now models a response lost after a committed Navidrome write.
  res.socket?.destroy();
}

test.beforeEach(() => {
  console.warn = () => {};
});

test.afterEach(() => {
  console.warn = realWarn;
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  rmSync(stateRoot, { recursive: true, force: true });
});

test('a lost read response is retried once over real localhost HTTP', async () => {
  let requests = 0;
  handler = (endpoint, _url, res) => {
    assert.equal(endpoint, 'getAlbumList2');
    requests += 1;
    if (requests === 1) return loseCommittedResponse(res);
    ok(res, { albumList2: { album: [{ id: 'album-1' }] } });
  };

  const albums = await subsonic.getAlbumList(0, 500);

  assert.equal(requests, 2);
  assert.deepEqual(albums, [{ id: 'album-1' }]);
});

test('an explicitly idempotent star retries after its response is lost', async () => {
  let requests = 0;
  let starred = false;
  handler = (endpoint, _url, res) => {
    assert.equal(endpoint, 'star');
    requests += 1;
    starred = true;
    if (requests === 1) return loseCommittedResponse(res);
    ok(res);
  };

  await subsonic.star('song-a');

  assert.equal(requests, 2);
  assert.equal(starred, true);
});

test('playlist create is not replayed after its committed response is lost', async () => {
  const playlists: Array<{ id: string; name: string; songs: string[] }> = [];
  let createRequests = 0;
  handler = (endpoint, url, res) => {
    if (endpoint === 'createPlaylist') {
      createRequests += 1;
      const playlist = {
        id: `playlist-${createRequests}`,
        name: url.searchParams.get('name') || '',
        songs: url.searchParams.getAll('songId'),
      };
      playlists.push(playlist);
      if (createRequests === 1) return loseCommittedResponse(res);
      return ok(res, { playlist });
    }
    assert.equal(endpoint, 'updatePlaylist');
    ok(res);
  };

  await subsonic.createPlaylist('response-loss-create', ['song-a']).catch(() => null);

  assert.equal(createRequests, 1, 'an ambiguous create must not be sent twice');
  assert.equal(playlists.length, 1, 'Navidrome should contain one created playlist');
});

test('playlist append is not duplicated after its committed response is lost', async () => {
  const songs = ['song-a'];
  let appendRequests = 0;
  handler = (endpoint, url, res) => {
    assert.equal(endpoint, 'updatePlaylist');
    appendRequests += 1;
    songs.push(...url.searchParams.getAll('songIdToAdd'));
    if (appendRequests === 1) return loseCommittedResponse(res);
    ok(res);
  };

  await subsonic.addToPlaylist('playlist-append', ['song-b']).catch(() => null);

  assert.equal(appendRequests, 1, 'an ambiguous append must not be sent twice');
  assert.deepEqual(songs, ['song-a', 'song-b']);
});

test('positional removal is not applied to the shifted playlist a second time', async () => {
  const songs = ['song-a', 'song-b', 'song-c'];
  let removeRequests = 0;
  handler = (endpoint, url, res) => {
    assert.equal(endpoint, 'updatePlaylist');
    removeRequests += 1;
    const indexes = url.searchParams.getAll('songIndexToRemove').map(Number);
    for (const index of [...indexes].sort((a, b) => b - a)) songs.splice(index, 1);
    if (removeRequests === 1) return loseCommittedResponse(res);
    ok(res);
  };

  await subsonic.removeFromPlaylist('playlist-remove', [1]).catch(() => null);

  assert.equal(removeRequests, 1, 'an ambiguous positional removal must not be sent twice');
  assert.deepEqual(songs, ['song-a', 'song-c']);
});

test('ping performs only its initial transport attempt plus one retry', async () => {
  let requests = 0;
  handler = (endpoint, _url, res) => {
    assert.equal(endpoint, 'ping');
    requests += 1;
    loseCommittedResponse(res);
  };

  const result = await subsonic.ping();

  assert.equal(result.ok, false);
  assert.equal(requests, 2, 'ping must not nest two shared retries inside its outer retry');
});

test('ping keeps its two-request ceiling when transport loss is followed by HTTP failure', async () => {
  let requests = 0;
  handler = (endpoint, _url, res) => {
    assert.equal(endpoint, 'ping');
    requests += 1;
    if (requests === 1) return loseCommittedResponse(res);
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('temporarily unavailable');
  };

  const result = await subsonic.ping();

  assert.equal(result.ok, false);
  assert.equal(requests, 2);
});

test('ping preserves one retry for a fast HTTP response failure', async () => {
  let requests = 0;
  handler = (endpoint, _url, res) => {
    assert.equal(endpoint, 'ping');
    requests += 1;
    if (requests === 1) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('temporarily unavailable');
      return;
    }
    ok(res);
  };

  const result = await subsonic.ping();

  assert.equal(result.ok, true);
  assert.equal(requests, 2);
});

test('ping keeps its two-request ceiling when HTTP failure is followed by transport loss', async () => {
  let requests = 0;
  handler = (endpoint, _url, res) => {
    assert.equal(endpoint, 'ping');
    requests += 1;
    if (requests === 1) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('temporarily unavailable');
      return;
    }
    loseCommittedResponse(res);
  };

  const result = await subsonic.ping();

  assert.equal(result.ok, false);
  assert.equal(requests, 2);
});
