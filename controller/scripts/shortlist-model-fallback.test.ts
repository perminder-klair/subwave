// A Track Shortlist whose model call fails fills the slot from its own list
// instead of paying the pool's second model call on the same transition, and
// the failure still reaches the circuit breaker. Drives the real
// runTrackEvent -> pickViaSelectionRoute path; only HTTP is synthetic.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-shortlist-fallback-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://fallback-library.invalid';
process.env.LIQUIDSOAP_HOST = 'fallback-mixer.invalid';

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { breakerOpen } = await import('../src/broadcast/dj-agent/breaker.js');

const songs = Array.from({ length: 6 }, (_, i) => ({
  id: `fallback-${i}`, title: `Track ${i}`, artist: `Artist ${i}`, album: `Album ${i}`, duration: 240,
}));
const realFetch = globalThis.fetch;
let modelCalls = 0;

before(async () => {
  await settings.load();
  await settings.update({
    tts: { enabled: false },
    llm: {
      provider: 'openai-compatible', model: 'fallback-test',
      baseUrl: 'http://fallback-model.invalid/v1', apiKey: 'test',
      fallback: { enabled: false }, noRepeatWindow: 0,
      trackSelection: 'shortlist', shortlistPasses: 1,
    },
  });
  await library.load();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') {
      return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    }
    if (url.hostname === 'fallback-library.invalid') {
      // Every seedless discovery source answers, so whichever one the plan
      // rotates onto yields the same candidates.
      const endpoint = url.pathname.split('/').at(-1);
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: songs } }
        : endpoint === 'getStarred2' ? { starred2: { song: songs } }
          : endpoint === 'getAlbumList2' ? { albumList2: { album: [{ id: 'album' }] } }
            : endpoint === 'getAlbum' ? { album: { song: songs } } : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'fallback-model.invalid', 'unexpected network request');
    modelCalls++;
    return Response.json({ error: { message: 'synthetic model rejection' } }, { status: 400 });
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
  q.senderBusy = true;
  const logs: string[] = [];
  q.log = (_kind: string, line: string) => logs.push(line);
  return { q, logs };
}

async function failedPick() {
  const { q, logs } = snapshot();
  modelCalls = 0;
  try {
    await runTrackEvent(q, { activeShow: null, dominantMood: null, time: { period: 'day' } }, { wantLink: false });
  } finally {
    if (q._persistTimer) clearTimeout(q._persistTimer);
  }
  return { q, logs };
}

test('a failed Shortlist model call queues its own top track with no second model call', async () => {
  const { q, logs } = await failedPick();
  assert.equal(q.upcoming.length, 1, 'the slot is filled');
  assert.ok(songs.some((song) => song.id === q.upcoming[0].track.id), 'from the shortlist');
  assert.equal(modelCalls, 2, 'only djObject\'s own two attempts; the pool is never asked');
  assert.ok(logs.some((line) => line.includes('Track Shortlist model pick failed')));
  assert.ok(!logs.some((line) => line.includes('falling back to pool')));
  assert.equal(q.upcoming[0].sweep ?? false, false, 'no model judged the seam, so no transition gesture');
});

test('each such fallback still counts against the breaker, which opens on the third', async () => {
  assert.equal(breakerOpen(), false, 'one failure does not open it');
  await failedPick();
  assert.equal(breakerOpen(), false);
  await failedPick();
  assert.equal(breakerOpen(), true, 'a filled slot must not reset the failure count');
});
