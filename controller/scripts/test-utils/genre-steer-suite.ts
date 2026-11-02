// Real agent selection, guard wiring, constrained SDK re-pick and queue
// insertion. HTTP and discovery are synthetic; nothing reaches a station.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createTempDir } from './temp-dir.js';

// `anchor` is the audio index again, with only the held queue head indexed:
// a search seeded from the track on air finds nothing at all.
const MODE = process.env.GENRE_STEER_TEST === 'text' ? 'text' : process.env.GENRE_STEER_TEST === 'anchor' ? 'anchor' : 'audio';
process.env.STATE_DIR = createTempDir(join(tmpdir(), `subwave-genre-steer-${MODE}-`));
const settings = await import('../../src/settings.js');
const library = await import('../../src/music/library.js');
const db = await import('../../src/music/library-db.js');
const store = await import('../../src/settings/store.js');
const session = await import('../../src/broadcast/session.js');
const { queue } = await import('../../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../../src/broadcast/dj-agent.js');
const { slim } = await import('../../src/llm/internal/tools/picker/slim.js');
const { getClockContext, getTimeContext, getDateContext } = await import('../../src/context.js');
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
// Pair drain's held head: the deadline pick follows it, not the track on air.
const held = track('held', 'Reggae');

before(async () => {
  const cfg = structuredClone(settings.getDefaults());
  cfg.tts.enabled = false;
  Object.assign(cfg.llm, {
    provider: 'openai-compatible', model: 'genre-test',
    baseUrl: 'http://genre-model.invalid/v1', apiKey: 'test',
    artistVarietyWindow: 5, dailyTokenCap: 0, trackSelection: 'agentic',
  });
  cfg.llm.fallback.enabled = false;
  cfg.picker.albumHours = 1;
  store.setCache(cfg);
  await library.load();
  for (const song of [anchor, repeat, alternative, prince, jacob, rocksteady, held]) library.set(song.id, song);
  db.upsertTrackAnalysis(anchor.id, { bpm: 98, musicalKey: '8A' });
  // The on-air reggae track sits beside the soul track in vector space and far
  // from the other reggae candidates, so a real sound-alike or mood lookup can
  // only answer with `alternative` (the seed itself is dropped by the guard).
  const unit = (dim: number, hot: number, near = 0) => Array.from({ length: dim }, (_, i) => i === hot ? 1 : i === near ? 0.2 : 0);
  if (MODE === 'anchor') {
    // `alternative` sits beside the held head. The track on air has no vector,
    // so only a search seeded from the held head can reach it.
    db.upsertTrackAnalysis(held.id, { bpm: 90, musicalKey: '3A' });
    db.upsertTrackAudioVector(held.id, unit(512, 0));
    db.upsertTrackAudioVector(alternative.id, unit(512, 0, 1));
    for (const [i, s] of [repeat, prince, jacob, rocksteady].entries()) db.upsertTrackAudioVector(s.id, unit(512, 5 + i));
  } else if (MODE === 'audio') {
    db.upsertTrackAudioVector(anchor.id, unit(512, 0));
    db.upsertTrackAudioVector(alternative.id, unit(512, 0, 1));
    for (const [i, s] of [repeat, prince, jacob, rocksteady].entries()) db.upsertTrackAudioVector(s.id, unit(512, 5 + i));
  } else {
    db.upsertTrackVector(anchor.id, unit(db.getEmbeddingDim() ?? 8, 0), null);
    db.upsertTrackVector(alternative.id, unit(db.getEmbeddingDim() ?? 8, 0, 1), null);
    for (const [i, s] of [repeat, prince, jacob, rocksteady].entries()) db.upsertTrackVector(s.id, unit(db.getEmbeddingDim() ?? 8, 3 + i), null);
  }
});

after(() => {
  globalThis.fetch = realFetch;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
});


let agentRuns = 0;
type Scenario = 'steer-lands' | 'off' | 'queued-only' | 'shortlist' | 'held-seed';
const scenarios: Scenario[] = MODE === 'audio'
  ? ['steer-lands', 'off', 'queued-only', 'shortlist']
  : MODE === 'anchor' ? ['held-seed'] : ['steer-lands'];

for (const scenario of scenarios) {
  test(`${MODE} index, ${scenario}: the extra discovery call feeds the re-pick with artist spacing and album cooldown both on`, async () => {
    settings.get().llm.genreVarietyWindow = scenario === 'off' ? 0 : 4;
    settings.get().llm.trackSelection = scenario === 'shortlist' ? 'shortlist' : 'agentic';
    agentRuns = 0;
    queue.current = { track: anchor, source: 'ai' };
    // `queued-only` and `held-seed` reach the run's fourth airing through `upcoming`.
    queue.history = Array.from({ length: scenario === 'queued-only' || scenario === 'held-seed' ? 2 : 3 }, (_, i) => ({
      track: track(`history-${i}`, [['Dub'], ['Ska'], ['Lovers Rock']][i]), source: 'ai',
    }));
    queue.upcoming = scenario === 'queued-only' ? [{ track: track('operator', 'Reggae'), source: 'manual' }]
      : scenario === 'held-seed' ? [{ track: held, source: 'ai' }] : [];
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
    const candidates = [repeat, prince, jacob, rocksteady];
    pickerAgent.run = async () => (agentRuns++, {
      object: { id: repeat.id, reason: 'Synthetic choice', say: null, transition: null },
      steps: 1, toolCalls: [], extras: { seen: new Map(candidates.map(s => [s.id, slim(s)] as const)) },
    });
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).hostname !== 'genre-model.invalid') return new Response('', { status: 404 });
      calls++;
      const body = JSON.parse(String(init?.body));
      const prompt = body.messages.find((m: { role: string }) => m.role === 'user').content;
      const payload = JSON.parse(prompt.split('\n\n')[0]);
      assert.deepEqual(payload.candidates.map((s: { id: string }) => s.id), [alternative.id]);
      // Seeded from the held head, the predecessor the re-pick is told about.
      if (scenario === 'held-seed') assert.equal(payload.predecessor.title, held.title);
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
      await runTrackEvent(queue, ctx, scenario === 'held-seed' ? { wantLink: false, pickAnchor: held, anchorPrior: anchor } : { wantLink: false });
      const fires = ['steer-lands', 'queued-only', 'held-seed'].includes(scenario);
      if (scenario !== 'shortlist') assert.equal(queue.upcoming.at(-1)?.track.id, fires ? alternative.id : repeat.id);
      if (scenario !== 'shortlist') assert.equal(calls, fires ? 1 : 0, 'one constrained re-pick, drawn from the extra call');
      assert.equal(logs.some(line => line.includes('steer-away')), fires, 'the log names the extra search');
      assert.equal(logs.some(line => line.includes('genre run')), fires);
      // The Shortlist route never reaches the Agentic genre guard: no agent run, no genre event, no extra search.
      if (scenario === 'shortlist') assert.equal(agentRuns, 0);
      // A queued track counts toward the run, but the guard never re-picks it.
      if (scenario === 'queued-only') assert.equal(queue.upcoming[0].track.id, 'operator');
      if (scenario === 'held-seed') assert.equal(queue.upcoming[0].track.id, held.id);
    } finally {
      queue.log = realLog;
      globalThis.fetch = realFetch;
      pickerAgent.run = realRun;
    }
  });
}
