// Track-level Last.fm tags, driven against a fake Last.fm over real HTTP: the
// response shapes, a real enrich pass end to end, and the retag route agreeing
// with it. There is no live key in CI, and these shapes are the part most likely
// to be wrong. The production URL is left alone: the one fetch that would leave
// the box is redirected to the fixture below.
//
// Run: npm test -- lastfm-track-tags

import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import express from 'express';
import { chatCompletion } from './test-utils/llm.js';
import { coldLoadSettings } from './test-utils/settings.js';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = await mkdtemp(join(tmpdir(), 'subwave-lastfm-tracks-'));

interface Reply { status?: number; body?: unknown; raw?: string; drop?: boolean }
const tagReply = (...names: string[]): Reply => ({
  body: { toptags: { tag: names.map((name, i) => ({ name, count: 100 - i })), '@attr': {} } },
});
const notFound: Reply = { body: { error: 6, message: 'Track not found' } };

const trackReplies = new Map<string, Reply>();
const artistReplies = new Map<string, Reply>();
// Artists whose next ask fails, once.
const failOnce = new Set<string>();
const asked: Array<{ url: string; query: URLSearchParams; at: number }> = [];
const embedded: string[] = [];
let textDim = 768;

const app = express();
app.use(express.json());
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/library/')) return app(req, res);
  if (url.pathname.startsWith('/lastfm/')) return answerLastfm(req.url || '', url.searchParams, res);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/v1/chat/completions') {
    return res.end(JSON.stringify(chatCompletion({
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'tag', type: 'function', function: {
        name: body.tool_choice?.function?.name ?? body.tools?.[0]?.function?.name ?? 'emit',
        arguments: JSON.stringify({ results: [{ moods: ['calm'], energy: 'low' }] }),
      } }] },
    })));
  }
  if (url.pathname === '/v1/embeddings') {
    embedded.push(...body.input);
    return res.end(JSON.stringify({
      object: 'list', model: 'fixture',
      data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: textDim }, (_, i) => (i === 0 ? 1 : 0)) }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
  }
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok' } }));
});

function answerLastfm(rawUrl: string, query: URLSearchParams, res: ServerResponse) {
  asked.push({ url: rawUrl.slice(rawUrl.indexOf('?') + 1), query, at: performance.now() });
  const isTrack = query.get('method') === 'track.getTopTags';
  if (!isTrack && failOnce.delete(query.get('artist') ?? '')) {
    res.statusCode = 503;
    return res.end('blip');
  }
  const reply = (isTrack
    ? trackReplies.get(`${query.get('artist')}|${query.get('track')}`) ?? notFound
    : artistReplies.get(query.get('artist') ?? '') ?? tagReply('rock', 'indie'));
  if (reply.drop) return res.destroy();
  res.statusCode = reply.status ?? 200;
  res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
}

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://ws.audioscrobbler.com/')) {
    return realFetch(url.replace('https://ws.audioscrobbler.com/', `${base}/lastfm/`), init);
  }
  return realFetch(input, init);
}) as typeof fetch;

process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = base;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';
process.env.LASTFM_API_KEY = 'fixture-key';

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const settings = await import('../src/settings.js');
const lastfm = await import('../src/music/lastfm.js');
const { createLastfmPacer } = await import('../src/music/lastfm-pacer.js');
const { selectTrackTagIds } = await import('../src/music/enrich-scope.js');
const { phaseEnrich, backfillLastfmTrackTags } = await import('../src/music/tag-library/enrich.js');
const { router: maintenanceRoutes } = await import('../src/routes/library/maintenance.js');
app.use(maintenanceRoutes);
await settings.load();
await library.load();
textDim = db.getEmbeddingDim() ?? 768;

after(async () => {
  globalThis.fetch = realFetch;
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(root);
});

const setTrackTags = (on: boolean) => settings.update({
  embedding: { enrichment: { lastfmTrackTags: on, lyrics: false, originalYear: false } },
});

// Each test owns the library and the fixture.
beforeEach(async () => {
  db.requireDb().exec('DELETE FROM tracks; DELETE FROM track_vectors;');
  trackReplies.clear();
  artistReplies.clear();
  failOnce.clear();
  asked.length = 0;
  embedded.length = 0;
  process.env.LASTFM_API_KEY = 'fixture-key';
  await setTrackTags(true);
});

