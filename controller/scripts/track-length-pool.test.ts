// Real pool and SDK with synthetic HTTP responses, isolated from station state.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'subwave-length-pool-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://length-library.invalid';
process.env.LIQUIDSOAP_HOST = 'length-mixer.invalid';
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { queue } = await import('../src/broadcast/queue.js');
const songs = [2700, 2700, 2700, 2700, 300].map((duration, i) => ({
  id: `length-${i}`, title: `Track ${i}`, artist: `Artist ${i}`, duration,
}));
let source: 'random' | 'album' = 'random';
let offered: string[][] = [];
const realFetch = globalThis.fetch;
const realRandom = Math.random;
before(async () => {
  await settings.load();
  await settings.update({ maxTrackSeconds: 1200, maxTrackLengthMode: 'exclude',
    llm: { provider: 'openai-compatible', model: 'length-test', baseUrl: 'http://length-model.invalid/v1',
      apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0 },
  });
  await library.load();
  Math.random = () => 0.99999; // Keep the eligible row beyond the source caps.
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') {
      return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    }
    if (url.hostname === 'length-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: source === 'random' ? songs : [] } }
        : endpoint === 'getAlbumList2' ? { albumList2: { album: source === 'album' ? [{ id: 'album' }] : [] } }
          : endpoint === 'getAlbum' ? { album: { song: songs } } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', ...data } });
    }
    assert.equal(url.hostname, 'length-model.invalid', 'unexpected network request');
    const body = JSON.parse(String(init?.body));
    const payload = JSON.parse(body.messages.find((m: any) => m.role === 'user').content.split('\n\n')[0]);
    offered.push(payload.candidates.map((t: any) => t.id));
    return Response.json({ id: 'test', object: 'chat.completion', created: 0, model: 'length-test',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'tool', type: 'function', function: { name: body.tools[0].function.name,
          arguments: JSON.stringify({ id: payload.candidates[0].id, reason: 'Test choice' }) } }],
      } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  Math.random = realRandom;
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
const pick = () => pickViaPool(snapshot(), { dominantMood: null, activeShow: null });
test('pool retains the eligible random result beyond four prohibited tracks', async () => {
  source = 'random';
  clearPoolCache();
  offered = [];
  assert.equal((await pick())?.song.id, 'length-4');
  assert.deepEqual(offered, [['length-4']]);
});
test('album sampling uses eligible tracks and cached albums survive live ceiling edits', async () => {
  source = 'album';
  clearPoolCache();
  offered = [];
  assert.equal((await pick())?.song.id, 'length-4');
  assert.deepEqual(offered, [['length-4']]);
  await settings.update({ maxTrackLengthMode: 'cut' });
  await pick();
  assert.ok(offered.at(-1)?.some(id => id !== 'length-4'), 'uncapped catalogue is retained in the cache');
  await settings.update({ maxTrackLengthMode: 'exclude' });
  assert.equal((await pick())?.song.id, 'length-4');
  assert.deepEqual(offered.at(-1), ['length-4']);
});
test('backup album sampling retains eligible music beyond prohibited album entries', async () => {
  source = 'album';
  const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');
  const { config } = await import('../src/config.js');
  await refreshAutoPlaylist();
  const playlist = readFileSync(config.liquidsoap.autoPlaylist, 'utf8');
  assert.ok(playlist.includes('subsonic_id="length-4"'));
  assert.ok(!playlist.includes('subsonic_id="length-0"'));
});

test('the real pool pick path carries its upcoming-show forecast into enqueue', async () => {
  source = 'random';
  clearPoolCache();
  const now = Date.now();
  const showAt = new Date(now + 120000);
  const { setCache } = await import('../src/settings/store.js');
  const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');
  // Avoid a fallback refresh here; this test covers the pick/queue path only.
  setCache({ ...settings.get(), maxTrackSeconds: 0,
    llm: { ...settings.get().llm, pickerAgent: false },
    loudness: { ...settings.get().loudness, source: 'measured' },
    shows: [{ id: 'outgoing', name: 'Outgoing', maxTrackSeconds: 1200 }],
    scheduleOverride: { showId: 'outgoing', startedAt: now - 1000, expiresAt: now + 60000 },
  });
  const q = snapshot();
  q.senderBusy = true;
  try {
    await runTrackEvent(q, { activeShow: null, dominantMood: null, time: { period: 'day' } }, { wantLink: false, showAt });
    assert.equal(q.upcoming.length, 1);
    assert.equal(q.upcoming[0].track.duration, 2700);
    assert.equal(q.upcoming[0].selectionShowAt, showAt.getTime());
  } finally {
    if (q._persistTimer) clearTimeout(q._persistTimer);
  }
});
