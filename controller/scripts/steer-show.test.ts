// Playlist steer: the pick paths see the active show with the steer's music
// overlay, and nothing else does; a prompt steer reaches each route's own call.
// The overlay is pinned on its own, then every pick route is driven for real
// (Track Shortlist, Agentic, the pool, the system prompt) with only the
// library and model HTTP faked. Run: npm test -- steer-show
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-steer-show-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://steer-show-library.invalid';
process.env.LIQUIDSOAP_HOST = 'steer-show-mixer.invalid';

const { steeredShow, episodeUnderSteer } = await import('../src/music/steer.js');
const { showNoRepeatGuard } = await import('../src/music/show-recency.js');
const { isInOrderShow } = await import('../src/music/playlist-order.js');
const { steerRequestSchema, steerSchema } = await import('../src/schemas/steer.js');
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent, livePickerScope } = await import('../src/broadcast/dj-agent.js');
const { pickSystem } = await import('../src/broadcast/dj-agent/schemas.js');
const { pickViaPool, clearPoolCache } = await import('../src/music/picker.js');
const { clearPlaylistCache } = await import('../src/music/show-playlist.js');
const { clearPickerSourceCache } = await import('../src/llm/tools.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');

const NOW = Date.now();
const playlistSteer = { playlistId: 'pl-1', prompt: '', startedAt: NOW, expiresAt: NOW + 60 * 60_000 };
const promptSteer = { ...playlistSteer, playlistId: null, prompt: 'more 2020s pop' };
const show = {
  id: 's1', name: 'Evening', topic: 'slow jazz', persona: { id: 'p1' }, guests: [],
  moods: ['calm'], genres: ['Jazz'], eras: [], energies: ['low'], vocals: 'instrumental', filtersStrict: true,
  playlistIds: ['own'], playlistStrict: true, playlistExhaust: false, playlistInOrder: true, excludedPlaylistIds: ['no'],
};
const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, artist: `Artist ${i}` }));

// The fake library: the steered playlist, and other music the playlist must
// keep out. The fake model answers every pick with `answerId()`, the first
// time with an id nobody offered when `fabricateFirst` is set, so the route's
// corrective re-pick runs.
const song = (id: string, i: number) => ({ id, title: `Song ${id}`, artist: `Act ${id}`, album: `Album ${i}`, duration: 240, genre: 'Pop' });
const PLAYLIST = Array.from({ length: 4 }, (_, i) => song(`pl-${i}`, i));
const OTHERS = Array.from({ length: 6 }, (_, i) => song(`other-${i}`, i + 10));
const FABRICATED = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
let answerId = () => OTHERS[0].id;
let fabricateFirst = false;
const pickCalls: { system: string; user: string }[] = [];
const realFetch = globalThis.fetch;
const realRandom = Math.random;
const realRun = pickerAgent.run;

