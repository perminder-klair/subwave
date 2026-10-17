// Issue #1977: the Musical Leanings review on a sonic-journey pick.
//
// Reported (#1911): a journey pick walked out of a soul show's lane and the
// review "did not run". Driving the real pick path established three separate
// things, each pinned below:
//   - The Agentic route's review only ever saw the journey. The pick event tells
//     the model to call tracksTowardJourney, and it calls it (here three times,
//     as the reports describe) and nothing else, so every candidate was a
//     neighbour of the waypoint in the off-show lane. With Leanings that point
//     at the show's lane the review ran, and kept, because none of the tracks
//     it could prefer were in its set. The Agentic review now gets the
//     Shortlist planner's companions to the journey (the show's context and
//     the anchor's continuity), controller-run with no model call
//     (music/shortlist.ts journeyCompanions). That was the defect. The show's
//     context means the show's OWN lane: a live pick always carries a station
//     mood (time of day, weather), and with no show moods the planner lets it
//     stand in ahead of the show's era, so every pick here runs with one.
//   - Leanings the journey lane shares with the pick (a broad genre) cannot
//     settle anything, so the review skips. Working as designed.
//   - "Avoid that lane" in the persona's Soul is not a Leaning; no Leanings
//     means no review. Also as designed: the Soul is voice, not programming.
//
// Drives the real runTrackEvent over a real better-sqlite3 library: the run and
// its journey come from advanceRun, the tools from the real registry. Only HTTP
// and the agent's own model turn are synthetic. Run:
// `npm test -- leanings-on-journeys`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-leanings-journey-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://journey-library.invalid';
process.env.LIQUIDSOAP_HOST = 'journey-mixer.invalid';

const settings = await import('../src/settings.js');
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const runs = await import('../src/broadcast/dj-agent/runs.js');
const { buildPickerTools, pickerScope } = await import('../src/llm/tools.js');
const { journeyCompanions, JOURNEY_COMPANION_PASSES } = await import('../src/music/shortlist.js');
const { artistRootKey } = await import('../src/music/recency.js');
const { getTimeContext, getClockContext, getDateContext } = await import('../src/context.js');

// Two lanes on orthogonal CLAP axes. The track on air sits on the rock axis, so
// a journey toward the show's soul shelf starts out among the rock.
const DIM = 512;
const axis = (i: number, w = 1) => { const v = new Array(DIM).fill(0); v[i] = w; return v; };
const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map(x => x / n); };
const add = (a: number[], b: number[]) => a.map((x, i) => x + b[i]);
const ROCK = 0;
const SOUL = 1;

await db.open({ embeddingDim: 8, adoptStoredDim: true });
// The off-show lane: more anthemic 80s rock than one KNN read returns.
for (let i = 0; i < 70; i++) {
  const id = `rock${i}`;
  db.upsertTrackMeta(id, { title: `Anthem ${i}`, artist: `Arena ${i}`, album: `Stadium ${i}`, year: 1986, genres: ['Rock'], duration: 240 });
  db.upsertTrackTags(id, { moods: ['energetic', 'uplifting'], energy: 'high', source: 'llm' } as never);
  db.upsertTrackAnalysis(id, { bpm: 128, musicalKey: '8A' });
  db.upsertTrackAudioVector(id, unit(add(axis(ROCK), axis(10 + (i % 60), 0.05))));
}
// The show's own lane: flow-compatible with the rock (energy, tempo, key and a
// shared mood) and carrying the host's Leanings in its Last.fm tags.
for (let i = 0; i < 20; i++) {
  const id = `soul${i}`;
  db.upsertTrackMeta(id, { title: `Stomper ${i}`, artist: `Revue ${i}`, album: `Twisted Wheel ${i}`, year: 1966, genres: ['Soul'], duration: 170 });
  db.upsertTrackTags(id, { moods: ['energetic', 'joyful'], energy: 'high', source: 'llm' } as never);
  db.upsertTrackAnalysis(id, { bpm: 128, musicalKey: '8A' });
  db.upsertTrackEnrichment(id, { lastfmTags: ['northern soul', 'motown'], lyricExcerpt: null });
  db.upsertTrackAudioVector(id, unit(add(axis(SOUL), axis(10 + (i % 60), 0.05))));
}
// On air: the previous pick, which already walked out of the show's lane.
db.upsertTrackMeta('hook', { title: 'Hook', artist: 'Pop Act', album: 'Single', year: 1985, genres: ['Pop'], duration: 220 });
db.upsertTrackTags('hook', { moods: ['energetic'], energy: 'high', source: 'llm' } as never);
db.upsertTrackAnalysis('hook', { bpm: 128, musicalKey: '8A' });
db.upsertTrackAudioVector('hook', axis(ROCK));