function seed(id: string, artist: string, title: string, opts: { tags?: string[] | null; vector?: boolean } = {}) {
  db.upsertTrackMeta(id, { title, artist, album: 'LP', year: 2001, genres: ['rock'], duration: 200 });
  if (opts.tags !== undefined) db.upsertTrackEnrichment(id, { lastfmTags: opts.tags, lyricExcerpt: null });
  if (opts.vector) {
    const vec = Array.from({ length: textDim }, (_, i) => (i === 0 ? 1 : 0));
    db.upsertTrackVector(id, vec, db.resolvedEraYearForTrack(id));
  }
}
const row = (id: string) => db.getTrack(id)!;
const methods = () => asked.map(a => a.query.get('method'));
const trackAsks = () => asked.filter(a => a.query.get('method') === 'track.getTopTags').map(a => a.query.get('track'));
const artistAsks = () => asked.filter(a => a.query.get('method') === 'artist.getTopTags').map(a => a.query.get('artist'));

// ---- response shapes ----

test('getTrackTopTags asks with autocorrect, and tidies the list the way the artist call does', async () => {
  trackReplies.set('Slowdive|Alison', { body: { toptags: { tag: [
    { name: 'Shoegaze', count: 100 },
    { name: ' Dream Pop ', count: '57' },
    { name: 'never applied', count: 0 },
    { name: 'no count at all' },
    { name: 'slowdive', count: 40 },
    { name: 'ALISON', count: 30 },
    { name: '', count: 20 },
  ] } } });
  const got = await lastfm.getTrackTopTags('Slowdive', 'Alison');
  assert.deepEqual(got, { tags: ['shoegaze', 'dream pop', 'no count at all'], answered: true, rateLimited: false });
  assert.equal(asked.length, 1);
  assert.deepEqual(Object.fromEntries(asked[0].query), {
    method: 'track.getTopTags', artist: 'Slowdive', track: 'Alison',
    autocorrect: '1', api_key: 'fixture-key', format: 'json',
  });
});

test('the noise filter runs before the count, so an echo costs no real tag', async () => {
  trackReplies.set('A|B', tagReply('a', 'b', 'one', 'two'));
  assert.deepEqual((await lastfm.getTrackTopTags('A', 'B', { count: 2 })).tags, ['one', 'two']);
});

test('toptags.tag may be a single object rather than an array', async () => {
  trackReplies.set('A|B', { body: { toptags: { tag: { name: 'Shoegaze', count: 12 } } } });
  assert.deepEqual((await lastfm.getTrackTopTags('A', 'B')).tags, ['shoegaze']);
});

test('toptags with no tag on it is a real answer with nothing to say', async () => {
  trackReplies.set('A|B', { body: { toptags: { '#text': ' ', '@attr': { artist: 'A', track: 'B' } } } });
  assert.deepEqual(await lastfm.getTrackTopTags('A', 'B'), { tags: [], answered: true, rateLimited: false });
});

test('a not-found is a normal miss, under a 200 and under a 4xx', async () => {
  for (const status of [200, 400, 404]) {
    trackReplies.set('A|B', { status, body: { error: 6, message: 'Track not found' } });
    assert.deepEqual(await lastfm.getTrackTopTags('A', 'B'), { tags: [], answered: true, rateLimited: false });
  }
});

test('rate limiting is reported as such, by status and by error 29', async () => {
  for (const reply of [{ status: 429, raw: 'slow down' }, { body: { error: 29, message: 'Rate limit exceeded' } }]) {
    trackReplies.set('A|B', reply);
    assert.deepEqual(await lastfm.getTrackTopTags('A', 'B'), { tags: [], answered: false, rateLimited: true });
  }
});

test('nothing else counts as an answer', async () => {
  for (const reply of [
    { status: 500, raw: '<html>oops</html>' },
    { status: 503, body: { error: 11, message: 'Service offline' } },
    { body: { error: 8, message: 'Operation failed' } },
    { status: 403, body: { error: 10, message: 'Invalid API key' } },
    { raw: 'not json' },
    { body: {} },
    { drop: true },
  ] as Reply[]) {
    trackReplies.set('A|B', reply);
    assert.deepEqual(await lastfm.getTrackTopTags('A', 'B'), { tags: [], answered: false, rateLimited: false }, JSON.stringify(reply));
  }
});

test('no key, or nothing to ask about, sends nothing', async () => {
  assert.equal((await lastfm.getTrackTopTags('', 'B')).answered, false);
  assert.equal((await lastfm.getTrackTopTags('A', '  ')).answered, false);
  delete process.env.LASTFM_API_KEY;
  assert.equal((await lastfm.getTrackTopTags('A', 'B')).answered, false);
  assert.equal(asked.length, 0);
});