before(async () => {
  await settings.load();
  await settings.update({ tts: { enabled: false }, llm: {
    provider: 'openai-compatible', model: 'steer-show', baseUrl: 'http://steer-show-model.invalid/v1',
    apiKey: 'test', fallback: { enabled: false }, noRepeatWindow: 0, artistVarietyWindow: 0, dailyTokenCap: 0,
    trackSelection: 'shortlist', shortlistPasses: 1,
  } } as never);
  await library.load();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    if (url.hostname === 'steer-show-library.invalid') {
      const endpoint = url.pathname.split('/').at(-1);
      const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: OTHERS } }
        : endpoint === 'getStarred2' ? { starred2: { song: OTHERS } }
          : endpoint === 'getAlbumList2' ? { albumList2: { album: [{ id: 'album' }] } }
            : endpoint === 'getAlbum' ? { album: { song: OTHERS } }
              : endpoint === 'getSimilarSongs2' ? { similarSongs2: { song: OTHERS } }
                : endpoint === 'getPlaylists' ? { playlists: { playlist: [{ id: 'pl-1', name: 'Steered' }] } }
                  : endpoint === 'getPlaylist' ? { playlist: { entry: PLAYLIST } }
                    : endpoint === 'getSong' ? { song: [...PLAYLIST, ...OTHERS].find(s => s.id === url.searchParams.get('id')) }
                      : {};
      return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
    }
    // Anything else (a lyrics lookup for a queued track) finds nothing.
    if (url.hostname !== 'steer-show-model.invalid') return new Response('not found', { status: 404 });
    const body = JSON.parse(String(init?.body));
    const text = (role: string) => body.messages.filter((m: any) => m.role === role).map((m: any) => m.content).join('\n');
    if (!body.tools?.length) {
      return Response.json({ id: 'l', object: 'chat.completion', created: 0, model: 'steer-show',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'A link.' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    pickCalls.push({ system: text('system'), user: text('user') });
    const id = fabricateFirst && pickCalls.length === 1 ? FABRICATED : answerId();
    return Response.json({ id: 'p', object: 'chat.completion', created: 0, model: 'steer-show',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{
        id: 't', type: 'function', function: { name: body.tools[0].function.name,
          arguments: JSON.stringify({ id, reason: 'fits', musicalReason: 'its warm pulse carries the thread', say: null, transition: null }) },
      }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  Math.random = realRandom;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
  await removeTempDir(stateRoot);
});

beforeEach(async () => {
  pickCalls.length = 0;
  fabricateFirst = false;
  answerId = () => OTHERS[0].id;
  clearPoolCache();
  clearPlaylistCache();
  clearPickerSourceCache();
  await settings.update({ steer: null, scheduleOverride: null, llm: { trackSelection: 'shortlist' } } as never);
});

const liveSteer = (over: Record<string, unknown>) => {
  const now = Date.now();
  return settings.update({ steer: { playlistId: null, prompt: '', startedAt: now - 1000, expiresAt: now + 3_600_000, ...over } });
};

// One pick through the real runTrackEvent on a copy of the queue, as the
// watcher would make it, with nothing on air but the anchor.
async function pickOnce(): Promise<any> {
  const ctx = { at: new Date().toISOString(), activeShow: null, dominantMood: null, time: { period: 'day' }, episodeEditorial: '' };
  session.start(ctx as never);
  const q = Object.create(queue);
  q.current = { track: { id: 'anchor', title: 'Anchor', artist: 'Anchor Act', duration: 240 } };
  q.upcoming = []; q.history = []; q._recentPlays = []; q.senderBusy = true;
  q.log = () => {};
  try {
    await runTrackEvent(q, ctx, { wantLink: false });
  } finally {
    if (q._persistTimer) clearTimeout(q._persistTimer);
  }
  return q;
}

test('a steer needs a playlist or a prompt, and either alone will do', () => {
  assert.equal(steerRequestSchema.safeParse({ until: 'once' }).success, false);
  assert.equal(steerRequestSchema.safeParse({ playlistId: 'pl-1', until: 'once' }).success, true);
  assert.equal(steerRequestSchema.safeParse({ playlistId: '', until: 'once' }).success, false);
  assert.equal(steerSchema({ now: null }).safeParse(playlistSteer).success, true);
  assert.equal(steerSchema({ now: null }).safeParse({ ...playlistSteer, playlistId: null }).success, false);
});

test('a playlist steer makes the show a strict, fully rotated anchor on that playlist and sets its own music rules aside', () => {
  const steered = steeredShow(show, playlistSteer);
  assert.deepEqual(steered.playlistIds, ['pl-1']);
  assert.equal(steered.playlistStrict, true);
  assert.equal(steered.playlistExhaust, true);
  assert.deepEqual(steered.excludedPlaylistIds, []);
  assert.deepEqual([steered.moods, steered.genres, steered.eras, steered.energies], [[], [], [], []]);
  assert.equal(steered.vocals, '');
  assert.equal(steered.filtersStrict, false);
  // Who is on air is not the steer's business.
  assert.deepEqual([steered.id, steered.name, steered.topic, steered.persona], [show.id, show.name, show.topic, show.persona]);
  assert.equal(isInOrderShow(steered), false, 'an in-order show stops walking its own list');
  assert.equal(show.playlistInOrder, true, 'the show itself is not mutated');
});

test('a prompt-only steer changes no field, and no steer changes nothing', () => {
  assert.equal(steeredShow(show, promptSteer), show);
  assert.equal(steeredShow(show, null), show);
  assert.equal(steeredShow(null, promptSteer), null);
});

test('with no show on air a playlist steer still gives the pick paths a show to read', () => {
  const steered = steeredShow(null, playlistSteer);
  assert.equal(steered.id, null);
  assert.equal(steered.persona, null);
  assert.deepEqual(steered.guests, []);
  assert.deepEqual(steered.playlistIds, ['pl-1']);
  assert.equal(steered.playlistStrict, true);
  assert.deepEqual([steered.maxTrackSeconds, steered.minTrackLengthSeconds, steered.fadeAtShowEnd], [null, null, null]);
});

test('the steered show rotates the whole playlist before a repeat, but an artist episode would outrank it', () => {
  const steered = steeredShow(show, playlistSteer);
  const anchor = { show: steered as never, playlistTracks: tracks(10), excludedIds: null };
  const guard = showNoRepeatGuard(100, 20_000, anchor);
  assert.deepEqual({ window: guard.window, exhaustive: guard.exhaustive }, { window: 8, exhaustive: true });
  // Which is why both pick paths set the episode aside under a playlist steer.
  // The episode takes the rotation over as its own (#2320): four tracks, not the playlist's ten.
  assert.equal(showNoRepeatGuard(100, 20_000, { ...anchor, episodeTracks: tracks(4) }).rotation?.length, 4);
  const thin = showNoRepeatGuard(100, 20_000, { ...anchor, playlistTracks: tracks(2) });
  assert.deepEqual({ window: thin.window, exhaustive: thin.exhaustive }, { window: 0, exhaustive: false },
    'two tracks or fewer loop freely');
});

test('one decision sets a prepared episode aside under a playlist steer, with its brief, and nowhere else', () => {
  const context = { episodeEditorial: 'Tonight: one artist, start to finish.', at: 'x' };
  const read = () => ({ tracks: tracks(3) });
  const steered = episodeUnderSteer(context, playlistSteer, read);
  assert.equal(steered.episodeSource, null);
  assert.equal(steered.context.episodeEditorial, '', 'the brief would name an artist the candidates are not by');
  assert.equal(context.episodeEditorial, 'Tonight: one artist, start to finish.', 'the caller\'s context is not mutated');
  for (const steer of [promptSteer, null]) {
    const kept = episodeUnderSteer(context, steer, read);
    assert.deepEqual(kept.episodeSource, { tracks: tracks(3) });
    assert.equal(kept.context, context);
  }
});

test('the pick show carries the steer up to its end and not past it; the active show never changes', async () => {
  await settings.update({ steer: playlistSteer });
  const before = settings.resolvePickShow(new Date(playlistSteer.expiresAt - 1));
  assert.deepEqual(before?.playlistIds, ['pl-1']);
  assert.equal(settings.resolvePickShow(new Date(playlistSteer.expiresAt)), null,
    'a pick airing at the steer\'s end is the next show\'s, unsteered');
  assert.equal(settings.resolveActiveShow(new Date(playlistSteer.expiresAt - 1)), null, 'no show is on air; a steer does not invent one');
  await settings.update({ steer: null });
});

test('Track Shortlist: the pick and its corrective re-pick both carry a prompt steer, never in the system prompt', async () => {
  await liveSteer({ prompt: 'only instrumental tonight' });
  fabricateFirst = true;
  const q = await pickOnce();
  assert.equal(pickCalls.length, 2, 'the first answer named no candidate, so the route re-picked');
  for (const call of pickCalls) {
    assert.match(call.user, /Operator steer — trusted direction[^]*"only instrumental tonight"/);
    assert.ok(!call.system.includes('only instrumental tonight'), 'the cached system prompt stays the same');
  }
  assert.equal(q.upcoming.length, 1);
});

test('Agentic: the agent\'s own ask and its corrective re-pick carry a prompt steer', async () => {
  await settings.update({ llm: { trackSelection: 'agentic' } } as never);
  await liveSteer({ prompt: 'only instrumental tonight' });
  let ask = '';
  pickerAgent.run = async (args: any) => {
    ask = String(args.messages.at(-1)?.content);
    return {
      object: { id: FABRICATED, reason: 'Synthetic pick', say: null, transition: null },
      steps: 1, toolCalls: [],
      extras: { seen: new Map(OTHERS.slice(0, 2).map(s => [s.id, slim(s)])) },
    } as never;
  };
  try {
    const q = await pickOnce();
    assert.equal(q.upcoming.length, 1);
  } finally {
    pickerAgent.run = realRun;
  }
  assert.match(ask, /Operator steer — trusted direction[^]*"only instrumental tonight"$/);
  assert.equal(pickCalls.length, 1, 'the agent answered an id it was never shown: one corrective re-pick');
  assert.match(pickCalls[0].user, /Operator steer — trusted direction[^]*"only instrumental tonight"/);
});

test('a playlist steer locks the live scope, the Shortlist and the pool to its playlist, and stands the exploration nudge down', async () => {
  const playlistIds = new Set(PLAYLIST.map(s => s.id));
  // The control: unsteered, random() = 0 draws an exploration pick.
  Math.random = () => 0;
  try {
    await pickOnce();
  } finally {
    Math.random = realRandom;
  }
  assert.equal(JSON.parse(pickCalls[0].user.split('\n')[0]).context.explore, true);
  pickCalls.length = 0;
  clearPickerSourceCache();

  await liveSteer({ playlistId: 'pl-1' });
  const ctx = { at: new Date().toISOString(), activeShow: null, dominantMood: null, time: { period: 'day' }, episodeEditorial: '' };

  const live = await livePickerScope(queue, { context: ctx });
  assert.deepEqual(live.activeShow?.playlistIds, ['pl-1']);
  assert.deepEqual([...(live.scope.playlistLock ?? [])].sort(), [...playlistIds].sort());

  // The Shortlist, where exploration would otherwise be drawn (random() = 0).
  answerId = () => PLAYLIST[0].id;
  Math.random = () => 0;
  try {
    const q = await pickOnce();
    assert.equal(q.upcoming[0]?.track.id, PLAYLIST[0].id);
  } finally {
    Math.random = realRandom;
  }
  const { context, shortlist } = JSON.parse(pickCalls[0].user.split('\n')[0]);
  assert.ok(!context.explore, 'a strict playlist has no deep cuts to find, so random() = 0 draws no exploration');
  assert.ok(shortlist.length > 0 && shortlist.every((t: any) => playlistIds.has(t.id)), 'only the playlist is offered');

  // The pool, reading the stored steer at the pick's own instant.
  pickCalls.length = 0;
  await pickViaPool(Object.create(queue, { log: { value: () => {} } }), ctx, null, null);
  const offered = JSON.parse(pickCalls[0].user.split('\n\n')[0]).candidates;
  assert.ok(offered.length > 0 && offered.every((t: any) => playlistIds.has(t.id)), 'the pool offers only the playlist');
});

test('the agent\'s system prompt drops the show\'s own music lean under a playlist steer, and keeps the brief', async () => {
  const now = Date.now();
  await settings.update({
    shows: [{ id: 's_jazz', name: 'Jazz Hour', topic: 'late-night jazz', personaId: settings.get().personas[0].id,
      genres: ['Jazz'], moods: [], eras: [], energies: [] }],
    scheduleOverride: { showId: 's_jazz', startedAt: now - 60_000, expiresAt: now + 3_600_000 },
  } as never);
  const at = new Date(now + 1000);
  assert.match(pickSystem(at), /Jazz/);
  await liveSteer({ playlistId: 'pl-1' });
  const steered = pickSystem(at);
  assert.doesNotMatch(steered, /Music steer for this show/);
  assert.match(steered, /late-night jazz/, 'which show is on air, and its brief, are unchanged');
  await settings.update({ steer: null, scheduleOverride: null, shows: [] } as never);
});
