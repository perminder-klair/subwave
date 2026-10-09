// Real pick route + real guard subsets; only HTTP is synthetic. Corrective
// model failure must use that subset, without reopening pool discovery.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'subwave-corrective-fallback-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://correction-library.invalid';
process.env.LIQUIDSOAP_HOST = 'correction-mixer.invalid';
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { breakerOpen } = await import('../src/broadcast/dj-agent/breaker.js');
const { clearPickerSourceCache } = await import('../src/llm/tools.js');
const songs = Array.from({ length: 6 }, (_, i) => ({ id: `correction-${i}`, title: `Track ${i}`, artist: `Artist ${i}`, album: `Album ${i}`, duration: 240 }));
const realFetch = globalThis.fetch;
let calls = 0;
let invalidAnswer = false;
const offered: any[][] = [];
before(async () => {
  await settings.load();
  await settings.update({ tts: { enabled: false }, llm: {
    provider: 'openai-compatible', model: 'correction-test', baseUrl: 'http://correction-model.invalid/v1',
    apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0, trackSelection: 'shortlist', shortlistPasses: 1,
  } });
  await library.load();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    if (url.hostname === 'correction-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: songs } }
        : endpoint === 'getStarred2' ? { starred2: { song: songs } }
          : endpoint === 'getAlbumList2' ? { albumList2: { album: [{ id: 'album' }] } }
            : endpoint === 'getAlbum' ? { album: { song: songs } }
              : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: songs } }
                : endpoint === 'getSong' ? { song: songs.find(song => song.id === url.searchParams.get('id')) } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'correction-model.invalid');
    calls++;
    const body = JSON.parse(String(init?.body));
    const prompt = body.messages.find((message: any) => message.role === 'user').content;
    offered.push(JSON.parse(prompt.split('\n')[0]).shortlist);
    if (calls > 1 && !invalidAnswer) return Response.json({ error: { message: 'synthetic corrective failure' } }, { status: 400 });
    return Response.json({
      id: 'correction-completion', object: 'chat.completion', created: 0, model: 'correction-test',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null, tool_calls: [{ id: 'correction-tool', type: 'function', function: {
          name: body.tools[0].function.name,
          arguments: JSON.stringify({ id: invalidAnswer ? 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' : songs[0].id,
            musicalReason: 'its patient bass line carries the groove into a warmer room', transition: null }),
        } }],
      } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  };
});
after(() => { globalThis.fetch = realFetch; library.shutdown(); rmSync(root, { recursive: true, force: true }); });
async function pick(cause: 'artist' | 'album' | 'invalid') {
  clearPickerSourceCache(); calls = 0; offered.length = 0; invalidAnswer = cause === 'invalid';
  await settings.update({ picker: { albumHours: cause === 'album' ? 2 : 0 }, llm: { artistVarietyWindow: cause === 'artist' ? 5 : 0 } });
  const q = Object.create(queue);
  q.current = cause === 'artist' ? { track: { ...songs[0], id: 'anchor', title: 'Anchor track' } } : null;
  q.upcoming = []; q.history = []; q.senderBusy = true;
  q._recentPlays = cause === 'album' ? [{ ...songs[0], id: 'old-track', title: 'Other song', endedAt: new Date().toISOString() }] : [];
  const logs: string[] = [];
  q.log = (_kind: string, line: string) => logs.push(line);
  try { await runTrackEvent(q, { activeShow: null, dominantMood: null, time: { period: 'day' } }, { wantLink: false }); }
  finally { if (q._persistTimer) clearTimeout(q._persistTimer); }
  assert.equal(q.upcoming.length, 1);
  assert.ok(offered.length >= 2, 'a corrective call was made');
  assert.equal(q.upcoming[0].track.id, offered[1][0].id, 'first eligible candidate retains fit order');
  assert.equal(q.upcoming[0].sweep ?? false, false);
  assert.ok(!logs.some(line => line.includes('falling back to pool')));
  return q.upcoming[0].track;
}
test('failed artist correction queues an eligible different artist without a pool model call', async () => {
  const chosen = await pick('artist');
  assert.notEqual(chosen.artist, songs[0].artist);
  assert.ok(offered[1].every(song => song.artist !== songs[0].artist));
  assert.equal(calls, 3, 'initial successful call plus djObject’s two corrective attempts');
  assert.equal(breakerOpen(), false);
});
test('failed album correction queues an eligible different album without a pool model call', async () => {
  const chosen = await pick('album');
  assert.notEqual(chosen.album, songs[0].album);
  assert.ok(offered[1].every(song => song.album !== songs[0].album));
  assert.equal(calls, 3);
  assert.equal(breakerOpen(), false);
});
test('unusable corrective IDs recover from their own list and still open the breaker after three failures', async () => {
  await pick('invalid');
  assert.equal(calls, 2, 'invalid membership requires no additional retry or pool choice');
  assert.equal(breakerOpen(), true, 'filled slots must retain corrective model failures');
});
