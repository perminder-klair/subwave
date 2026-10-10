// Picker discovery tools: a real deadline, bounded Navidrome work, and no bare [].
//
// In ai@7 the agent's per-tool timeout reaches a tool only as
// `options.abortSignal` — the SDK awaits execute() and never races it — so a
// tool that ignored the signal could hold a step for most of the 45s pick
// budget. These tests drive the tools the way the SDK does (execute with an
// abortSignal) against one loopback server standing in for Navidrome, the
// analyzer sidecar and an OpenAI-compatible embedding endpoint.
//
// Run: npm test -- picker-tool-bounds

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';

const root = await mkdtemp(join(tmpdir(), 'subwave-picker-tool-bounds-'));

interface Call { path: string; query: string; songCount: number; songOffset: number; artistCount: number }
const calls: Call[] = [];
let embedTextCalls = 0;
let embeddingCalls = 0;
let embeddingDim = 0;
const pending = new Set<ServerResponse>();

const song = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, artist: `Artist ${id}`, duration: 200, ...extra });
const ok = (res: ServerResponse, body: Record<string, unknown>) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', ...body } }));
};

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, engines: ['analyze'], analyze_text_capable: true }));
    return;
  }
  if (url.pathname === '/embed-text') {
    embedTextCalls++;
    pending.add(res); // never answered: a worker busy with a bulk pass
    return;
  }
  if (url.pathname === '/v1/embeddings') {
    embeddingCalls++;
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const input = JSON.parse(raw).input as string[];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        object: 'list', model: 'fake',
        data: input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: embeddingDim }, (_, i) => (i === 0 ? 1 : 0)) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
    return;
  }
  const q = url.searchParams.get('query') || '';
  const call: Call = {
    path: url.pathname, query: q,
    songCount: Number(url.searchParams.get('songCount') || 0),
    songOffset: Number(url.searchParams.get('songOffset') || 0),
    artistCount: Number(url.searchParams.get('artistCount') || 0),
  };
  if (url.pathname.endsWith('/search3')) {
    calls.push(call);
    if (q === 'slow search') { pending.add(res); return; }
    if (call.songCount === 0) return ok(res, { searchResult3: { artist: [] } });
    if (q === 'broad term') {
      // A FULL raw page at any offset, one row of which is a station archive
      // mixdown the search filters out.
      const rows = Array.from({ length: 25 }, (_, i) => song(`b${call.songOffset + i}`));
      rows[3] = song('archive-row', { path: 'archive/2026-01-01/10-00.mp3' });
      return ok(res, { searchResult3: { song: rows } });
    }
    if (q === 'narrow term') {
      return ok(res, { searchResult3: { song: call.songOffset > 0 ? [song('tail')] : [song('n1'), song('n2')] } });
    }
    if (q === 'Played Song') return ok(res, { searchResult3: { song: [song('played')] } });
    return ok(res, { searchResult3: { song: [] } });
  }
  if (url.pathname.endsWith('/getAlbumList2')) return ok(res, { albumList2: { album: [{ id: 'al1' }, { id: 'al2' }] } });
  if (url.pathname.endsWith('/getAlbum')) { res.statusCode = 500; res.end('boom'); return; }
  if (url.pathname.endsWith('/getRandomSongs')) return ok(res, { randomSongs: { song: [song('played')] } });
  return ok(res, {});
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;

process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = base;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
process.env.ANALYZE_URL = base;

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const subsonic = await import('../src/music/subsonic.js');
const analyzer = await import('../src/music/analyzer.js');
const { buildPickerTools } = await import('../src/llm/internal/tools/picker/index.js');
const { withToolDeadline, toolDeadlineResult } = await import('../src/llm/internal/tools/picker/defs.js');
await settings.load();
await settings.update({ embedding: { enabled: true, provider: 'openai-compatible', model: 'fake-embed', providerBaseUrls: { 'openai-compatible': `${base}/v1` } } } as never);
await library.load();
embeddingDim = db.getEmbeddingDim() ?? 0;

