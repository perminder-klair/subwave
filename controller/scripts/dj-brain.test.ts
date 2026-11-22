// controller/src/llm/dj-brain.ts: what a DJ Brain key includes, read from the
// brain's own /models list. The voice is wired only when the list names
// `dj-brain-voice`; a brain-only key must never get a cloud voice that 429s on
// every line. No external host: the fetch is a stub.

import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDjBrain, djBrainVoiceIncluded, modelIdsFrom } from '../src/llm/dj-brain.js';

type Fetch = NonNullable<Parameters<typeof checkDjBrain>[2]>;

function stub(status: number, body: unknown, seen?: { url?: string; auth?: string }): Fetch {
  return (async (input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
    if (seen) {
      seen.url = String(input);
      seen.auth = init?.headers?.authorization;
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as Fetch;
}

const list = (...ids: string[]) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

test('a Studio key (voice listed) reports the voice', async () => {
  const seen: { url?: string; auth?: string } = {};
  const r = await checkDjBrain('https://brain.test/v1/', ' k1 ', stub(200, list('dj-brain', 'dj-brain-voice', 'dj-brain-embed'), seen));
  assert.equal(r.ok, true);
  assert.equal(r.voice, true);
  assert.equal(seen.url, 'https://brain.test/v1/models');
  assert.equal(seen.auth, 'Bearer k1');
});

test('a Brain key (no voice listed) is ok without the voice', async () => {
  const r = await checkDjBrain('https://brain.test/v1', 'k', stub(200, list('dj-brain', 'dj-brain-embed')));
  assert.deepEqual([r.ok, r.voice], [true, false]);
});

test('a refused key, an error status or a non-brain server fails with no voice', async () => {
  for (const [status, body] of [[401, {}], [500, {}], [200, list('qwen3')], [200, 'nonsense']] as const) {
    const r = await checkDjBrain('https://brain.test/v1', 'k', stub(status, body));
    assert.deepEqual([r.ok, r.voice], [false, false], `${status} ${JSON.stringify(body)}`);
  }
});

test('a blank key fails before any request', async () => {
  let called = false;
  const r = await checkDjBrain('https://brain.test/v1', '  ', (async () => { called = true; return new Response('{}'); }) as unknown as Fetch);
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('a network failure never throws', async () => {
  const r = await checkDjBrain('https://brain.test/v1', 'k', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as Fetch);
  assert.deepEqual([r.ok, r.voice, r.message], [false, false, 'ECONNREFUSED']);
});

test('pure helpers', () => {
  assert.deepEqual(modelIdsFrom({ data: [{ id: 'a' }, { id: 3 }, null] }), ['a']);
  assert.deepEqual(modelIdsFrom(null), []);
  assert.equal(djBrainVoiceIncluded(['dj-brain']), false);
});