test('the artist call is unchanged: same request, same shapes, [] on any failure', async () => {
  artistReplies.set('A', tagReply('Rock', 'Indie'));
  assert.deepEqual(await lastfm.getArtistTopTags('A'), ['rock', 'indie']);
  assert.equal(asked[0].url, 'method=artist.getTopTags&artist=A&autocorrect=1&api_key=fixture-key&format=json');
  artistReplies.set('A', { body: { toptags: { tag: { name: 'Solo', count: 5 } } } });
  assert.deepEqual(await lastfm.getArtistTopTags('A'), ['solo']);
  artistReplies.set('A', { status: 500, raw: 'oops' });
  assert.deepEqual(await lastfm.getArtistTopTags('A'), []);
  artistReplies.set('A', { body: { error: 6 } });
  assert.deepEqual(await lastfm.getArtistTopTags('A'), []);
});

// ---- the gate ----

test('track tags need the setting, a key and Last.fm tags not forced off', () => {
  const enabled = lastfm.lastfmTrackTagsEnabled;
  assert.equal(enabled({ lastfmTags: null, lastfmTrackTags: true }, true), true);
  assert.equal(enabled({ lastfmTags: true, lastfmTrackTags: true }, true), true);
  assert.equal(enabled({ lastfmTags: true, lastfmTrackTags: true }, false), false, 'keyless stays on the Navidrome path');
  assert.equal(enabled({ lastfmTags: false, lastfmTrackTags: true }, true), false);
  assert.equal(enabled({ lastfmTags: null, lastfmTrackTags: false }, true), false);
  assert.equal(enabled({ lastfmTags: true }, true), false);
  assert.equal(enabled({ lastfmTrackTags: 'true' }, true), false, 'strictly opt-in');
});

// ---- off means off ----

test('off: a pass makes exactly the calls it always did and writes nothing new', async () => {
  await setTrackTags(false);
  seed('a', 'Same Artist', 'One');
  seed('b', 'Same Artist', 'Two');
  seed('c', 'Other', 'Three', { tags: ['old'], vector: true });
  trackReplies.set('Same Artist|One', tagReply('would-be-track-tag'));
  await phaseEnrich(['a', 'b'], false);

  assert.deepEqual(asked.map(a => a.url), [
    'method=artist.getTopTags&artist=Same+Artist&autocorrect=1&api_key=fixture-key&format=json',
  ]);
  assert.deepEqual(row('a').lastfmTags, ['rock', 'indie']);
  assert.deepEqual(row('b').lastfmTags, ['rock', 'indie']);
  assert.deepEqual(row('c').lastfmTags, ['old'], 'an already-tagged row is left alone');
  for (const id of ['a', 'b', 'c']) assert.equal(row(id).lastfmTrackTagsAt, null);
  assert.deepEqual(db.textVectorDirtyIds(), []);

  asked.length = 0;
  await phaseEnrich([], false);
  assert.equal(asked.length, 0, 'a fully-tagged library costs nothing');
});

// Real Last.fm answers a blank api_key with 400 + error 6, which reads as a miss:
// stamped, every row in the library would be done and never asked.
test('a key of only spaces counts as no key for track tags', async () => {
  const saved = process.env.LASTFM_API_KEY;
  process.env.LASTFM_API_KEY = '   ';
  try {
    assert.equal(lastfm.lastfmTrackTagsEnabled({ lastfmTrackTags: true }, lastfm.hasLastfmKey()), false);
    seed('a', 'Act', 'Song', { tags: ['kept'] });
    await phaseEnrich([], false);
    assert.equal(trackAsks().length, 0);
    assert.deepEqual(row('a').lastfmTags, ['kept']);
    assert.equal(row('a').lastfmTrackTagsAt, null);
  } finally {
    process.env.LASTFM_API_KEY = saved;
  }
});

test('on with no key: nothing reaches Last.fm and nothing is stamped', async () => {
  seed('a', 'A', 'One', { tags: ['old'] });
  delete process.env.LASTFM_API_KEY;
  await phaseEnrich(['a'], false);
  assert.equal(asked.length, 0);
  assert.equal(row('a').lastfmTrackTagsAt, null);
});

test('on, with Last.fm tags forced off: the opt-in cannot switch them back on', async () => {
  await settings.update({ embedding: { enrichment: { lastfmTags: false } } });
  try {
    seed('a', 'A', 'One');
    await phaseEnrich(['a'], false);
    assert.equal(asked.length, 0);
  } finally {
    const { setCache } = await import('../src/settings/store.js');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(root, 'settings.json'));
    setCache(null);
    await settings.load();
  }
});

// ---- the pass ----

