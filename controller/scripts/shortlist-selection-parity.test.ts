// What a Track Shortlist pick must keep from the Candidate Pool it replaced
// (#1687 review). Only HTTP responses are synthetic; state lives in a temp dir.
//
// - #939: a small local model's 2–3 character id slip must reach the near-miss
//   repair instead of dying in djObject's schema check on the forced-tool path.
// - The selection signals the Agentic route reads from its session (the set's
//   arc, listener favourites, a DJ-mode run's target) reach the Shortlist call.
// - Listener favourites are one gate for every reader.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-shortlist-parity-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const likes = await import('../src/broadcast/likes.js');
const { djPick } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
const { shortlistSignals } = await import('../src/broadcast/dj-agent.js');
const { nearestId } = await import('../src/llm/sdk.js');
const { pickerScope, buildPickerTools } = await import('../src/llm/tools.js');

const realFetch = globalThis.fetch;
let modelCalls = 0;
let answerId = '';

before(async () => {
  await settings.load();
  // openai-compatible runs djObject on the forced-tool object strategy, the
  // path that does not grammar-constrain arguments (same as ollama and locca).
  await settings.update({
    tts: { enabled: false },
    llm: {
      provider: 'openai-compatible', model: 'parity-test',
      baseUrl: 'http://parity-model.invalid/v1', apiKey: 'test',
      fallback: { enabled: false },
    },
  });
  await library.load();
  await likes.load();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'parity-model.invalid', 'unexpected network request');
    modelCalls++;
    const body = JSON.parse(String(init?.body));
    return Response.json({
      id: 'parity-completion', object: 'chat.completion', created: 0, model: 'parity-test',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null, tool_calls: [{
          id: 'parity-tool', type: 'function', function: {
            name: body.tools[0].function.name,
            arguments: JSON.stringify({
              id: answerId,
              musicalReason: 'its patient bass line carries the groove into a warmer room',
              transition: null,
            }),
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

const candidates = [
  { id: 'aB3dE5gH7jK9mN1pQ3sT5v', title: 'Teardrop', artist: 'Massive Attack', shortlistSources: ['tracksByMood'] },
  { id: 'zY8xW6vU4tS2rQ0pO8nM6l', title: 'Glory Box', artist: 'Portishead', shortlistSources: ['deepCuts'] },
];

test('a near-miss id survives the forced-tool call in one request, and repairs to the real track', async () => {
  modelCalls = 0;
  answerId = 'aB3dE5gH7jK9mN1pQ3sT5w'; // last character slipped
  const selection = await djPick({ candidates });
  assert.equal(modelCalls, 1, 'no schema reject, so no recovery attempt and no breaker failure');
  assert.equal(selection.id, answerId, 'djPick hands back what the model said; membership is the call site\'s');
  assert.equal(nearestId(selection.id, candidates.map((candidate) => candidate.id)), candidates[0].id);
});

test('an exact id still resolves its verified Booth identity', async () => {
  modelCalls = 0;
  answerId = candidates[1].id;
  const selection = await djPick({ candidates });
  assert.equal(modelCalls, 1);
  assert.equal(selection.id, candidates[1].id);
  assert.match(selection.selectionReason, /^“Glory Box” by Portishead — its patient bass line/);
});

test('listener favourites are one gate for the clause, the tool and the Shortlist context', async () => {
  await likes.operatorLike({ id: 'loved-track', title: 'Loved', artist: 'Crowd', duration: 240 });
  const off = { enabled: true, influenceDj: false, windowDays: 30, maxTracks: 5 };
  const on = { ...off, influenceDj: true };
  assert.deepEqual(likes.djFavourites(off), []);
  assert.equal(likes.favouritesClause(off), '');
  assert.deepEqual(likes.djFavourites(on).map((entry) => entry.track.id), ['loved-track']);
  assert.match(likes.favouritesClause(on), /"Loved" by Crowd \(1\)/);

  const withFavourites = pickerScope({ listenerFavourites: likes.djFavourites(on) });
  assert.ok('listenerFavourites' in buildPickerTools(withFavourites).tools);
  assert.ok(!('listenerFavourites' in buildPickerTools(pickerScope()).tools),
    'off without favourites, and on the request path, which never sets them');

  assert.deepEqual(shortlistSignals({ history: [] }, withFavourites).listenerFavourites, [
    { title: 'Loved', artist: 'Crowd', likes: 1 },
  ]);
});

test('Shortlist signals carry the set\'s arc and a run target, and are absent when empty', () => {
  const queue = {
    current: { track: { title: 'On Air', artist: 'Now' } },
    history: [{ track: { title: 'Before', artist: 'Then' } }],
  };
  const signals = shortlistSignals(queue, pickerScope(), { bpm: 124, key: '8A' });
  assert.deepEqual(signals.recentPlays?.map((play) => play.title), ['On Air', 'Before'], 'newest first');
  assert.deepEqual(signals.mixRun, { bpm: 124, key: '8A' });
  assert.equal('listenerFavourites' in signals, false);

  assert.deepEqual(shortlistSignals({ current: null, history: [] }, pickerScope()), {},
    'a cold station with no run or favourites keeps the prompt it had');
  assert.deepEqual(shortlistSignals({}, pickerScope()), {}, 'a queue without history is not read');
});