const SHOW_LANE = 'Favours northern soul, Motown and girl groups.';
const AVOID_IN_SOUL = 'A warm, wry host who keeps well away from stadium rock and anything anthemic.';
const now = Date.now();
// A soft era show, as reported: its filters steer the brief and the journey's
// destination, and lock nothing.
const show = {
  id: 'soul_hour', name: 'Northern Soul Hour', personaId: '',
  topic: '1960s soul, Motown and girl groups',
  eras: [{ fromYear: 1960, toYear: 1969 }],
};
const onAir = { id: 'hook', title: 'Hook', artist: 'Pop Act', duration: 220 };
const realFetch = globalThis.fetch;
const realRun = pickerAgent.run;
const reviewPrompts: string[] = [];
let personaId = '';

async function configure(selection: 'agentic' | 'shortlist', musicLean: string) {
  const personas = settings.get().personas;
  const persona = personas.find((p: any) => p.id === personaId) ?? personas[0];
  personaId = persona.id;
  show.personaId = persona.id;
  await settings.update({
    personas: [{ ...persona, djMode: true, musicLean, soul: AVOID_IN_SOUL }, ...personas.filter((p: any) => p.id !== persona.id)],
    shows: [show],
    scheduleOverride: { showId: show.id, startedAt: now - 60_000, expiresAt: now + 3_600_000 },
    tts: { enabled: false },
    llm: {
      trackSelection: selection, dailyTokenCap: 0, artistVarietyWindow: 0, noRepeatWindow: 0,
      provider: 'openai-compatible', model: 'journey-test',
      baseUrl: 'http://journey-model.invalid/v1', apiKey: 'test', fallback: { enabled: false },
    },
  });
}

// The review model, played straight: it swaps only for a challenger the
// controller marked with an exact Leanings advantage at comparable flow, and
// keeps the baseline otherwise. The Shortlist's own pick takes the first rock
// track it is offered, as the journey pull would.
function answer(prompt: string) {
  const reason = 'its driving backbeat keeps the floor moving without a jolt';
  if (!/"baseline":/.test(prompt)) {
    return { id: /"id":\s*"(rock\d+)"/.exec(prompt)?.[1] ?? 'missing', musicalReason: reason, transition: null, say: null };
  }
  reviewPrompts.push(prompt);
  const review = JSON.parse(prompt.slice(0, prompt.indexOf('\n\nleaningsSources')));
  const challenger = review.challengers.find((c: any) => c.leaningsAdvantages?.length && ['close', 'possible'].includes(c.flowCloseness));
  return challenger
    ? { selectedId: challenger.id, leaningsBasis: challenger.leaningsAdvantages[0], musicalReason: 'its stomping four-on-the-floor beat and bright horns lift the room', transition: null, editorialEvidence: null }
    : { selectedId: review.baseline.id, leaningsBasis: 'NO_LEANINGS_INFLUENCE', musicalReason: reason, transition: null, editorialEvidence: null };
}

