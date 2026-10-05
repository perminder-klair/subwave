// Exercise the real pool, queue recency snapshot and SDK selection/failure
// paths. Only HTTP responses are synthetic; no network or station is touched.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-picker-artist-spacing-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://spacing-library.invalid';

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const blocklist = await import('../src/music/blocklist.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { clearPlaylistCache } = await import('../src/music/show-playlist.js');
const { artistRootKey, filterPickerCandidates, trackKey } = await import('../src/music/recency.js');

type Song = { id: string; title: string; artist: string; duration: number };
const song = (id: string, artist: string): Song => ({ id, title: id, artist, duration: 240 });
const repeat = song('repeat-record', 'The Jimi Hendrix Experience');
const fresh = song('fresh-record', 'Kate Bush');
let sourceSongs: Song[] = [];
let excludedSongs: Song[] = [];
let modelMode: 'choose' | 'fail' | 'unknown' | 'near-miss' = 'choose';
let modelCalls = 0;
let offered: Song[][] = [];
const realFetch = globalThis.fetch;

before(async () => {
  await settings.load();
  await settings.update({
    tts: { enabled: false },
    llm: {
      provider: 'openai-compatible', model: 'spacing-test',
      baseUrl: 'http://spacing-model.invalid/v1', apiKey: 'test',
      fallback: { enabled: false }, noRepeatWindow: 0,
    },
  });
  await blocklist.load();
  await library.load();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'spacing-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const data = endpoint === 'getRandomSongs'
        ? { randomSongs: { song: sourceSongs } }
        : endpoint === 'getSimilarSongs2'
          ? { similarSongs2: { song: sourceSongs } }
          : endpoint === 'getPlaylist'
            ? { playlist: { entry: excludedSongs } }
            : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    assert.equal(url.hostname, 'spacing-model.invalid', 'unexpected network request');
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    // SDK recovery appends its output-format instruction after the JSON.
    const payload = JSON.parse(body.messages.find((m: any) => m.role === 'user').content.split('\n\n')[0]);
    offered.push(payload.candidates);
    if (modelMode === 'fail') {
      return Response.json({ error: { message: 'synthetic model rejection' } }, { status: 400 });
    }
    const id = modelMode === 'unknown' ? 'outside-the-offered-catalogue'
      : modelMode === 'near-miss' ? payload.candidates[0].id + 'x'
        : payload.candidates[0].id;
    return Response.json({
      id: 'test-completion', object: 'chat.completion', created: 0, model: 'spacing-test',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null, tool_calls: [{
          id: 'test-tool', type: 'function', function: {
            name: body.tools[0].function.name,
            arguments: JSON.stringify({ id, reason: 'Synthetic choice' }),
          },
        }],
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  library.shutdown();
  rmSync(stateRoot, { recursive: true, force: true });
});

function snapshot() {
  const q = Object.create(queue);
  q.current = { track: song('on-air', 'On Air Act') };
  q.upcoming = [];
  q.history = [];
  // Older than the previous pool's time window. Slot spacing must still read it.
  q._recentPlays = Array.from({ length: 25 }, (_, i) => ({
    ...song(`history-${i}`, i === 23 ? 'Jimi Hendrix' : `History Act ${i}`),
    endedAt: new Date(Date.now() - 24 * 3_600_000).toISOString(),
  }));
  const logs: string[] = [];
  q.log = (_kind: string, line: string) => logs.push(line);
  return { q, logs };
}

async function pick(window: number, q: any, songs = [repeat, fresh], mode = 'choose' as typeof modelMode, excluded: Song[] = [], opts = {}) {
  await settings.update({ llm: { artistVarietyWindow: window } });
  sourceSongs = songs;
  excludedSongs = excluded;
  modelMode = mode;
  modelCalls = 0;
  offered = [];
  clearPoolCache();
  clearPlaylistCache();
  const activeShow = excluded.length ? { excludedPlaylistIds: ['excluded'], name: 'Test' } : null;
  return pickViaPool(q, { dominantMood: null, activeShow, time: { period: 'day' } }, null, null, opts);
}

test('configured window 24 excludes an artist at slot 24; 23 permits it', async () => {
  const { q, logs } = snapshot();
  assert.ok(q.neighbourArtistRoots(24).has(artistRootKey(repeat)));
  assert.ok(!q.neighbourArtistRoots(23).has(artistRootKey(repeat)));
  assert.equal((await pick(24, q))?.song.id, fresh.id);
  assert.deepEqual(offered[0].map(s => s.id), [fresh.id]);
  assert.equal(modelCalls, 1);
  assert.ok(!logs.some(l => l.includes('spacing relaxed')));
  await pick(23, q);
  assert.ok(offered[0].some(s => s.id === repeat.id));
});

test('zero disables configured spacing, including on-air and queued artists', async () => {
  const { q, logs } = snapshot();
  q.current = { track: song('on-air', repeat.artist) };
  q.upcoming = [{ track: song('queued', fresh.artist) }];
  await pick(0, q);
  assert.deepEqual(new Set(offered[0].map(s => s.id)), new Set([repeat.id, fresh.id]));
  assert.equal(modelCalls, 1);
  assert.ok(!logs.some(l => l.includes('spacing relaxed')));
});

test('queued requests and the on-air artist contribute to pool spacing', async () => {
  const { q } = snapshot();
  q.current = { track: song('on-air', 'Jimi Hendrix') };
  q.upcoming = [{ track: song('requested', fresh.artist), requestedBy: 'Listener' }];
  const other = song('other-record', 'Radiohead');
  assert.equal((await pick(5, q, [repeat, fresh, other]))?.song.id, other.id);
  assert.deepEqual(offered[0].map(s => s.id), [other.id]);
  assert.equal(q.upcoming[0].track.id, 'requested', 'request is untouched');
});

test('artist aliases, articles, feature credits and apostrophes share the guard fold', () => {
  for (const [heard, candidate] of [
    ['Jimi Hendrix', 'The Jimi Hendrix Experience'],
    ['Clash', 'The Clash'],
    ['Kanye West', 'Kanye West feat. Jay-Z'],
    ["Guns N' Roses", 'Guns N’ Roses'],
  ]) {
    const repeated = song('variant', candidate);
    assert.deepEqual(filterPickerCandidates([repeated, fresh], {
      recentArtistRoots: new Set([artistRootKey(heard)]),
    }), [fresh]);
  }
});

test('spacing precedes the final cap so a fresh artist beyond slot 18 survives', () => {
  const repeats = Array.from({ length: 24 }, (_, i) => song(`repeat-${i}`, repeat.artist));
  assert.deepEqual(filterPickerCandidates([...repeats, fresh], {
    recentArtistRoots: new Set([artistRootKey(repeat)]), cap: 18,
  }), [fresh]);
});

for (const mode of ['fail', 'unknown', 'near-miss'] as const) {
  test(`${mode} selection uses the spaced pool without an extra model call`, async () => {
    const { q } = snapshot();
    const result = await pick(24, q, [repeat, fresh], mode);
    assert.equal(result?.song.id, fresh.id);
    for (const candidates of offered) assert.deepEqual(candidates.map(s => s.id), [fresh.id]);
    // A rejected call retains djObject's existing two-attempt recovery budget.
    // Spacing itself makes no corrective model call.
    assert.equal(modelCalls, mode === 'fail' ? 2 : 1);
    if (mode !== 'near-miss') assert.match(result?.reason ?? '', /fallback/);
  });
}

test('a single eligible artist keeps music available and logs spacing relaxation', async () => {
  const { q, logs } = snapshot();
  const result = await pick(24, q, [repeat], 'fail');
  assert.equal(result?.song.id, repeat.id);
  assert.ok(logs.some(l => l.includes('artist spacing relaxed (window 24 slots)')));
  assert.equal(modelCalls, 2);
});

test('excluded fresh artists cannot hide an eligible recent artist', async () => {
  const { q, logs } = snapshot();
  assert.equal((await pick(24, q, [repeat, fresh], 'choose', [fresh]))?.song.id, repeat.id);
  assert.deepEqual(offered[0].map(s => s.id), [repeat.id]);
  assert.ok(logs.some(l => l.includes('spacing relaxed')));
});

test('blocked tracks stay blocked when spacing relaxes', async () => {
  const { q } = snapshot();
  await blocklist.add({ type: 'track', id: fresh.id, name: fresh.title });
  try {
    assert.equal((await pick(24, q, [repeat, fresh], 'fail'))?.song.id, repeat.id);
    assert.deepEqual(offered[0].map(s => s.id), [repeat.id]);
    assert.equal(modelCalls, 2);
  } finally {
    await blocklist.remove('track', fresh.id);
  }
});

test('hard track recency and artist-rescue exclusions survive spacing relaxation', async () => {
  assert.deepEqual(filterPickerCandidates([repeat], {
    recentArtistRoots: new Set([artistRootKey(repeat)]), hardRecentIds: new Set([repeat.id]),
  }), []);
  assert.deepEqual(filterPickerCandidates([repeat], {
    recentArtistRoots: new Set([artistRootKey(repeat)]), hardRecentKeys: new Set([trackKey(repeat)]),
  }), []);
  const { q } = snapshot();
  assert.equal(await pick(24, q, [repeat], 'choose', [], { avoidArtist: 'Jimi Hendrix' }), null);
  assert.equal(modelCalls, 0);
});

// Combined #1705/#1739 regression: a fresh artist prohibited by the length
// ceiling must not prevent spacing from relaxing to an eligible recent artist.
test('length exclusion survives artist-spacing relaxation and model fallback', async () => {
  const { q, logs } = snapshot();
  await settings.update({ maxTrackSeconds: 300, maxTrackLengthMode: 'exclude' });
  try {
    const tooLong = { ...fresh, duration: 600 };
    assert.equal((await pick(24, q, [repeat, tooLong], 'fail'))?.song.id, repeat.id);
    for (const candidates of offered) assert.deepEqual(candidates.map(s => s.id), [repeat.id]);
    assert.ok(logs.some(l => l.includes('spacing relaxed')));
    assert.equal(await pick(24, q, [tooLong]), null);
    assert.equal(modelCalls, 0, 'an over-limit pool cannot reach the model');
  } finally {
    await settings.update({ maxTrackSeconds: 0, maxTrackLengthMode: 'cut' });
  }
});
