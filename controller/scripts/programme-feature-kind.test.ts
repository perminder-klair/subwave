// A programme feature beat runs only a capability the show could have been
// offered.
//
// The producer is shown a menu (broadcast/programme.ts featureKindMenu:
// enabled, ready, host-owned, cohost-eligible), but the plan schema takes any
// string for `kind`, and the plan lives in session.json for the whole episode.
// So a kind the producer invented, or a skill the operator disabled mid-show,
// used to reach runCapability at the next feature beat. The plan is now narrowed
// to the offered kinds when it is made, and runFeature re-checks the same menu
// at air time, falling to straight talk.
//
// Run: npm test -- programme-feature-kind

import type { SessionContext } from '../src/broadcast/session.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'subwave-programme-feature-kind-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const programme = await import('../src/broadcast/programme.js');
const { queue } = await import('../src/broadcast/queue.js');
const registry = await import('../src/skills/registry.js');
const { getFullContext } = await import('../src/context.js');
const { narrowPlanKinds } = await import('../src/llm/internal/prompts/programme.js');
after(() => rm(root, { recursive: true, force: true }));
await settings.load();

test('narrowPlanKinds nulls any kind outside the offered menu', () => {
  const plan = { angle: 'a', features: [{ topic: 't1', kind: 'news' }, { topic: 't2', kind: 'deep-dive' }, { topic: 't3', kind: null }] };
  assert.deepEqual(narrowPlanKinds(plan, ['deep-dive']).features.map(f => f.kind), [null, 'deep-dive', null]);
  assert.deepEqual(narrowPlanKinds(plan, []).features.map(f => f.kind), [null, null, null]);
  assert.deepEqual(narrowPlanKinds(plan, ['news'], 'deep-dive').features.map(f => f.kind), [null, 'deep-dive', null], 'a pinned kind is the only one allowed');
  assert.equal(plan.features[0].kind, 'news', 'the input plan is not mutated');
});

function fixtureFetch(): Response {
  return new Response(JSON.stringify({
    id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'A straight-talk feature line.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { headers: { 'content-type': 'application/json' } });
}

const weekFor = (id: string) => Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array(24).fill(id)]));

for (const enabled of [false, true]) {
  test(`a planned kind that is ${enabled ? 'still on the menu runs' : 'disabled mid-show airs straight talk'}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
    const logs: string[] = [];
    t.mock.method(queue, 'log', (_kind: string, msg: string) => { logs.push(String(msg)); });
    const id = `s_feature_${enabled}`;
    const skill = `feature-skill-${enabled}`;
    const host = settings.get().personas[0];
    await settings.update({
      timezone: 'UTC', scheduleOverride: null, schedule: weekFor(id),
      shows: [{ id, name: 'Feature show', personaId: host.id, programme: true }],
      skills: { enabled: { [skill]: enabled } }, tts: { enabled: false },
      llm: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', pauseWhenEmpty: false, fallback: { enabled: false } },
    } as never);
    let toolCalls = 0;
    registry.replaceLoadedCapabilities([{ skill, kind: skill, seeded: false, desc: 'A data feature.', toolFn: async () => {
      toolCalls++;
      return { available: true, data: {} };
    } }] as never);
    const ctx = await getFullContext(new Date()) as SessionContext;
    session.start(ctx);
    session.attachProgramme({ status: 'ok', plan: { angle: 'Angle', introNote: 'i', outroNote: 'o', features: [{ topic: 'The feature', kind: skill }] }, beats: {}, introAiredAt: ctx.at } as never);

    await programme.runFeature(queue, ctx, { hourIndex: 0, now: new Date(), automaticHostSpeech: true }).catch(() => null);

    const refused = logs.some(l => l.includes(`"${skill}" is not on this show's capability menu`));
    if (enabled) {
      assert.equal(refused, false, 'an eligible kind is not second-guessed');
      // The fixture model cannot drive the director's tool call, so the run
      // reaches runCapability and fails there — proof it was attempted.
      assert.ok(logs.some(l => l.includes(`"${skill}" failed`)), 'the capability was handed to runCapability');
    } else {
      assert.equal(refused, true, 'the refusal is logged so the booth can see why');
      assert.equal(toolCalls, 0, 'a disabled skill never runs');
    }
  });
}