test('a pass stores the merge, stamps hit and miss, and holds a failure back to retry', async () => {
  // Hit on a row with a vector: the tags change, so the vector is owed a refresh.
  seed('hit', 'Act', 'Hit', { tags: ['rock', 'indie'], vector: true });
  trackReplies.set('Act|Hit', tagReply('Shoegaze', 'act', 'hit', 'rock'));
  // Miss: the artist's list is what is already stored, so nothing changes.
  seed('miss', 'Act', 'Miss', { tags: ['rock', 'indie'], vector: true });
  trackReplies.set('Act|Miss', notFound);
  // Failure on a row that has a list and a vector.
  seed('down', 'Act', 'Down', { tags: ['rock', 'indie'], vector: true });
  trackReplies.set('Act|Down', { status: 503, raw: 'maintenance' });
  // A new track with no list at all, and no vector yet.
  seed('fresh', 'Act', 'Fresh');
  trackReplies.set('Act|Fresh', tagReply('slowcore'));
  // Never asked about: there is nothing to ask with.
  seed('nameless', '', 'Untitled');

  await phaseEnrich(['fresh'], false);

  assert.deepEqual(row('hit').lastfmTags, ['shoegaze', 'rock', 'indie']);
  assert.ok(row('hit').lastfmTrackTagsAt, 'hit stamped');
  assert.deepEqual(row('miss').lastfmTags, ['rock', 'indie']);
  assert.ok(row('miss').lastfmTrackTagsAt, 'miss stamped');
  assert.deepEqual(row('down').lastfmTags, ['rock', 'indie']);
  assert.equal(row('down').lastfmTrackTagsAt, null, 'a failure must not stamp');
  assert.deepEqual(row('fresh').lastfmTags, ['slowcore', 'rock', 'indie']);
  assert.ok(row('fresh').enrichedAt, 'the row still went through the metadata loop');
  assert.equal(row('nameless').lastfmTrackTagsAt, null);
  assert.ok(!trackAsks().includes('Untitled'));
  assert.deepEqual(db.textVectorDirtyIds(), ['hit'], 'only the row whose list changed');

  // Second pass, Last.fm recovered: only what was held back gets asked about.
  trackReplies.set('Act|Down', tagReply('slowcore'));
  asked.length = 0;
  await phaseEnrich([], false);
  assert.deepEqual(trackAsks(), ['Down']);
  assert.deepEqual(artistAsks(), ['Act'], 'the fill for that one row');
  assert.deepEqual(row('down').lastfmTags, ['slowcore', 'rock', 'indie']);
  assert.ok(row('down').lastfmTrackTagsAt);
  assert.deepEqual(db.textVectorDirtyIds().sort(), ['down', 'hit']);

  // Third: nothing left, so nothing is asked.
  asked.length = 0;
  await phaseEnrich([], false);
  assert.equal(asked.length, 0);
});

test('the track-tag rows are in the pass for an already-tagged library', async () => {
  seed('old', 'Act', 'Old', { tags: ['rock', 'indie'], vector: true });
  trackReplies.set('Act|Old', tagReply('shoegaze'));
  await phaseEnrich([], false);
  assert.deepEqual(row('old').lastfmTags, ['shoegaze', 'rock', 'indie']);
});

// The noise filter lives in the read and the limit in the merge, so only a real
// pass shows the two in the right order: an echo mustn't cost the song a tag.
test('a pass keeps five of the song\'s own tags after the noise filter, and all ten of the artist\'s', async () => {
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  seed('a', 'Act', 'Song', { tags: artist, vector: true });
  seed('b', 'Act', 'Other', { tags: artist });
  trackReplies.set('Act|Song', tagReply('act', 'song', 'own0', 'own1', 'own2', 'own3', 'own4', 'own5', 'own6'));
  trackReplies.set('Act|Other', tagReply('other', 'own0', 'own1', 'own2', 'own3', 'own4', 'own5', 'own6'));
  artistReplies.set('Act', tagReply(...artist));
  await phaseEnrich([], false);
  const list = ['own0', 'own1', 'own2', 'own3', 'own4', ...artist];
  assert.deepEqual(row('a').lastfmTags, list);
  assert.deepEqual(row('b').lastfmTags, list);
  assert.equal(row('a').lastfmTags?.length, 15);
  assert.ok(db.textVectorDirtyIds().includes('a'));
});

test('a failed fill holds the row back too: a stamp means the whole list is good', async () => {
  seed('a', 'Flaky', 'Song', { tags: ['rock', 'indie'], vector: true });
  trackReplies.set('Flaky|Song', tagReply('shoegaze'));
  artistReplies.set('Flaky', { status: 500, raw: 'oops' });
  await phaseEnrich([], false);
  assert.deepEqual(row('a').lastfmTags, ['rock', 'indie'], 'never trade a good list for a part of one');
  assert.equal(row('a').lastfmTrackTagsAt, null);
  assert.deepEqual(db.textVectorDirtyIds(), []);
});

test('a new track still gets whatever came back when its own lookup fails', async () => {
  seed('new', 'Act', 'New');
  trackReplies.set('Act|New', { status: 500, raw: 'oops' });
  await phaseEnrich(['new'], false);
  assert.deepEqual(row('new').lastfmTags, ['rock', 'indie'], 'as good as today, and still owed');
  assert.equal(row('new').lastfmTrackTagsAt, null);
});

