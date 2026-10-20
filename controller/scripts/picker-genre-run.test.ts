// Real agent selection, guard wiring, constrained SDK re-pick and queue
// insertion. HTTP and discovery are synthetic; nothing reaches a station.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-genre-run-'));
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const store = await import('../src/settings/store.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');
const { getClockContext, getTimeContext, getDateContext } = await import('../src/context.js');
const realFetch = globalThis.fetch;
const realRun = pickerAgent.run;
const track = (id: string, genres: string | string[]) => ({ id, title: id, artist: `${id} artist`, genres: typeof genres === 'string' ? [genres] : genres, duration: 240 });
const anchor = track('on-air', 'Reggae');
const repeat = track('picked', 'Reggae');
const alternative = track('alternative', 'Soul');
const prince = track('prince', ['Pop', 'International Pop', 'Reggae']);
const jacob = track('jacob', ['Dub', 'Reggae', 'Roots Reggae']);
// Shares no label with the run below, only its family.
const rocksteady = track('rocksteady', ['Rocksteady']);
// Pair drain: a deadline pick follows the HELD queue head, not the track on air.
const heldReggae = track('held-reggae', 'Reggae');
const heldSoul = track('held-soul', 'Soul');
const HELD: Record<string, ReturnType<typeof track>> = { 'held-run': heldReggae, 'held-break': heldSoul };
const ANALYSIS: Record<string, { bpm: number; key: string }> = {
  [anchor.id]: { bpm: 98, key: '8A' }, [heldReggae.id]: { bpm: 90, key: '3A' }, [heldSoul.id]: { bpm: 101, key: '5B' },
};

before(async () => {
  const cfg = structuredClone(settings.getDefaults());
  cfg.tts.enabled = false;
  Object.assign(cfg.llm, {
    provider: 'openai-compatible', model: 'genre-test',
    baseUrl: 'http://genre-model.invalid/v1', apiKey: 'test',
    artistVarietyWindow: 0, dailyTokenCap: 0,
  });
  cfg.llm.fallback.enabled = false;
  store.setCache(cfg);
  await library.load();
  for (const song of [anchor, repeat, alternative, prince, jacob, rocksteady, heldReggae, heldSoul]) library.set(song.id, song);
  for (const [id, { bpm, key }] of Object.entries(ANALYSIS)) db.upsertTrackAnalysis(id, { bpm, musicalKey: key });
});

after(() => {
  globalThis.fetch = realFetch;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
});

