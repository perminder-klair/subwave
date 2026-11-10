// The admin Retag route (`POST /library/retag`) and an answer with no usable
// mood (#2283). The route used to save it the old way: `moods='[]'` with a
// source, prompt stamp, model and `tagged_at`, clearing the untaggable marker and
// answering with a `taggedAt` as if the track were tagged, so the next bulk run
// asked again. It now stores every answer through the bulk path's own writer
// (`tag-library/tag-input.ts` `recordTagAnswer`), with the bulk path's input.
//
// Pinned here, over real HTTP against a fake OpenAI-compatible LLM:
//   - an empty or off-vocabulary answer leaves the row untagged in
//     clearTrackTags' shape, marked under the key a bulk run checks, and the
//     route says `untaggable: true`;
//   - a previously tagged track that comes back empty ends up untagged too;
//   - Retag always asks, whatever the memory says, and a real answer tags the
//     track and drops the marker.
//
// Run: npm test -- retag-untaggable

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, beforeEach } from 'node:test';
import express from 'express';
import { chatCompletion } from './test-utils/llm.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-retag-untaggable-'));

// What the fake LLM answers for the one track in each batch.
let answer: { moods: string[]; energy: string } = { moods: [], energy: 'medium' };
const prompts: string[] = [];

const app = express();
app.use(express.json());
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/library/')) return app(req, res);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/v1/chat/completions') {
    prompts.push(JSON.stringify(body.messages ?? []));
    return res.end(JSON.stringify(chatCompletion({
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'tag', type: 'function', function: {
        name: body.tool_choice?.function?.name ?? body.tools?.[0]?.function?.name ?? 'emit',
        arguments: JSON.stringify({ results: [answer] }),
      } }] },
    })));
  }
  res.end(JSON.stringify({ 'subsonic-response': { status: 'ok' } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;

process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = base;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';
delete process.env.LASTFM_API_KEY;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const settings = await import('../src/settings.js');
const { promptVocabHash } = await import('../src/music/embeddings.js');
const { TAGGER_CONTRACT_VERSION } = await import('../src/music/tagger-core.js');
const { activeModelLabel } = await import('../src/llm/provider.js');
const { rememberedUntaggable } = await import('../src/music/tag-library/tag-input.js');
const { router: maintenanceRoutes } = await import('../src/routes/library/maintenance.js');
app.use(maintenanceRoutes);
await settings.load();
await library.load();
await settings.update({
  llm: { provider: 'openai-compatible', model: 'fixture', compatibleMode: 'local', baseUrl: `${base}/v1` },
  embedding: { enabled: false, enrichment: { lastfmTags: false, lyrics: false, originalYear: false } },
});

after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(root);
});

beforeEach(() => {
  db.requireDb().exec('DELETE FROM tracks;');
  prompts.length = 0;
  answer = { moods: [], energy: 'medium' };
});

async function retag(id: string, title: string, artist: string) {
  const response = await fetch(`${base}/library/retag`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('test:test').toString('base64')}` },
    body: JSON.stringify({ id, title, artist, album: 'Follow the Leader', genre: 'Nu Metal' }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

const stored = (id: string) => db.requireDb()
  .prepare('SELECT moods, energy, source, prompt_hash, model, tagged_at, untaggable_key FROM tracks WHERE id = ?')
  .get(id) as Record<string, string | null>;
// What the next bulk run would skip: the key it re-derives, under the run's label.
const remembered = () => rememberedUntaggable(promptVocabHash(TAGGER_CONTRACT_VERSION), [activeModelLabel()]);

function assertUntaggedAndMarked(id: string) {
  const row = stored(id);
  for (const col of ['moods', 'energy', 'source', 'prompt_hash', 'model', 'tagged_at']) {
    assert.equal(row[col], null, `${col} is NULL, as clearTrackTags leaves it`);
  }
  assert.match(row.untaggable_key ?? '', /^[0-9a-f]{64}$/);
  assert.ok(db.untaggedIds().includes(id), 'the library still counts it untagged');
  assert.ok(remembered().has(id), 'a bulk run would not ask it again');
}

test('an empty answer leaves the track untagged and marked, and the route says so', async () => {
  const body = await retag('silence', '[silence]', '[no artist]');
  assert.deepEqual(body, { id: 'silence', moods: [], energy: null, untaggable: true });
  assert.equal(prompts.length, 1);
  assertUntaggedAndMarked('silence');
});

test('an off-vocabulary answer is untaggable too', async () => {
  answer = { moods: ['not-a-mood-xyz'], energy: 'high' };
  const body = await retag('odd', 'Odd One', 'Korn');
  assert.equal(body.untaggable, true);
  assert.equal(body.taggedAt, undefined);
  assertUntaggedAndMarked('odd');
});

test('a tagged track that comes back empty ends up untagged, not as a [] tag', async () => {
  const mood = settings.moodVocab()[0];
  db.upsertTrackMeta('was-tagged', { title: '[silence]', artist: '[no artist]', album: 'Follow the Leader', genres: ['Nu Metal'] });
  db.upsertTrackTags('was-tagged', { moods: [mood], energy: 'low', source: 'propagated', confidence: 0.7 });
  const body = await retag('was-tagged', '[silence]', '[no artist]');
  assert.equal(body.untaggable, true);
  assertUntaggedAndMarked('was-tagged');
});

test('Retag always asks, and a real answer tags the track and drops the marker', async () => {
  await retag('song', 'Freak on a Leash', 'Korn');
  assert.ok(remembered().has('song'));

  const mood = settings.moodVocab()[0];
  answer = { moods: [mood], energy: 'high' };
  const body = await retag('song', 'Freak on a Leash', 'Korn');
  assert.equal(prompts.length, 2, 'the operator press is not gated by the memory');
  assert.deepEqual(body.moods, [mood]);
  assert.equal(body.energy, 'high');
  assert.ok(body.taggedAt);
  assert.equal(body.untaggable, undefined);

  const row = stored('song');
  assert.equal(row.untaggable_key, null);
  assert.equal(row.source, 'llm');
  assert.equal(row.model, activeModelLabel());
  assert.equal(row.prompt_hash, promptVocabHash(TAGGER_CONTRACT_VERSION));
  assert.ok(!db.untaggedIds().includes('song'));
  assert.ok(!remembered().has('song'));
});