// The stored list may come from Navidrome's getArtistInfo2, and Last.fm's error 6
// is "invalid parameters", not proof of anything about the act.
test('a genuine "nothing at all" stamps the row and costs it no list', async () => {
  seed('a', 'Gone', 'Song', { tags: ['from a custom navidrome'], vector: true });
  artistReplies.set('Gone', { body: { error: 6, message: 'The artist you supplied could not be found' } });
  await phaseEnrich([], false);
  assert.deepEqual(row('a').lastfmTags, ['from a custom navidrome']);
  assert.ok(row('a').lastfmTrackTagsAt);
  assert.deepEqual(db.textVectorDirtyIds(), []);
});

test('duplicates share a call: on the normalised artist and title, and for the artist', async () => {
  seed('one', 'The Act', 'Same Song', { tags: [] });
  seed('two', 'the  act', 'SAME   SONG', { tags: [] });
  seed('three', 'The Act', 'Another');
  trackReplies.set('The Act|Same Song', tagReply('shoegaze'));
  trackReplies.set('the  act|SAME   SONG', tagReply('shoegaze'));
  await phaseEnrich([], false);
  assert.equal(trackAsks().length, 2, 'two distinct songs');
  assert.equal(artistAsks().length, 1, 'one distinct artist');
  assert.deepEqual(row('one').lastfmTags, row('two').lastfmTags);
});

test('a failed call is not memoised: one blip must not cost an artist\'s other rows their stamp', async () => {
  const ids = ['one', 'two', 'three'];
  for (const id of ids) seed(id, 'Act', id);
  failOnce.add('Act');
  await backfillLastfmTrackTags(ids, 1, createLastfmPacer({ minGapMs: 1, failureBackoffMs: 1 }));
  assert.equal(artistAsks().length, 2, 'the blip, then one good call the other rows share');
  assert.equal(db.idsNeedingLastfmTrackTags().length, 1, 'only the row that hit the blip is still owed');
});

test('the pass stays at about 4 requests a second across its pool', async () => {
  for (let i = 0; i < 9; i++) {
    seed(`t${i}`, `Artist ${i}`, `Song ${i}`);
  }
  await phaseEnrich([], false);
  assert.equal(asked.length, 18);
  const gaps = asked.slice(1).map((a, i) => a.at - asked[i].at);
  // The fixture stamps arrival, so one gap can read a little under the paced one;
  // the total can't.
  assert.ok(Math.min(...gaps) > 200, `tightest gap ${Math.min(...gaps)} ms`);
  const perSecond = (asked.length - 1) / ((asked.at(-1)!.at - asked[0].at) / 1000);
  assert.ok(perSecond <= 4.2, `${perSecond.toFixed(2)} req/s`);
});

test('a dead Last.fm ends the pass early and leaves the whole library owed', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    seed(`t${i}`, `Artist ${i}`, `Song ${i}`, { tags: ['kept'], vector: true });
    trackReplies.set(`Artist ${i}|Song ${i}`, { status: 503, raw: 'down' });
    artistReplies.set(`Artist ${i}`, { status: 503, raw: 'down' });
    ids.push(`t${i}`);
  }
  const pacer = createLastfmPacer({ minGapMs: 1, failureBackoffMs: 1, rateLimitBackoffMs: 1, maxBackoffMs: 4 });
  await backfillLastfmTrackTags(ids, 4, pacer);
  assert.equal(pacer.gaveUp, true);
  assert.ok(asked.length < 40, `${asked.length} requests against a dead service`);
  assert.equal(db.idsNeedingLastfmTrackTags().length, 40, 'an outage marks nothing as done');
  for (const id of ids) assert.deepEqual(row(id).lastfmTags, ['kept']);
  assert.deepEqual(db.textVectorDirtyIds(), []);
});

test('a bad key is an outage, not a library of misses', async () => {
  seed('a', 'Act', 'Song', { tags: ['kept'] });
  trackReplies.set('Act|Song', { status: 403, body: { error: 10, message: 'Invalid API key' } });
  artistReplies.set('Act', { status: 403, body: { error: 10, message: 'Invalid API key' } });
  await phaseEnrich([], false);
  assert.equal(row('a').lastfmTrackTagsAt, null);
});