after(async () => {
  for (const res of pending) res.destroy();
  db.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const opts = (abortSignal?: AbortSignal) => ({ toolCallId: 't', messages: [], ...(abortSignal ? { abortSignal } : {}) });
const exec = (t: any, input: unknown, abortSignal?: AbortSignal) => t.execute(input, opts(abortSignal));
const songSearches = () => calls.filter((c) => c.path.endsWith('/search3') && c.songCount > 0);
const artistSearches = () => calls.filter((c) => c.path.endsWith('/search3') && c.songCount === 0);

test('withToolDeadline answers when the signal fires, even if execute never settles', async () => {
  const hung = withToolDeadline('hungTool', { execute: () => new Promise(() => {}) } as any) as any;
  const started = Date.now();
  const out = await hung.execute({}, opts(AbortSignal.timeout(50)));
  assert.deepEqual(out, toolDeadlineResult('hungTool'));
  assert.ok(Date.now() - started < 2000, 'the deadline, not the hung call, decides when the step ends');

  const plain = withToolDeadline('plainTool', { execute: async () => ['x'] } as any) as any;
  assert.deepEqual(await plain.execute({}, opts()), ['x'], 'no signal: execute runs untouched');
  assert.deepEqual(await plain.execute({}, opts(new AbortController().signal)), ['x'], 'a live signal does not change the result');
  await assert.rejects(
    (withToolDeadline('throwing', { execute: async () => { throw new Error('own failure'); } } as any) as any)
      .execute({}, opts(new AbortController().signal)),
    /own failure/,
    'a tool\'s own throw still reaches the SDK',
  );
});

test('every registered picker tool carries the deadline', async () => {
  const { tools } = buildPickerTools();
  assert.ok(Object.keys(tools).length > 5);
  const aborted = AbortSignal.abort();
  for (const [name, t] of Object.entries(tools)) {
    assert.deepEqual(await exec(t, {}, aborted), toolDeadlineResult(name), `${name} must answer an expired deadline at once`);
  }
});

test('searchLibrary judges a full deep page by its RAW size, not what survived the filters', async (t) => {
  t.mock.method(Math, 'random', () => 0.5); // offset 25
  calls.length = 0;
  const { tools } = buildPickerTools();
  const out = await exec(tools.searchLibrary, { query: 'broad term' });
  assert.ok(Array.isArray(out) && out.length > 0);
  assert.deepEqual(songSearches().map((c) => c.songOffset), [25], 'a filtered row on a full page must not pin page 0 again');

  calls.length = 0;
  await exec(buildPickerTools().tools.searchLibrary, { query: 'narrow term' });
  assert.deepEqual(songSearches().map((c) => c.songOffset), [25, 0], 'a genuinely short page still falls back to the head');
});

test('searchLibrary caps the query and only tries the per-word artist retry on a name-shaped query', async () => {
  const { tools } = buildPickerTools();
  const schema = (tools.searchLibrary as any).inputSchema;
  const parse = (v: unknown) => (typeof schema.parse === 'function' ? schema.parse(v) : schema.jsonSchema);
  assert.throws(() => parse({ query: 'x'.repeat(201) }));

  calls.length = 0;
  const sentence = 'please play absolutely anything with lots of words in it right now thanks';
  const out = await exec(tools.searchLibrary, { query: sentence });
  assert.equal(artistSearches().length, 0, 'a sentence is not searched word by word');
  assert.ok(!Array.isArray(out) && typeof out.rule === 'string', 'an empty answer carries the no-invented-id rule');

  calls.length = 0;
  await exec(buildPickerTools().tools.searchLibrary, { query: 'Sikandar Kahlon' });
  assert.equal(artistSearches().length, 3, 'a name still gets its exact search plus one per word');
});

test('resolveArtist searches each distinct word once, capped', async () => {
  calls.length = 0;
  await subsonic.resolveArtist('aa bb aa cc dd ee ff gg hh aa');
  const perWord = artistSearches().slice(1).map((c) => c.query);
  assert.equal(new Set(perWord).size, perWord.length, 'no word is searched twice');
  assert.ok(perWord.length <= 6, `per-word searches are capped (got ${perWord.length})`);

  calls.length = 0;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(subsonic.resolveArtist('aa bb cc', { signal: ac.signal }), /cancelled/);
  assert.equal(artistSearches().length, 0, 'an expired deadline sends nothing');
});

test('an aborted searchLibrary stops at the in-flight call instead of finishing in the background', async () => {
  calls.length = 0;
  const { tools } = buildPickerTools();
  const started = Date.now();
  const out = await exec(tools.searchLibrary, { query: 'slow search' }, AbortSignal.timeout(80));
  assert.deepEqual(out, toolDeadlineResult('searchLibrary'));
  assert.ok(Date.now() - started < 2000);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.length, 1, 'no further Navidrome calls after the deadline');
});

test('analyzer.embedTexts (searchBySound\'s embed) gives up with its signal and never retries', async () => {
  analyzer._resetBackendCacheForTests();
  embedTextCalls = 0;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);
  const started = Date.now();
  const vecs = await analyzer.embedTexts(['dusty jazz'], { timeoutMs: 8_000, coldRetry: false, signal: ac.signal });
  assert.equal(vecs, null);
  assert.ok(Date.now() - started < 2000, 'the caller\'s signal ends the wait');
  assert.equal(embedTextCalls, 1, 'an abort is never retried');
});

