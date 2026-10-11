// Every consumer that treats a Navidrome star as OPERATOR curation filters it
// through likes.operatorStarred, and none of them lets that filter empty a
// never-starve pool.
//
// A listener like is mirrored to a Navidrome star, so getStarred() alone cannot
// tell the operator's hand from one anonymous tap. With likes.influenceDj off,
// a star whose only likes are listener likes must not earn the "hand-curated"
// weight in the auto.m3u coast, the pool picker's fallback, the tagger's seed
// layer or the playlist generator's filler. It is still music, so the coast and
// the pool picker — both never-starve scopes — take it back as the last filler
// when nothing else came back.
//
// Run: npm test -- operator-starred-consumers

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-operator-starred-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://starred-library.invalid';
process.env.LIQUIDSOAP_HOST = 'starred-mixer.invalid';

const track = (id: string) => ({ id, title: `Title ${id}`, artist: `Artist ${id}`, duration: 200 });
// op-1 carries an operator heart, anon-1 only a listener like, hand-1 was
// starred in Navidrome by hand and has no like record at all.
const STARRED = [track('op-1'), track('anon-1'), track('hand-1')];
writeFileSync(join(root, 'likes.json'), JSON.stringify({
  secret: 'test-secret',
  likes: [
    { songId: 'anon-1', track: { id: 'anon-1', title: 'Title anon-1' }, airingKey: 'anon-1|2026-01-01T00:00:00.000Z', listenerKey: 'k1', likedAt: '2026-01-01T00:00:00.000Z' },
    { songId: 'op-1', track: { id: 'op-1', title: 'Title op-1' }, airingKey: 'op-1|operator', listenerKey: 'operator', likedAt: '2026-01-01T00:00:00.000Z', via: 'operator' },
  ],
}));

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { config } = await import('../src/config.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { queue } = await import('../src/broadcast/queue.js');
const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');
const { selectSeeds } = await import('../src/music/seed-selector.js');
const { buildCandidatePool } = await import('../src/music/playlist-gen.js');

let starred = STARRED;
let others: ReturnType<typeof track>[] = [];
let offered: string[][] = [];
const realFetch = globalThis.fetch;

before(async () => {
  await settings.load();
  await settings.update({
    likes: { enabled: true, influenceDj: false },
    embedding: { enabled: false },
    llm: { provider: 'openai-compatible', model: 'starred-test', baseUrl: 'http://starred-model.invalid/v1',
      apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0 },
  } as never);
  await library.load();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') {
      return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    }
    if (url.hostname === 'starred-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const data = endpoint === 'getStarred2' ? { starred2: { song: starred } }
        : endpoint === 'getRandomSongs' ? { randomSongs: { song: others } }
          : {};
      return Response.json({ 'subsonic-response': { status: 'ok', ...data } });
    }
    assert.equal(url.hostname, 'starred-model.invalid', `unexpected network request to ${url.hostname}`);
    const body = JSON.parse(String(init?.body));
    const payload = JSON.parse(body.messages.find((m: any) => m.role === 'user').content.split('\n\n')[0]);
    offered.push(payload.candidates.map((t: any) => t.id));
    return Response.json({ id: 'test', object: 'chat.completion', created: 0, model: 'starred-test',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'tool', type: 'function', function: { name: body.tools[0].function.name,
          arguments: JSON.stringify({ id: payload.candidates[0].id, reason: 'Test choice' }) } }],
      } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  library.shutdown();
  rmSync(root, { recursive: true, force: true });
});

function snapshot() {
  const q = Object.create(queue);
  q.current = null;
  q.upcoming = [];
  q.history = [];
  q._recentPlays = [];
  q.log = () => {};
  return q;
}
const coastIds = async () => {
  await refreshAutoPlaylist();
  return [...readFileSync(config.liquidsoap.autoPlaylist, 'utf8').matchAll(/subsonic_id="([^"]+)"/g)].map(m => m[1]);
};
const setInfluence = (influenceDj: boolean) => settings.update({ likes: { enabled: true, influenceDj } } as never);

test('the coast weights only operator curation as hand-starred', async () => {
  starred = STARRED;
  others = [track('other-1'), track('other-2')];
  await setInfluence(false);
  const ids = await coastIds();
  assert.ok(ids.includes('op-1') && ids.includes('hand-1'), 'an operator heart and a hand star both count');
  assert.ok(!ids.includes('anon-1'), 'a listener-only star does not, with influenceDj off');

  await setInfluence(true);
  assert.ok((await coastIds()).includes('anon-1'), 'with listener influence on, a liked star is welcome');
  await setInfluence(false);
});

test('the coast takes a listener-only star back rather than publish nothing', async () => {
  starred = [track('anon-1')];
  others = [];
  assert.deepEqual(await coastIds(), ['anon-1']);
});

test('the pool picker\'s starred fallback follows the same rule, never-starve', async () => {
  starred = STARRED;
  others = [track('other-1')];
  clearPoolCache();
  offered = [];
  await pickViaPool(snapshot(), { dominantMood: null, activeShow: null });
  const flat = offered.flat();
  assert.ok(flat.includes('op-1') || flat.includes('hand-1'));
  assert.ok(!flat.includes('anon-1'), 'a listener-only star is not offered as curation');

  starred = [track('anon-1')];
  others = [];
  clearPoolCache();
  offered = [];
  const pick = await pickViaPool(snapshot(), { dominantMood: null, activeShow: null });
  assert.equal(pick?.song.id, 'anon-1', 'when it is the only music, it still plays');
});

test('the tagger seed layer counts only operator stars as an operator signal', async () => {
  starred = STARRED;
  const { seeds, layerCounts } = await selectSeeds({ seedCount: 10, untaggedPool: new Set(['op-1', 'anon-1', 'hand-1']) });
  assert.ok(seeds.includes('op-1') && seeds.includes('hand-1'));
  // The starred layer's cap here is 3 and three tracks are starred: it took
  // two, so the listener-only star was not counted as an operator signal. It
  // may still be seeded by a later, library-wide layer — not lost, just not
  // promoted.
  assert.equal(layerCounts.operatorStarred, 2);
});

test('the playlist generator\'s starred filler follows the same rule', async () => {
  starred = STARRED;
  others = [];
  const { pool } = await buildCandidatePool({ sources: {}, knobs: {} } as never);
  const ids = pool.map((t: any) => t.id);
  assert.ok(ids.includes('op-1') && ids.includes('hand-1'));
  assert.ok(!ids.includes('anon-1'));
});