// A pass ends after six failures in a row, and a failed row stays owed for good.
// In a fixed order, rows that always fail would end every pass at the same place.
test('rows Last.fm always refuses cannot keep a pass from the rest of the library', async () => {
  const refused: string[] = [];
  for (let i = 0; i < 12; i++) {
    seed(`bad${i}`, 'Odd Act', `Refused ${i}`);
    trackReplies.set(`Odd Act|Refused ${i}`, { body: { error: 8, message: 'Operation failed' } });
    refused.push(`bad${i}`);
  }
  for (let i = 0; i < 40; i++) seed(`good${i}`, `Artist ${i}`, `Song ${i}`);
  // However the failures fall in one pass, a later one gets past them.
  for (let pass = 0; pass < 10 && db.idsNeedingLastfmTrackTags().length > refused.length; pass++) {
    const ids = selectTrackTagIds({ reEnrich: false, limit: Infinity, ids: [], owed: db.idsNeedingLastfmTrackTags() });
    await backfillLastfmTrackTags(ids, 4, createLastfmPacer({ minGapMs: 1, failureBackoffMs: 1, rateLimitBackoffMs: 1, maxBackoffMs: 4 }));
  }
  assert.deepEqual(db.idsNeedingLastfmTrackTags().sort(), refused.sort(), 'all the others answered, and a failure stamped nothing');
});

// ---- re-enrich ----

test('--re-enrich re-asks answered rows; unchanged tags stay clean, changed ones go dirty', async () => {
  seed('same', 'Act', 'Same', { vector: true, tags: ['rock', 'indie'] });
  seed('moved', 'Act', 'Moved', { vector: true, tags: ['rock', 'indie'] });
  trackReplies.set('Act|Same', tagReply('shoegaze'));
  trackReplies.set('Act|Moved', tagReply('shoegaze'));
  await phaseEnrich([], false);
  const firstStamp = row('same').lastfmTrackTagsAt;
  db.requireDb().exec('UPDATE tracks SET text_vector_dirty = 0');

  trackReplies.set('Act|Moved', tagReply('slowcore'));
  await new Promise(resolve => setTimeout(resolve, 5));
  asked.length = 0;
  await phaseEnrich(['same', 'moved'], true);

  assert.deepEqual(trackAsks().sort(), ['Moved', 'Same']);
  assert.deepEqual(row('same').lastfmTags, ['shoegaze', 'rock', 'indie']);
  assert.notEqual(row('same').lastfmTrackTagsAt, firstStamp, 're-asked and re-stamped');
  assert.deepEqual(row('moved').lastfmTags, ['slowcore', 'rock', 'indie']);
  assert.deepEqual(db.textVectorDirtyIds(), ['moved']);
});

test('--re-enrich during an outage keeps the merged list and its stamp', async () => {
  seed('a', 'Act', 'Song', { vector: true, tags: ['rock', 'indie'] });
  trackReplies.set('Act|Song', tagReply('shoegaze'));
  await phaseEnrich([], false);
  db.requireDb().exec('UPDATE tracks SET text_vector_dirty = 0');
  const stamp = row('a').lastfmTrackTagsAt;

  trackReplies.set('Act|Song', { status: 503, raw: 'down' });
  await phaseEnrich(['a'], true);
  assert.deepEqual(row('a').lastfmTags, ['shoegaze', 'rock', 'indie']);
  assert.equal(row('a').lastfmTrackTagsAt, stamp);
  assert.deepEqual(db.textVectorDirtyIds(), []);
});

test('the scope: --re-enrich stays inside what the caller resolved, a normal pass backfills', () => {
  const owed = ['o1', 'n1', 'o2'];
  const order = (ids: string[]) => ids;
  assert.deepEqual(selectTrackTagIds({ reEnrich: false, limit: Infinity, ids: [], owed, order }), owed);
  assert.deepEqual(
    selectTrackTagIds({ reEnrich: false, limit: Infinity, ids: ['n1', 'answered'], owed, order }),
    ['n1', 'o1', 'o2'],
    'this run\'s new tracks first, an answered one not at all',
  );
  assert.deepEqual(selectTrackTagIds({ reEnrich: false, limit: 1, ids: ['n1'], owed }), ['n1'], '--limit reaches it');
  assert.deepEqual(selectTrackTagIds({ reEnrich: true, limit: Infinity, ids: ['a', 'b'], owed, order }), ['a', 'b']);
  assert.deepEqual(selectTrackTagIds({ reEnrich: true, limit: 1, ids: ['a', 'b'], owed, order }), ['a']);
});

test('the order is new each pass, whichever scope is walked, and new tracks still go first', () => {
  const reversed = (ids: string[]) => [...ids].reverse();
  const owed = ['o1', 'n1', 'n2', 'o2'];
  assert.deepEqual(
    selectTrackTagIds({ reEnrich: false, limit: Infinity, ids: ['n1', 'n2'], owed, order: reversed }),
    ['n2', 'n1', 'o2', 'o1'],
  );
  assert.deepEqual(
    selectTrackTagIds({ reEnrich: true, limit: Infinity, ids: ['a', 'b'], owed, order: reversed }),
    ['b', 'a'],
  );
  const many = Array.from({ length: 200 }, (_, i) => `id${i}`);
  const picked = selectTrackTagIds({ reEnrich: false, limit: Infinity, ids: [], owed: many });
  assert.notDeepEqual(picked, many, 'the default order is not the stored one');
  assert.deepEqual([...picked].sort(), [...many].sort(), 'and it loses nothing');
});