test('searchLibrary: a named track filtered out keeps saying so when the vibe index answers', async () => {
  assert.ok(embeddingDim > 0);
  db.upsertTrackMeta('vibe1', { title: 'Lookalike', artist: 'Someone', duration: 200 });
  db.upsertTrackVector('vibe1', Array.from({ length: embeddingDim }, (_, i) => (i === 0 ? 1 : 0)), null);
  const ctxScope = { hardRecentIds: new Set(['played']) };

  embeddingCalls = 0;
  const filtered = await exec(buildPickerTools(ctxScope).tools.searchLibrary, { query: 'Played Song' });
  assert.equal(embeddingCalls, 1, 'the vibe index is still consulted');
  assert.ok(!Array.isArray(filtered), 'vibe neighbours of a filtered literal match are labelled, not passed off as the match');
  assert.deepEqual(filtered.tracks.map((s: any) => s.id), ['vibe1']);
  assert.match(filtered.note, /1 matching track\(s\) exist but were all played recently/);
  assert.match(filtered.note, /not literal matches for what was searched/);

  const vibe = await exec(buildPickerTools(ctxScope).tools.searchLibrary, { query: 'nothing literal matches' });
  assert.ok(Array.isArray(vibe), 'a pure vibe query still returns plain tracks');
  assert.deepEqual(vibe.map((s: any) => s.id), ['vibe1']);
});

test('empty discovery answers carry a note and the rule, never a bare []', async () => {
  const scope = { hardRecentIds: new Set(['played']) };
  const random = await exec(buildPickerTools(scope).tools.randomSongs, {});
  assert.ok(!Array.isArray(random) && typeof random.rule === 'string' && /played recently/.test(random.note));

  const recent = await exec(buildPickerTools(scope).tools.recentlyAdded, {});
  assert.ok(!Array.isArray(recent) && typeof recent.error === 'string', 'every album fetch failing is reported as an error');

  const starred = await exec(buildPickerTools(scope).tools.starredSongs, {});
  assert.ok(!Array.isArray(starred) && typeof starred.rule === 'string');
});

test('a mood named after an Object.prototype member matches nothing instead of throwing', async () => {
  for (const mood of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(library.songsByMood(mood), [], mood);
    const out = await exec(buildPickerTools().tools.tracksByMood, { mood, energy: null });
    assert.equal(out.error, undefined, `${mood} must not surface as a tool error`);
    assert.ok(Array.isArray(out.tracks) && typeof out.rule === 'string');
  }
});
