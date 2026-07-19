// Unit tests for the cloud TTS voice-list normalizer
// (llm/internal/speech/voice-catalog.ts). `/v1/audio/voices` isn't in the
// OpenAI spec, so every self-hosted TTS server returns a different shape —
// these pins cover the four seen in the wild (bare array, {voices}, {data},
// ElevenLabs objects) plus the junk-in-empty-out contract that keeps a
// malformed response from ever reaching the admin UI.
// Run: `npm test -- voice-catalog` (tsx scripts/voice-catalog.test.ts).

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listVoices, normalizeVoiceList } from '../src/llm/internal/speech/voice-catalog.js';

// Spin a throwaway HTTP server that answers only the paths in `routes`, so the
// probe order and fallback behaviour can be pinned without a real TTS server.
// Records every path it was asked for.
async function withServer(
  routes: Record<string, unknown>,
  fn: (baseUrl: string, seen: string[], authSeen: (string | undefined)[]) => Promise<void>,
) {
  const seen: string[] = [];
  const authSeen: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(req.url || '');
    authSeen.push(req.headers.authorization);
    const body = routes[req.url || ''];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`, seen, authSeen);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  }
}

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('payload shapes:');
  await test('bare array of ids (generic compat server)', () => {
    assert.deepEqual(normalizeVoiceList(['alloy', 'nova']), [
      { id: 'alloy', label: 'Alloy' },
      { id: 'nova', label: 'Nova' },
    ]);
  });
  await test('{voices: [...]} of ids (Kokoro-FastAPI, openedai-speech)', () => {
    assert.deepEqual(normalizeVoiceList({ voices: ['af_alloy', 'bm_george'] }), [
      { id: 'af_alloy', label: 'Af Alloy' },
      { id: 'bm_george', label: 'Bm George' },
    ]);
  });
  await test('{data: [{id}]} (servers mimicking /v1/models)', () => {
    assert.deepEqual(normalizeVoiceList({ data: [{ id: 'speaker-1' }, { id: 'speaker-2' }] }), [
      { id: 'speaker-1', label: 'Speaker 1' },
      { id: 'speaker-2', label: 'Speaker 2' },
    ]);
  });
  await test('ElevenLabs objects: voice_id -> id, name -> label, category -> hint', () => {
    assert.deepEqual(
      normalizeVoiceList({
        voices: [
          { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade' },
          { voice_id: 'zzz111', name: 'My Clone', category: 'cloned' },
        ],
      }),
      [
        { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', hint: 'premade' },
        { id: 'zzz111', label: 'My Clone', hint: 'cloned' },
      ],
    );
  });
  await test('objects with only a name use it as both id and label', () => {
    assert.deepEqual(normalizeVoiceList([{ name: 'Giovanni' }]), [{ id: 'Giovanni', label: 'Giovanni' }]);
  });

  console.log('labelling:');
  await test('opaque ids are left alone, not title-cased into noise', () => {
    assert.deepEqual(normalizeVoiceList(['21m00Tcm4TlvDq8ikWAM']), [
      { id: '21m00Tcm4TlvDq8ikWAM', label: '21m00Tcm4TlvDq8ikWAM' },
    ]);
  });
  await test('an explicit label always beats the derived one', () => {
    assert.deepEqual(normalizeVoiceList([{ id: 'af_alloy', label: 'Alloy (US female)' }]), [
      { id: 'af_alloy', label: 'Alloy (US female)' },
    ]);
  });

  console.log('junk in, empty out:');
  await test('null / undefined / scalar / object payloads yield []', () => {
    for (const junk of [null, undefined, 42, 'nope', {}, { voices: 'nope' }]) {
      assert.deepEqual(normalizeVoiceList(junk), [], `payload ${JSON.stringify(junk)} must yield []`);
    }
  });
  await test('entries with no usable id are dropped, survivors kept', () => {
    assert.deepEqual(normalizeVoiceList([{}, '', '   ', { id: '' }, 'alloy']), [
      { id: 'alloy', label: 'Alloy' },
    ]);
  });

  console.log('guardrails:');
  await test('duplicate ids are deduped, first wins', () => {
    assert.deepEqual(normalizeVoiceList([{ id: 'a', name: 'First' }, { id: 'a', name: 'Second' }]), [
      { id: 'a', label: 'First' },
    ]);
  });
  await test('ids over 100 chars are dropped (normalizeTts would truncate them)', () => {
    const atLimit = 'x'.repeat(100);
    const tooLong = 'x'.repeat(101);
    const kept = normalizeVoiceList([tooLong, atLimit]);
    assert.equal(kept.length, 1, 'the 101-char id must be dropped');
    assert.equal(kept[0].id, atLimit);
  });
  await test('list is capped at 500 entries', () => {
    const huge = Array.from({ length: 600 }, (_, i) => `voice${i}`);
    assert.equal(normalizeVoiceList(huge).length, 500);
  });
  await test('hints are truncated to 80 chars', () => {
    const [v] = normalizeVoiceList([{ id: 'a', description: 'd'.repeat(200) }]);
    assert.equal(v.hint?.length, 80);
  });

  console.log('compat probing:');
  await test('finds /audio/voices on the first try, probes nothing else', async () => {
    await withServer({ '/v1/audio/voices': { voices: ['alloy'] } }, async (baseUrl, seen) => {
      const r = await listVoices({ provider: 'openai-compatible', baseUrl });
      assert.equal(r.ok, true);
      assert.deepEqual(r.voices, [{ id: 'alloy', label: 'Alloy' }]);
      assert.deepEqual(seen, ['/v1/audio/voices'], 'must stop at the first hit');
    });
  });
  await test('falls through 404s to a later path', async () => {
    await withServer({ '/v1/audio/speech/voices': ['nova'] }, async (baseUrl, seen) => {
      const r = await listVoices({ provider: 'openai-compatible', baseUrl });
      assert.equal(r.ok, true);
      assert.deepEqual(r.voices, [{ id: 'nova', label: 'Nova' }]);
      assert.deepEqual(seen, ['/v1/audio/voices', '/v1/voices', '/v1/audio/speech/voices']);
    });
  });
  await test('a 200 with no voices keeps probing rather than declaring success', async () => {
    await withServer({ '/v1/audio/voices': { voices: [] }, '/v1/voices': ['echo'] }, async (baseUrl, seen) => {
      const r = await listVoices({ provider: 'openai-compatible', baseUrl });
      assert.equal(r.ok, true);
      assert.deepEqual(r.voices, [{ id: 'echo', label: 'Echo' }]);
      assert.deepEqual(seen, ['/v1/audio/voices', '/v1/voices']);
    });
  });
  await test('all paths 404 -> ok:false, empty list, no throw', async () => {
    await withServer({}, async (baseUrl, seen) => {
      const r = await listVoices({ provider: 'openai-compatible', baseUrl });
      assert.equal(r.ok, false);
      assert.deepEqual(r.voices, []);
      assert.ok(r.error, 'an error message must be reported');
      assert.equal(seen.length, 3, 'all three paths tried');
    });
  });
  await test('a configured key rides along as a Bearer header', async () => {
    await withServer({ '/v1/audio/voices': ['alloy'] }, async (baseUrl, _seen, authSeen) => {
      await listVoices({ provider: 'openai-compatible', baseUrl, apiKey: 'sk-test' });
      assert.deepEqual(authSeen, ['Bearer sk-test']);
    });
  });
  await test('no key configured means no Authorization header at all', async () => {
    await withServer({ '/v1/audio/voices': ['alloy'] }, async (baseUrl, _seen, authSeen) => {
      await listVoices({ provider: 'openai-compatible', baseUrl });
      assert.deepEqual(authSeen, [undefined]);
    });
  });

  console.log('guard rails on the fetch path:');
  await test('missing baseUrl is refused before any request', async () => {
    const r = await listVoices({ provider: 'openai-compatible', baseUrl: '' });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /baseUrl is required/);
  });
  await test('a non-HTTP scheme is refused (hand-edited settings.json)', async () => {
    const r = await listVoices({ provider: 'openai-compatible', baseUrl: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /http/);
  });
  await test('elevenlabs without a key never hits the network', async () => {
    const r = await listVoices({ provider: 'elevenlabs' });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /key/i);
  });
  await test('openai reports that it has nothing to discover', async () => {
    const r = await listVoices({ provider: 'openai', apiKey: 'sk-test' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.voices, []);
  });

  process.exit(failures ? 1 : 0);
}

main();