test('--limit caps the pass, and the rest stays owed for the next one', async () => {
  for (let i = 0; i < 3; i++) seed(`t${i}`, 'Act', `Song ${i}`, { tags: ['rock'] });
  await phaseEnrich([], false, 1);
  assert.equal(trackAsks().length, 1);
  assert.equal(db.idsNeedingLastfmTrackTags().length, 2);
});

// ---- the stamp follows the list ----

test('turning it off and re-enriching puts artist tags back, and the row is owed again', async () => {
  seed('a', 'Act', 'Song', { tags: ['rock', 'indie'] });
  trackReplies.set('Act|Song', tagReply('shoegaze'));
  await phaseEnrich([], false);
  assert.ok(row('a').lastfmTrackTagsAt);

  await setTrackTags(false);
  await phaseEnrich(['a'], true);
  assert.deepEqual(row('a').lastfmTags, ['rock', 'indie']);
  assert.equal(row('a').lastfmTrackTagsAt, null, 'the stamp describes the list it stood for');

  await setTrackTags(true);
  await phaseEnrich([], false);
  assert.deepEqual(row('a').lastfmTags, ['shoegaze', 'rock', 'indie']);
});

test('rewriting the same list keeps the stamp', () => {
  seed('a', 'Act', 'Song', { tags: ['rock'] });
  db.recordLastfmTrackTags('a', { tags: ['rock'], answered: true });
  const stamp = row('a').lastfmTrackTagsAt;
  assert.ok(stamp);
  db.upsertTrackEnrichment('a', { lastfmTags: ['rock'], lyricExcerpt: 'la' });
  assert.equal(row('a').lastfmTrackTagsAt, stamp);
});

test('an unchanged answer does not even touch the list, so search keys stay fresh', () => {
  seed('a', 'Act', 'Song', { tags: ['rock'] });
  const d = db.requireDb();
  d.prepare('UPDATE tracks SET search_fresh = 1 WHERE id = ?').run('a');
  db.recordLastfmTrackTags('a', { tags: ['rock'], answered: true });
  const after = d.prepare('SELECT search_fresh FROM tracks WHERE id = ?').get('a') as { search_fresh: number | null };
  assert.equal(after.search_fresh, 1);
});

// ---- phase 1 and the migration ----

test('the embed pass picks a dirty row up, and a fresh vector clears it', async () => {
  seed('a', 'Act', 'Song', { tags: ['rock'], vector: true });
  trackReplies.set('Act|Song', tagReply('shoegaze'));
  await phaseEnrich([], false);
  assert.deepEqual(db.textVectorDirtyIds(), ['a']);
  db.upsertTrackVector('a', Array.from({ length: textDim }, (_, i) => (i === 1 ? 1 : 0)), db.resolvedEraYearForTrack('a'));
  assert.deepEqual(db.textVectorDirtyIds(), []);
});

test('a row with no vector is never marked', async () => {
  seed('a', 'Act', 'Song', { tags: ['rock'] });
  trackReplies.set('Act|Song', tagReply('shoegaze'));
  await phaseEnrich([], false);
  const dirty = db.requireDb().prepare('SELECT text_vector_dirty FROM tracks WHERE id = ?').get('a') as { text_vector_dirty: number };
  assert.equal(dirty.text_vector_dirty, 0);
});

test('a v31 database gains the column on its next open, with every row owed', async () => {
  seed('a', 'Act', 'Song', { tags: ['rock'] });
  const raw = db.requireDb();
  assert.equal(raw.pragma('user_version', { simple: true }), 32);
  raw.exec('ALTER TABLE tracks DROP COLUMN lastfm_track_tags_at');
  raw.pragma('user_version = 31');
  const dim = db.getEmbeddingDim()!;
  db.close();
  await db.open({ embeddingDim: dim, adoptStoredDim: true });
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), 32);
  assert.equal(row('a').lastfmTrackTagsAt, null);
  assert.deepEqual(row('a').lastfmTags, ['rock']);
  assert.deepEqual(db.idsNeedingLastfmTrackTags(), ['a']);
});

// ---- settings ----

