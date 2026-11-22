// Sonic similarity is its own op, not similarSongs under another name. For a
// Navidrome server they are two endpoints and two picker signals:
// getSimilarSongs2 (Last.fm-style) and the OpenSubsonic sonicSimilarity
// extension's getSonicSimilarTracks (audio-based). The navidrome plugin asks the
// server at construction whether it has the extension, and the router must
// keep the two apart all the way through.
//
// The upstream here is a fake Subsonic server rather than a second router, so
// each test can say exactly what the server advertises and see exactly which
// endpoint was asked. The round trip against the router's own
// getSonicSimilarTracks payload is in conformance.test.ts.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prefixedCodec } from '../src/host/ids.js';
import { wrapPlugin } from '../src/host/wrap.js';
import type { SourcePlugin } from '../src/sdk/types.js';
import { configWith, startRouter, type RunningRouter } from './helpers.js';

// --- a fake Navidrome -------------------------------------------------------------

type Extensions = string[] | 'failed' | 'http-500' | 'hang';
type SonicShape = 'nested' | 'flat' | 'inline';

interface FakeNavidrome {
  base: string;
  /** Endpoints asked, in order. */
  hits: string[];
  extensions: Extensions;
  sonicShape: SonicShape;
  close(): Promise<void>;
}

const child = (id: string) => ({ id, title: `Title ${id}`, album: 'Album', albumId: 'al-1', artist: 'Artist', artistId: 'ar-1', duration: 180, suffix: 'mp3', contentType: 'audio/mpeg' });
const LASTFM = ['lastfm-1', 'lastfm-2'];
const SONIC = ['sonic-1', 'sonic-2', 'sonic-3'];

function sonicPayload(shape: SonicShape) {
  const matches = SONIC.map((id, i) => (shape === 'inline' ? { ...child(id), similarity: 0.9 - i / 10 } : { entry: child(id), similarity: 0.9 - i / 10 }));
  return shape === 'flat' ? { sonicMatch: matches } : { sonicSimilarTracks: { sonicMatch: matches } };
}

async function fakeNavidrome(): Promise<FakeNavidrome> {
  const fake = { hits: [] as string[], extensions: ['sonicSimilarity'] as Extensions, sonicShape: 'nested' as SonicShape };
  const server = createServer((req, res) => {
    const endpoint = new URL(req.url ?? '/', 'http://fake').pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
    fake.hits.push(endpoint);
    const send = (payload: Record<string, unknown>) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ 'subsonic-response': { version: '1.16.1', type: 'navidrome', openSubsonic: true, ...payload } }));
    };
    const ok = (payload: Record<string, unknown> = {}) => send({ status: 'ok', ...payload });
    const failed = (code: number, message: string) => send({ status: 'failed', error: { code, message } });
    switch (endpoint) {
      case 'getOpenSubsonicExtensions':
        if (fake.extensions === 'hang') return; // never answers
        if (fake.extensions === 'http-500') {
          res.statusCode = 500;
          return res.end('upstream exploded');
        }
        if (fake.extensions === 'failed') return failed(0, 'not implemented');
        return ok({ openSubsonicExtensions: fake.extensions.map((name) => ({ name, versions: [1] })) });
      case 'getSimilarSongs2':
        return ok({ similarSongs2: { song: LASTFM.map(child) } });
      case 'getSonicSimilarTracks':
        return ok(sonicPayload(fake.sonicShape));
      case 'getStarred2':
        return ok({ starred2: { song: [] } });
      case 'getScanStatus':
        return ok({ scanStatus: { scanning: false, count: 5 } });
      case 'getArtists':
        return ok({ artists: { index: [] } });
      case 'getGenres':
        return ok({ genres: { genre: [] } });
      default:
        return failed(0, `${endpoint} is not faked`);
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  });
}

// --- the router under test --------------------------------------------------------

let r: RunningRouter;
let up: FakeNavidrome;

before(async () => {
  // The extensions probe gets 5s in production; a hung server must not cost the suite that.
  r = await startRouter({ env: { ROUTER_NAVIDROME_PROBE_MS: '300' } });
  up = await fakeNavidrome();
});

after(async () => {
  await r.close();
  await up.close();
});

