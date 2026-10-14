import assert from 'node:assert/strict';
import { chatCompletionResponse } from './test-utils/llm.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-pick-transition-context-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const { predecessorContext, predecessorPrompt } = await import('../src/broadcast/dj-agent/pick-context.js');
const { slim } = await import('../src/llm/internal/tools/picker/slim.js');
const { SEED_NOT_A_PICK_CLAUSE } = await import('../src/util/pick-seed.js');
const { PICKER_CRITERIA } = await import('../src/llm/dj.js');
const { getTimeContext, getClockContext, getDateContext } = await import('../src/context.js');

type Song = { id: string; title: string; artist: string; duration: number };
const anchor: Song = { id: 'seed-track', title: 'Spaces', artist: 'King Britt', duration: 300 };
const rejected: Song = { id: 'rejected-track', title: 'Repeat', artist: anchor.artist, duration: 300 };
const alternative: Song = { id: 'alternative-track', title: 'Next', artist: 'Another Artist', duration: 300 };
const advancedOnAir: Song = { id: 'advanced-on-air', title: 'Already advanced', artist: 'Unrelated Artist', duration: 300 };
const realFetch = globalThis.fetch;
const realRun = pickerAgent.run;

before(async () => {
  await settings.load();
  await settings.update({
    tts: { enabled: false },
    llm: {
      pickerAgent: true, dailyTokenCap: 0, artistVarietyWindow: 5,
      provider: 'openai-compatible', model: 'context-test',
      baseUrl: 'http://context-model.invalid/v1', apiKey: 'test',
      fallback: { enabled: false },
    },
  });
  await library.load();
  library.set(anchor.id, { ...anchor, energy: 'low', moods: ['calm'] });
  db.upsertTrackAnalysis(anchor.id, { bpm: 99.4, musicalKey: '8A' });
});

after(() => {
  globalThis.fetch = realFetch;
  pickerAgent.run = realRun;
  if (queue._persistTimer) clearTimeout(queue._persistTimer);
  if (queue._recentPlaysTimer) clearTimeout(queue._recentPlaysTimer);
  library.shutdown();
  rmSync(stateRoot, { recursive: true, force: true });
});

test('the real library projection supplies candidate-format predecessor facts without a pickable id', () => {
  const rec = library.get(anchor.id);
  assert.equal(rec.id, undefined, 'get() returns no id');
  assert.equal(rec.musicalKey, '8A');
  const facts = predecessorContext({ ...anchor, bpm: 0, musicalKey: '1B', energy: 'high' });
  assert.deepEqual(facts, { title: anchor.title, artist: anchor.artist, bpm: 99.4, key: '8A', energy: 'low' });
  const candidate = slim(anchor);
  assert.deepEqual([facts?.bpm, facts?.key, facts?.energy], [candidate.bpm, candidate.key, candidate.energy]);
  assert.ok(!('id' in facts));
  assert.ok(predecessorPrompt(facts).includes(SEED_NOT_A_PICK_CLAUSE));
});

test('unknown facts leave the existing prompt unchanged; partial facts omit unknown fields', () => {
  assert.equal(predecessorContext(null), undefined);
  assert.equal(predecessorContext({ id: 'unanalysed', bpm: 0 }), undefined);
  assert.equal(predecessorPrompt(undefined), '');
  assert.deepEqual(predecessorContext({ title: 'Tempo only', bpm: 140 }), {
    title: 'Tempo only', artist: undefined, bpm: 140,
  }, 'displayed BPM stays raw, with no invented key or energy');
  assert.deepEqual(predecessorContext({ energy: 'medium', bpm: NaN }), {
    title: undefined, artist: undefined, energy: 'medium',
  });
});