test('the setting survives a cold load, and only a real boolean turns it on', async () => {
  const cold = async (enrichment?: object) =>
    (await coldLoadSettings({ embedding: { enrichment } })).embedding.enrichment.lastfmTrackTags;
  try {
    assert.equal(await cold({ lastfmTrackTags: true }), true);
    assert.equal(await cold({ lastfmTrackTags: false }), false);
    assert.equal(await cold({}), false, 'an upgrade changes nothing');
    assert.equal(await cold(undefined), false);
    assert.equal(await cold({ lastfmTrackTags: 'yes' }), false, 'malformed falls back to off');
  } finally {
    await coldLoadSettings({});
  }
});

test('the admin surface reads and writes it through settings.update', async () => {
  await settings.update({ embedding: { enrichment: { lastfmTrackTags: true } } });
  assert.equal(settings.get().embedding.enrichment.lastfmTrackTags, true);
  await settings.update({ embedding: { enrichment: { lyrics: false } } });
  assert.equal(settings.get().embedding.enrichment.lastfmTrackTags, true, 'a sibling patch leaves it alone');
  await settings.update({ embedding: { enrichment: { lastfmTrackTags: false } } });
  assert.equal(settings.get().embedding.enrichment.lastfmTrackTags, false);
});

// ---- the retag route ----

async function retag(id: string, artist: string, title: string) {
  const response = await realFetch(`${base}/library/retag`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('test:test').toString('base64')}` },
    body: JSON.stringify({ id, title, artist, genre: 'Rock', duration: 200 }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, await response.text());
}

async function retagReady() {
  await settings.update({
    llm: { provider: 'openai-compatible', model: 'fixture', compatibleMode: 'local', baseUrl: `${base}/v1` },
    embedding: {
      enabled: true, provider: 'openai-compatible', model: 'fixture',
      providerBaseUrls: { 'openai-compatible': `${base}/v1` },
    },
  });
}

test('retag and a bulk pass store the same list for the same song', async () => {
  await retagReady();
  trackReplies.set('Act|Song', tagReply('Shoegaze', 'act', 'rock'));
  artistReplies.set('Act', tagReply('rock', 'indie'));

  seed('bulk', 'Act', 'Song');
  await phaseEnrich(['bulk'], false);

  asked.length = 0;
  seed('single', 'Act', 'Song');
  await retag('single', 'Act', 'Song');

  assert.deepEqual(methods().sort(), ['artist.getTopTags', 'track.getTopTags']);
  assert.deepEqual(row('single').lastfmTags, ['shoegaze', 'rock', 'indie']);
  assert.deepEqual(row('single').lastfmTags, row('bulk').lastfmTags);
  assert.ok(row('single').lastfmTrackTagsAt, 'an answer from the route counts: a later pass need not ask');
  assert.match(embedded.at(-1)!, /Last\.fm: shoegaze, rock, indie/, 'and the vector is built from that list');
});

test('retag stores the same full list a pass would: five of its own, then all ten', async () => {
  await retagReady();
  const artist = Array.from({ length: 10 }, (_, i) => `a${i}`);
  trackReplies.set('Act|Song', tagReply('song', 'own0', 'own1', 'own2', 'own3', 'own4', 'own5'));
  artistReplies.set('Act', tagReply(...artist));
  seed('a', 'Act', 'Song');
  await retag('a', 'Act', 'Song');
  assert.deepEqual(row('a').lastfmTags, ['own0', 'own1', 'own2', 'own3', 'own4', ...artist]);
});

test('retag answers a row the pass then skips', async () => {
  await retagReady();
  trackReplies.set('Act|Song', tagReply('shoegaze'));
  seed('a', 'Act', 'Song', { tags: ['rock'] });
  await retag('a', 'Act', 'Song');
  asked.length = 0;
  await phaseEnrich([], false);
  assert.equal(asked.length, 0);
});

test('retag during a Last.fm failure keeps the list and stays owed', async () => {
  await retagReady();
  seed('a', 'Act', 'Song', { tags: ['rock', 'indie'] });
  trackReplies.set('Act|Song', { status: 503, raw: 'down' });
  await retag('a', 'Act', 'Song');
  assert.deepEqual(row('a').lastfmTags, ['rock', 'indie']);
  assert.equal(row('a').lastfmTrackTagsAt, null);
  assert.match(embedded.at(-1)!, /Last\.fm: rock, indie/);
});

test('retag with the setting off is one artist call and no stamp, as it always was', async () => {
  await retagReady();
  await setTrackTags(false);
  trackReplies.set('Act|Song', tagReply('shoegaze'));
  seed('a', 'Act', 'Song');
  await retag('a', 'Act', 'Song');
  assert.deepEqual(methods(), ['artist.getTopTags']);
  assert.deepEqual(row('a').lastfmTags, ['rock', 'indie']);
  assert.equal(row('a').lastfmTrackTagsAt, null);
});