// A forced reload rebuilds the source, so the plugin probes the server again.
async function use(config: unknown): Promise<any> {
  r.writeConfig(config);
  const resp = await r.internal('/reload', { method: 'POST' });
  assert.equal(resp.status, 200);
  return resp.json();
}

// The station's default: Navidrome behind the router, keeping its own ids.
const navidrome = () => configWith([{ plugin: 'navidrome', config: { url: up.base, user: 'dj', password: 'navidrome-password' }, rawIds: true }]);

const sonicIds = (body: any) => body.sonicSimilarTracks.sonicMatch.map((m: any) => m.entry.id);

test('a Navidrome that advertises sonicSimilarity keeps it behind the router, on its own endpoint', async () => {
  up.extensions = ['songLyrics', 'sonicSimilarity'];
  const status = await use(navidrome());
  assert.equal(status.configError, null);
  assert.equal(status.serving.capabilities.sonicSimilarity, true);
  const ext = await r.rest('getOpenSubsonicExtensions');
  assert.ok(ext.openSubsonicExtensions.some((e: any) => e.name === 'sonicSimilarity'));

  up.hits.length = 0;
  const sonic = await r.rest('getSonicSimilarTracks', { id: 'seed-1', count: 5 });
  assert.equal(sonic.status, 'ok');
  assert.deepEqual(sonicIds(sonic), SONIC);
  const scores = sonic.sonicSimilarTracks.sonicMatch.map((m: any) => m.similarity);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, 'scores descend with rank');
  assert.ok(up.hits.includes('getSonicSimilarTracks'));
  assert.ok(!up.hits.includes('getSimilarSongs2'), 'sonic similarity is not answered from similar songs');

  up.hits.length = 0;
  const similar = await r.rest('getSimilarSongs2', { id: 'seed-1', count: 5 });
  assert.deepEqual(similar.similarSongs2.song.map((s: any) => s.id), LASTFM);
  assert.ok(up.hits.includes('getSimilarSongs2'));
  assert.ok(!up.hits.includes('getSonicSimilarTracks'), 'similar songs are not answered from sonic similarity');

  // The Signal path names the op that answered.
  const snap = (await (await r.internal('/activity')).json()) as any;
  const asked = snap.requests.find((q: any) => q.endpoint === 'getSonicSimilarTracks');
  assert.ok(asked.calls.some((c: any) => c.source === 'navidrome' && c.op === 'sonicSimilar' && c.state === 'ok'));
});

test('every sonicMatch shape a server sends unwraps to the same songs', async () => {
  up.extensions = ['sonicSimilarity'];
  await use(navidrome());
  for (const shape of ['nested', 'flat', 'inline'] as const) {
    up.sonicShape = shape;
    const sonic = await r.rest('getSonicSimilarTracks', { id: 'seed-1' });
    assert.equal(sonic.status, 'ok', shape);
    assert.deepEqual(sonicIds(sonic), SONIC, shape);
    assert.equal(sonic.sonicSimilarTracks.sonicMatch[0].entry.title, 'Title sonic-1', shape);
  }
  up.sonicShape = 'nested';
});

test('a Navidrome without the extension: no capability, and getSonicSimilarTracks is the Subsonic error', async () => {
  up.extensions = ['songLyrics'];
  const status = await use(navidrome());
  assert.equal(status.configError, null);
  assert.equal(status.serving.capabilities.sonicSimilarity, false);
  const ext = await r.rest('getOpenSubsonicExtensions');
  assert.ok(!ext.openSubsonicExtensions.some((e: any) => e.name === 'sonicSimilarity'));

  up.hits.length = 0;
  const sonic = await r.rest('getSonicSimilarTracks', { id: 'seed-1' });
  assert.equal(sonic.status, 'failed');
  assert.equal(sonic.error.code, 70);
  assert.ok(!up.hits.includes('getSonicSimilarTracks'), 'nothing asks the server for an endpoint it lacks');
  // Last.fm-style similarity is unaffected.
  const similar = await r.rest('getSimilarSongs2', { id: 'seed-1' });
  assert.deepEqual(similar.similarSongs2.song.map((s: any) => s.id), LASTFM);
});