before(async () => {
  await settings.load();
  await configure('agentic', SHOW_LANE);
  await library.load();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== 'journey-model.invalid' || init?.method !== 'POST') return new Response('not found', { status: 404 });
    const body = JSON.parse(String(init.body));
    const args = answer(String(body.messages.at(-1)?.content ?? ''));
    return Response.json({
      id: 'r', object: 'chat.completion', created: 1, model: 'journey-test',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'emit', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
  rmSync(stateRoot, { recursive: true, force: true });
});

// getFullContext always sets dominantMood on a live pick: the show's first
// mood, else festival, weather or time of day. This show has no moods, so it is
// the station's own: the afternoon default, which no track here carries.
const STATION_MOOD = 'focus';

function context(dominantMood: string | null = STATION_MOOD) {
  return {
    at: new Date(now).toISOString(), activeShow: settings.resolveActiveShow() as never, clock: getClockContext(),
    time: getTimeContext(), date: getDateContext(), dominantMood,
    weather: null, festival: null, showHandover: null, listeners: { count: null }, episodeEditorial: '',
  };
}

// One pick on the rock anchor, inside the show. `journey` starts a three-pick
// run on it (the first draw starts it, the second makes it three long), and
// the agent does what the reports describe: tracksTowardJourney three times,
// and one of its tracks. Without a journey the agent reads the anchor's
// sound-alikes instead.
async function pick(t: any, { selection = 'agentic', musicLean = SHOW_LANE, journey = true, dominantMood = STATION_MOOD }: {
  selection?: 'agentic' | 'shortlist'; musicLean?: string; journey?: boolean; dominantMood?: string | null;
} = {}) {
  await configure(selection, musicLean);
  let draws = 0;
  t.mock.method(Math, 'random', () => (!journey ? 0.99 : draws++ === 1 ? 0.99 : 0));
  await runs.advanceRun(false, null, { show: settings.resolveActiveShow() as never });
  queue.current = { track: onAir, source: 'ai' };
  queue.upcoming = [];
  queue.history = [];
  queue.djLog = [];
  queue.senderBusy = true;
  session.start(context(dominantMood));
  reviewPrompts.length = 0;
  let resolution: any = null;
  let seenIds: string[] = [];
  pickerAgent.run = async (args: any) => {
    resolution = args.telemetry?.agentPickResolution;
    const { tools, seen } = buildPickerTools(args.scope);
    const call = (name: string, input: object) => (tools as any)[name].execute(input, {
      toolCallId: name, messages: [], abortSignal: AbortSignal.timeout(10_000),
    });
    const results: any[] = [];
    if (journey) {
      assert.ok((tools as any).tracksTowardJourney, 'a journey is active for this pick');
      for (let i = 0; i < 3; i++) results.push(await call('tracksTowardJourney', {}));
    } else {
      assert.equal((tools as any).tracksTowardJourney, undefined, 'no journey for this pick');
      results.push(await call('tracksThatSoundLikeThis', { songId: onAir.id }));
    }
    seenIds = [...seen.keys()];
    return {
      object: { id: results[0][0].id, reason: 'an energy step up from the hook', say: null, transition: null },
      steps: 1, toolCalls: [], extras: { seen },
    };
  };
  try {
    await runTrackEvent(queue, context(dominantMood), { wantLink: false, showAt: new Date(now) });
  } finally {
    pickerAgent.run = realRun;
    queue.senderBusy = false;
  }
  const reviewed = reviewPrompts.length
    ? JSON.parse(reviewPrompts[0].slice(0, reviewPrompts[0].indexOf('\n\nleaningsSources')))
    : null;
  return {
    seenIds,
    review: resolution?.leaningsReview ?? null,
    reviewIds: reviewed ? [reviewed.baseline.id, ...reviewed.challengers.map((c: any) => c.id)] as string[] : [],
    queued: queue.upcoming.map((item: any) => item.track.id),
  };
}

const inLane = (id: string) => id.startsWith('soul');

test('an Agentic journey pick offers the review the show\'s lane, and the review can act on it', async (t) => {
  const r = await pick(t);
  assert.equal(r.seenIds.length, 24, 'three journey calls, eight fresh tracks each');
  assert.ok(r.seenIds.every(id => id.startsWith('rock')), 'discovery itself never left the journey\'s lane');
  assert.ok(r.reviewIds.slice(1).some(inLane), 'the review weighs show tracks beside the journey\'s');
  assert.ok(r.reviewIds.slice(1).some(id => id.startsWith('rock')), 'and still the journey\'s own neighbours');
  assert.equal(r.review?.outcome, 'replaced');
  assert.equal(r.review?.leaningsBasis, 'northern soul');
  assert.ok(inLane(r.queued[0]), `the host's Leanings bring the pick back into the show (queued ${r.queued[0]})`);
});

// Only with no station mood standing in: the Shortlist's own journey plan still
// spends its context pass on that mood ahead of the show's era (left for the
// maintainer; changing it changes what the Shortlist model chooses from).
test('with no station mood standing in, the Shortlist route gave its review the same lanes', async (t) => {
  const r = await pick(t, { selection: 'shortlist', dominantMood: null });
  assert.ok(r.reviewIds.slice(1).some(inLane), 'the Agentic companions match what this route offers');
  assert.ok(inLane(r.queued[0]));
});

test('Leanings the journey lane shares cannot settle a choice, so the review skips', async (t) => {
  const r = await pick(t, { musicLean: 'Favours rock.' });
  assert.equal(r.review?.outcome, 'not-run', 'a shared genre match is compatibility, not an advantage');
  assert.equal(reviewPrompts.length, 0, 'no review call');
  assert.ok(r.queued[0].startsWith('rock'));
});

test('"avoid that lane" in the Soul is not a Leaning: no Leanings, no review', async (t) => {
  const r = await pick(t, { musicLean: '' });
  assert.equal(r.review?.outcome, 'not-run');
  assert.equal(reviewPrompts.length, 0, 'the Soul never feeds the review');
  assert.ok(r.queued[0].startsWith('rock'));
});

test('a pick without a journey reviews only what discovery found', async (t) => {
  const r = await pick(t, { journey: false });
  assert.ok(r.reviewIds.length >= 2, 'the review ran');
  assert.ok(r.reviewIds.every(id => r.seenIds.includes(id)), 'no companions outside a journey');
  assert.equal(r.review?.outcome, 'kept', 'nothing the run surfaced matches the host\'s Leanings');
});

test('journeyCompanions runs the Shortlist\'s companions, never the journey itself, and only on a journey', async () => {
  const base = { currentTrackId: 'hook', currentArtist: 'Pop Act', eras: show.eras };
  assert.deepEqual(await journeyCompanions({ ...base, scope: pickerScope({}) }), { candidates: [], sourceRuns: [] },
    'no waypoint, no companions');
  const waypoint = unit(add(axis(ROCK, 2), axis(SOUL)));
  const { candidates, sourceRuns } = await journeyCompanions({ ...base, scope: pickerScope({ audioWaypoint: waypoint }) });
  assert.equal(sourceRuns.length, JOURNEY_COMPANION_PASSES);
  assert.deepEqual(sourceRuns.map(run => run.source).sort(), ['songsByEra', 'tracksThatSoundLikeThis'],
    'the show\'s context lane and the anchor\'s continuity lane');
  assert.ok(candidates.some(c => inLane(c.id)), 'the show\'s era reaches the review');
  assert.ok(!candidates.some(c => c.id === 'hook' || c.artist === 'Pop Act'), 'never the anchor or its artist');

  const withStationMood = await journeyCompanions({ ...base, dominantMood: STATION_MOOD, scope: pickerScope({ audioWaypoint: waypoint }) });
  assert.deepEqual(withStationMood.sourceRuns.map(run => run.source).sort(), ['songsByEra', 'tracksThatSoundLikeThis'],
    'the station\'s own mood never takes the show\'s pass');
  const unplaced = await journeyCompanions({ currentTrackId: 'hook', currentArtist: 'Pop Act', dominantMood: STATION_MOOD, scope: pickerScope({ audioWaypoint: waypoint }) });
  assert.deepEqual(unplaced.sourceRuns.map(run => [run.source, run.args.mood ?? null]).sort(), [['tracksByMood', STATION_MOOD], ['tracksThatSoundLikeThis', null]],
    'with nothing of the show\'s own to place it, the station mood stands in as before');
  // Every soul act inside the guard's spacing window: the era pass still runs,
  // and none of what it found may reach the review.
  const spacingWindow = new Set(Array.from({ length: 20 }, (_, i) => artistRootKey(`Revue ${i}`)));
  const spaced = await journeyCompanions({ ...base, recentArtistRoots: spacingWindow, scope: pickerScope({ audioWaypoint: waypoint }) });
  assert.ok(spaced.sourceRuns.some(run => run.source === 'songsByEra' && run.accepted > 0), 'the era pass found the show\'s tracks');
  assert.ok(spaced.candidates.length && !spaced.candidates.some(c => inLane(c.id)), 'never an act the guard would space out');
});