// The window is the slots the pick will FOLLOW: queued items from the tail,
// then the track on air, then history. `queued-only` and `held-run` reach the
// fourth reggae airing only through `upcoming`; `held-break` would be a fifth
// reggae airing by `current` and history, but the held Soul head ends the run.
// `genre-show`: the show on air sets its own genre list (soft, not strict),
// so the run is that show doing its job and the guard stays out of it.
for (const scenario of ['boundary', 'prince', 'jacob', 'below', 'off', 'queued-only', 'held-run', 'held-break', 'empty-alternatives', 'failed-repick', 'projection-only', 'family', 'genre-show'] as const) {
  test(`${scenario}: the real picker checks the tracks the pick follows and preserves transition facts`, async () => {
    settings.get().llm.genreVarietyWindow = scenario === 'off' ? 0 : 4;
    settings.get().shows = scenario === 'genre-show' ? [{ id: 'reggae-hour', name: 'Reggae Hour', genres: ['Reggae'] } as never] : [];
    settings.get().scheduleOverride = scenario === 'genre-show' ? { showId: 'reggae-hour', startedAt: 0, expiresAt: Date.now() + 3_600_000 } as never : null;
    const held = HELD[scenario] ?? null;
    const predecessor = held ?? anchor;
    queue.current = { track: anchor, source: 'ai' };
    queue.history = Array.from({ length: ['below', 'queued-only', 'held-run'].includes(scenario) ? 2 : 3 }, (_, i) => ({
      track: track(`history-${i}`, scenario === 'family' ? [['Dub'], ['Ska'], ['Lovers Rock']][i] : [['Pop', 'Reggae'], ['Dub', 'Reggae'], ['Roots Reggae', 'Reggae']][i]), source: 'ai',
    }));
    queue.upcoming = scenario === 'queued-only' ? [{ track: track('operator', 'Reggae'), source: 'manual' }]
      : held ? [{ track: held, source: 'ai' }] : [];
    queue._recentPlays = [];
    queue.senderBusy = true;
    const logs: string[] = [];
    const realLog = queue.log;
    queue.log = (_kind, line) => { logs.push(line); };
    const ctx = {
      at: new Date().toISOString(), activeShow: null, clock: getClockContext(),
      time: getTimeContext(), date: getDateContext(), dominantMood: null,
      weather: null, festival: null, showHandover: null, listeners: { count: null }, episodeEditorial: '',
    };
    session.start(ctx);
    const selected = scenario === 'family' ? rocksteady : scenario === 'prince' ? prince : scenario === 'jacob' ? jacob : repeat;
    if (scenario === 'projection-only') {
      for (const s of [repeat, alternative, prince, jacob]) db.requireDb().prepare('DELETE FROM tracks WHERE id = ?').run(s.id);
    }
    pickerAgent.run = async () => ({
      object: { id: selected.id, reason: 'Synthetic choice', say: null, transition: null },
      steps: 1, toolCalls: [], extras: { seen: new Map([
        ...[repeat, prince, jacob, rocksteady].map(s => [s.id, slim(s)] as const),
        ...(scenario === 'empty-alternatives' ? [] : [[alternative.id, slim(alternative)] as const]),
      ]) },
    });
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      // The scope build probes the music server; answer it as an unreachable one.
      if (new URL(String(input)).hostname !== 'genre-model.invalid') return new Response('', { status: 404 });
      calls++;
      const body = JSON.parse(String(init?.body));
      const prompt = body.messages.find((m: { role: string }) => m.role === 'user').content;
      const payload = JSON.parse(prompt.split('\n\n')[0]);
      assert.deepEqual(payload.candidates.map((s: { id: string }) => s.id), [alternative.id]);
      assert.deepEqual(payload.predecessor, { title: predecessor.title, artist: predecessor.artist, ...ANALYSIS[predecessor.id] });
      if (scenario === 'failed-repick') return Response.json({ error: { message: 'synthetic rejection' } }, { status: 400 });
      return Response.json({
        id: 'completion', object: 'chat.completion', created: 0, model: 'genre-test',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{ id: 'emit', type: 'function', function: {
            name: body.tools[0].function.name,
            arguments: JSON.stringify({ id: alternative.id, reason: 'Smooth transition', transition: null }),
          } }],
        } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    };
    try {
      await runTrackEvent(queue, ctx, held ? { wantLink: false, pickAnchor: held, anchorPrior: anchor } : { wantLink: false });
      const fires = ['boundary', 'prince', 'jacob', 'projection-only', 'family', 'queued-only', 'held-run'].includes(scenario);
      assert.equal(queue.upcoming.at(-1)?.track.id, fires ? alternative.id : selected.id);
      // One constrained djObject call can make its existing recovery attempt.
      assert.equal(calls, scenario === 'failed-repick' ? 2 : fires ? 1 : 0);
      assert.equal(logs.some(line => line.includes('genre run')), fires || ['empty-alternatives', 'failed-repick'].includes(scenario));
      // A queued track counts toward the run, but the guard never re-picks it.
      if (scenario === 'queued-only') assert.equal(queue.upcoming[0].track.id, 'operator');
      if (held) assert.equal(queue.upcoming[0].track.id, held.id);
    } finally {
      queue.log = realLog;
      globalThis.fetch = realFetch;
      pickerAgent.run = realRun;
      if (scenario === 'projection-only') {
        for (const s of [repeat, alternative, prince, jacob]) library.set(s.id, s);
      }
    }
  });
}