for (const scenario of ['on-air', 'recent', 'held', 'unanalysed'] as const) {
  test(`${scenario} pick event and artist re-pick share the captured predecessor facts`, async () => {
    const pickAnchor = scenario === 'unanalysed'
      ? { ...anchor, id: 'unanalysed' }
      : anchor;
    const pick = scenario === 'recent'
      ? { ...rejected, artist: 'Recently Played Artist' }
      : rejected;
    queue.current = { track: scenario === 'held' ? advancedOnAir : pickAnchor, source: 'ai' };
    queue.upcoming = [];
    queue.history = scenario === 'recent' ? [{ track: pick, source: 'ai' }] : [];
    queue.djLog = [];
    queue._recentPlays = scenario === 'recent'
      ? [{ ...pick, endedAt: new Date().toISOString() }]
      : [];
    queue.senderBusy = true;
    const ctx = {
      at: new Date().toISOString(), activeShow: null, clock: getClockContext(),
      time: getTimeContext(), date: getDateContext(), dominantMood: null,
      weather: null, festival: null, showHandover: null, listeners: { count: null }, episodeEditorial: '',
    };
    session.start(ctx);
    let eventPrompt = '';
    let repickCalls = 0;
    pickerAgent.run = async (args) => {
      eventPrompt = String(args.messages.at(-1)?.content);
      // Selection can outlast the current track. The retry must still follow
      // the captured anchor, rather than rereading the live queue position.
      queue.current = { track: advancedOnAir, source: 'ai' };
      return {
        object: { id: pick.id, reason: 'Synthetic pick', say: null, transition: null },
        steps: 1, toolCalls: [],
        extras: { seen: new Map([[pick.id, slim(pick)], [alternative.id, slim(alternative)]]) },
      };
    };
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).hostname, 'context-model.invalid');
      repickCalls++;
      const body = JSON.parse(String(init?.body));
      const prompt = body.messages.find((m: { role: string }) => m.role === 'user').content;
      const payload = JSON.parse(prompt.split('\n\n')[0]);
      const facts = predecessorContext(pickAnchor);
      assert.deepEqual(payload.predecessor, facts);
      assert.deepEqual(payload.candidates.map((s: Song) => s.id), [alternative.id],
        'only surviving candidates are offered, never the seed');
      // The id is a plain string (#939): resolveRepickId, not an enum, holds the
      // answer to these candidates — see repick-id-repair.test.ts.
      assert.equal(body.tools[0].function.parameters.properties.id.enum, undefined);
      assert.ok(body.messages[0].content.includes(PICKER_CRITERIA), 'retry keeps the main FLOW framing');
      if (facts) {
        assert.ok(prompt.includes(SEED_NOT_A_PICK_CLAUSE));
        assert.ok(!('id' in payload.predecessor));
      } else {
        assert.equal('predecessor' in payload, false, 'no analysis preserves the old payload');
      }
      return chatCompletionResponse({ id: 'completion', created: 0, model: 'context-test',
        message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'emit', type: 'function', function: {
              name: body.tools[0].function.name,
              arguments: JSON.stringify({ id: alternative.id, reason: 'Smooth next track', transition: null }),
            },
          }],
        } });
    };
    try {
      await runTrackEvent(queue, ctx, {
        wantLink: false,
        ...(scenario === 'held' ? { pickAnchor, anchorPrior: advancedOnAir } : {}),
      });
      assert.equal(repickCalls, 1);
      assert.equal(queue.upcoming.at(-1)?.track.id, alternative.id);
      const facts = predecessorContext(pickAnchor);
      if (facts) {
        assert.ok(eventPrompt.includes(JSON.stringify(facts)), 'event carries the same JSON fields as the retry');
        assert.ok(eventPrompt.includes(SEED_NOT_A_PICK_CLAUSE));
      } else {
        assert.ok(!eventPrompt.includes('Predecessor context:'));
      }
      assert.match(eventPrompt, scenario === 'held' ? /Pick-cycle anchor: "Spaces"/ : /Now playing "Spaces"/);
    } finally {
      pickerAgent.run = realRun;
      globalThis.fetch = realFetch;
      queue.senderBusy = false;
    }
  });
}