test('an extensions probe that is refused, fails or hangs is a no, never a failed build', async () => {
  for (const mode of ['failed', 'http-500', 'hang'] as const) {
    up.extensions = mode;
    const started = Date.now();
    const status = await use(navidrome());
    assert.equal(status.configError, null, mode);
    assert.deepEqual(status.active.map((a: any) => a.plugin), ['navidrome'], mode);
    assert.equal(status.serving.capabilities.sonicSimilarity, false, mode);
    assert.ok(Date.now() - started < 5_000, `${mode}: the probe is bounded`);
    assert.equal((await r.rest('ping')).status, 'ok', mode);
  }
  // And the next rebuild asks again.
  up.extensions = ['sonicSimilarity'];
  const status = await use(navidrome());
  assert.equal(status.serving.capabilities.sonicSimilarity, true);
});

test('a plugin on the older capabilities.sonicSimilarity flag still answers from similarSongs', async () => {
  // The mock is that plugin: no sonicSimilar op, the flag on by default.
  const status = await use(configWith([{ plugin: 'mock' }]));
  assert.equal(status.serving.capabilities.sonicSimilarity, true);
  const seed = (await r.rest('getRandomSongs', { size: 1 })).randomSongs.song[0];
  const sonic = await r.rest('getSonicSimilarTracks', { id: seed.id, count: 5 });
  const similar = await r.rest('getSimilarSongs2', { id: seed.id, count: 5 });
  assert.equal(sonic.status, 'ok');
  assert.equal(sonicIds(sonic).length, 5);
  assert.deepEqual(sonicIds(sonic), similar.similarSongs2.song.map((s: any) => s.id));

  const off = await use(configWith([{ plugin: 'mock', config: { sonicSimilarity: false } }]));
  assert.equal(off.serving.capabilities.sonicSimilarity, false);
  assert.equal((await r.rest('getSonicSimilarTracks', { id: seed.id })).error.code, 70);
});

// --- the enforcement layer, without HTTP ------------------------------------------------

const quiet = { info() {}, warn() {}, error() {} };

function plugin(extra: Partial<SourcePlugin>): SourcePlugin {
  const none = async () => undefined;
  const empty = async () => [];
  return {
    song: none,
    album: none,
    artist: none,
    genres: empty,
    albumList: empty,
    songsByGenre: empty,
    randomSongs: empty,
    search: async () => ({ artists: [], albums: [], songs: [] }),
    stream: none,
    coverArt: none,
    ...extra,
  };
}

const wrap = (p: SourcePlugin) => wrapPlugin(p, { name: 'probe', label: 'Probe', codec: prefixedCodec('pr'), log: quiet });
const songs = (...ids: string[]) => async () => ids.map((id) => ({ id, title: id }));

test('wrap: sonicSimilar answers from the op when there is one, and the op wins over the flag', async () => {
  const both = wrap(plugin({ capabilities: { sonicSimilarity: false }, similarSongs: songs('lastfm'), sonicSimilar: songs('sonic') }));
  assert.equal(both.capabilities.sonicSimilarity, true);
  assert.equal(both.capabilities.similarSongs, true);
  assert.deepEqual((await both.sonicSimilar('pr-seed', 5)).map((s) => s.id), ['pr-sonic']);
  assert.deepEqual((await both.similarSongs('pr-seed', 5)).map((s) => s.id), ['pr-lastfm']);
  assert.deepEqual(await both.sonicSimilar('jf-not-mine', 5), [], 'an id the source does not own');
});

test('wrap: the flag alone serves sonic similarity from similarSongs; without similarSongs it claims nothing', async () => {
  const legacy = wrap(plugin({ capabilities: { sonicSimilarity: true }, similarSongs: songs('lastfm') }));
  assert.equal(legacy.capabilities.sonicSimilarity, true);
  assert.deepEqual((await legacy.sonicSimilar('pr-seed', 5)).map((s) => s.id), ['pr-lastfm']);

  const flagOnly = wrap(plugin({ capabilities: { sonicSimilarity: true } }));
  assert.equal(flagOnly.capabilities.sonicSimilarity, false);
  assert.deepEqual(await flagOnly.sonicSimilar('pr-seed', 5), []);

  const similarOnly = wrap(plugin({ similarSongs: songs('lastfm') }));
  assert.equal(similarOnly.capabilities.sonicSimilarity, false);
  assert.deepEqual(await similarOnly.sonicSimilar('pr-seed', 5), []);
});
