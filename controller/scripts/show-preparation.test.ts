import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { z } from 'zod';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'subwave-preparation-'));
process.env.STATE_DIR = root;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
const { getFullContext } = await import('../src/context.js');
const context = await getFullContext();
globalThis.fetch = realFetch;
const { createShowPreparation, preparationGrounding } = await import('../src/broadcast/show-preparation.js');
const { preparationStoreSchema, preparationResultSchema } = await import('../src/schemas/show-preparation.js');
const { skillEligible } = await import('../src/skills/eligibility.js');
after(async () => { await rm(root, { recursive: true, force: true }); });

const result = { available: true, subject: 'Artist', data: { facts: ['A sourced fact'] }, music: { type: 'artist', artistId: 'artist' } };
const base = Date.now();
function fixture(name: string) {
  let clock = base;
  let snapshot = { occurrence: { id: name, showId: 's_example', source: 'scheduled' as const, startsAt: base, endsAt: base + 12 * 3600_000 }, skill: 'prepare', configuration: 'initial' };
  let calls = 0;
  let sourceCalls = 0;
  let unavailable = false;
  let invalid = false;
  const options = {
    file: join(root, `${name}.json`), snapshot: () => snapshot, now: () => clock,
    execute: async () => { calls++; return invalid ? { available: true } : result; },
    source: async () => {
      sourceCalls++;
      if (unavailable) throw new Error('Catalogue unavailable');
      return { kind: 'artist' as const, identity: name, artist: { id: 'artist', name: 'Artist' }, tracks: [{ id: 'one', title: 'One', artist: 'Artist', album: undefined, albumId: undefined }], ids: new Set(['one']) };
    },
  };
  return { options, counts: () => ({ calls, sourceCalls }), move: (ms: number) => { clock += ms; },
    change: () => { snapshot = { ...snapshot, skill: 'replacement', configuration: 'changed' }; },
    next: () => { snapshot = { ...snapshot, occurrence: { ...snapshot.occurrence, id: `${name}-next` } }; },
    catalogue: (fails: boolean) => { unavailable = fails; }, tool: (fails: boolean) => { invalid = fails; } };
}

test('parallel preparation and a four-hour roll share one durable choice; restart does not reroll', async () => {
  const f = fixture('concurrent');
  const owner = createShowPreparation(f.options);
  const views = await Promise.all(Array.from({ length: 8 }, () => owner.ensure({ context })));
  assert.ok(views.every(view => view.status.kind === 'ready'));
  assert.equal(f.counts().calls, 1);
  f.move(4 * 3600_000);
  f.change();
  const later = await owner.ensure({ context });
  assert.equal(later.status.kind, 'ready');
  assert.equal(f.counts().calls, 1, 'editing the configured skill cannot replace a committed subject');
  const restarted = createShowPreparation(f.options);
  await restarted.recover();
  await restarted.ensure({ context });
  assert.equal(f.counts().calls, 1);
  const stored = preparationStoreSchema.parse(JSON.parse(await readFile(f.options.file, 'utf8')));
  assert.equal(stored.records[0].skill, 'prepare');
  f.next();
  await restarted.ensure({ context });
  assert.equal(f.counts().calls, 2, 'a new occurrence chooses again');
});

test('catalogue failure persists the selected result and restart retries it without executing the tool', async () => {
  const f = fixture('catalogue'); f.catalogue(true);
  const owner = createShowPreparation(f.options);
  assert.equal((await owner.ensure({ context })).status.kind, 'degraded');
  const stored = preparationStoreSchema.parse(JSON.parse(await readFile(f.options.file, 'utf8')));
  assert.equal(stored.records[0].kind, 'selected');
  await owner.retry({ context });
  assert.equal(f.counts().calls, 1, 'catalogue retry cannot redraw an accepted subject');
  f.catalogue(false); f.move(60_001);
  const restarted = createShowPreparation(f.options);
  assert.equal((await restarted.retry({ context })).status.kind, 'ready');
  await assert.rejects(restarted.retry({ context }), /already chose/);
  assert.equal(f.counts().calls, 1);
  f.catalogue(true);
  const degraded = await restarted.ensure({ context });
  assert.equal(degraded.status.kind, 'degraded');
  assert.equal(degraded.music, null);
  assert.match(degraded.editorial, /Do not claim exclusive/);
});

test('exhausted catalogue retries remain degraded after restart and allow an explicit retry', async () => {
  const f = fixture('exhausted-catalogue');
  f.catalogue(true);
  const owner = createShowPreparation(f.options);
  assert.equal((await owner.ensure({ context })).status.kind, 'degraded');
  f.move(60_001);
  assert.equal((await owner.ensure({ context })).status.kind, 'degraded');
  assert.deepEqual(f.counts(), { calls: 1, sourceCalls: 2 });

  const restarted = createShowPreparation(f.options);
  await restarted.recover();
  const status = restarted.read({ context }).status;
  assert.equal(status.kind, 'degraded', 'the editor must keep offering Retry catalogue');
  assert.equal(status.subject, 'Artist');
  assert.equal(status.reason, 'Catalogue unavailable');
  f.catalogue(false);
  f.move(60_001);
  assert.equal((await restarted.ensure({ context })).status.kind, 'degraded');
  assert.deepEqual(f.counts(), { calls: 1, sourceCalls: 2 }, 'restart cannot reset automatic retry limits');
  assert.equal((await restarted.retry({ context })).status.kind, 'ready');
  assert.deepEqual(f.counts(), { calls: 1, sourceCalls: 3 }, 'explicit retry keeps the accepted subject');
});

test('invalid data fails open with bounded retries and permits explicit retry before acceptance', async () => {
  const f = fixture('invalid'); f.tool(true);
  const owner = createShowPreparation(f.options);
  assert.equal((await owner.ensure({ context })).status.kind, 'failed');
  await owner.ensure({ context }); assert.equal(f.counts().calls, 1);
  f.move(60_001); await owner.ensure({ context }); assert.equal(f.counts().calls, 2);
  f.move(60_001); await owner.ensure({ context }); assert.equal(f.counts().calls, 2);
  f.tool(false);
  assert.equal((await owner.retry({ context })).status.kind, 'ready');
});

test('losing an accepted artist source refreshes fallback once and restores the same subject', async () => {
  const f = fixture('source-change');
  let changes = 0;
  const owner = createShowPreparation({ ...f.options, changed: () => { changes++; } });
  await owner.ensure({ context });
  assert.equal(changes, 1);
  f.catalogue(true);
  assert.equal((await owner.ensure({ context })).status.kind, 'degraded');
  assert.equal(changes, 2, 'the artist fallback must be replaced when its source is lost');
  await owner.ensure({ context });
  assert.equal(changes, 2, 'repeated lookup failures do not keep requesting refreshes');
  f.catalogue(false);
  assert.equal((await owner.ensure({ context })).status.kind, 'ready');
  assert.equal(changes, 3);
  assert.equal(f.counts().calls, 1);
});

test('source research reaches track links and both handoff voices with temporal fields disabled', async () => {
  const f = fixture('grounding');
  const owner = createShowPreparation(f.options);
  const view = await owner.ensure({ context });
  const { buildContextLines } = await import('../src/llm/internal/prompts/context.js');
  const { linkPrompt, signoffPrompt, handoffGreetingPrompt } = await import('../src/llm/internal/prompts/scripts.js');
  const grounded = { ...context, episodeEditorial: view.editorial };
  const incoming = { name: 'Incoming' };
  const outgoing = { name: 'Outgoing' };
  for (const prompt of [
    buildContextLines(grounded, { contextFields: [] }).join('\n'),
    linkPrompt({ current: { id: 'one', title: 'One', artist: 'Artist' }, context: grounded }),
    signoffPrompt({ personaOut: outgoing, personaIn: incoming, context: grounded }),
    handoffGreetingPrompt({ personaOut: outgoing, personaIn: incoming, context: grounded }),
  ]) {
    assert.match(prompt, /Verified episode subject: Artist/);
    assert.match(prompt, /A sourced fact/);
    assert.match(prompt, /actual track context/);
    assert.match(prompt, /"title":"One"/);
    assert.match(prompt, /not evidence of a debut/);
  }
});

test('producer planning, solo beats and guest exchanges send the same accepted research to the model', async () => {
  const f = fixture('programme-grounding');
  const owner = createShowPreparation(f.options);
  const view = await owner.ensure({ context });
  const settings = await import('../src/settings.js');
  const generators = await import('../src/llm/internal/prompts/programme.js');
  const host = { ...settings.get().personas[0], id: 'p_host', name: 'Host' };
  const guest = { ...host, id: 'p_guest', name: 'Guest' };
  const show = { name: 'Artist hour', topic: 'Discuss the prepared artist using the supplied sources.' };
  const plan = { angle: 'Artist records', introNote: 'Introduce Artist', features: [{ topic: 'The sourced fact', kind: null }], outroNote: 'Wrap Artist records' };
  const exchange = { lines: [host, guest, host, guest, host].map(persona => ({ speaker: persona.id, text: 'Artist records.' })) };
  const args = { show, host, guests: [guest], persona: host, plan, context: { ...context, episodeEditorial: view.editorial } };
  const prompts: string[] = [];
  const oldConfig = structuredClone(settings.get().llm);
  const realFetch = globalThis.fetch;
  await settings.update({ llm: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false } } });
  globalThis.fetch = async (_input, init) => {
    const body = z.object({
      messages: z.array(z.object({ content: z.string().nullish() })),
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
    }).parse(JSON.parse(String(init?.body || '{}')));
    prompts.push(body.messages.map(message => message.content || '').join('\n'));
    const output = prompts.length === 1 ? plan : exchange;
    const toolName = body.tools?.[0]?.function?.name;
    const message = toolName
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture', type: 'function', function: { name: toolName, arguments: JSON.stringify(output) } }] }
      : { role: 'assistant', content: 'Artist records.' };
    return new Response(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: toolName ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.deepEqual(await generators.generateProgrammePlan(args), plan);
    await generators.generateProgrammeIntro(args);
    await generators.generateProgrammeFeature({ ...args, topic: 'The sourced fact' });
    await generators.generateProgrammeOutro(args);
    await generators.generateProgrammeExchange({ ...args, beat: 'intro' });
    await generators.generateProgrammeExchange({ ...args, beat: 'outro' });
    assert.equal(prompts.length, 6);
    for (const [index, prompt] of prompts.entries()) {
      assert.match(prompt, /Verified episode subject: Artist/);
      assert.match(prompt, /A sourced fact/);
      if (index > 0) assert.ok(prompt.includes(generators.PROGRAMME_GROUNDING_RULE));
    }
    assert.equal(f.counts().calls, 1);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: oldConfig });
  }
});

test('a superseded async result cannot publish into the new occurrence', async () => {
  const f = fixture('stale');
  let release: (value: unknown) => void = () => {};
  const owner = createShowPreparation({ ...f.options, execute: () => new Promise(resolve => { release = resolve; }) });
  const running = owner.ensure({ context });
  await new Promise(resolve => setTimeout(resolve, 15));
  f.next(); release(result);
  assert.equal((await running).status.kind, 'unconfigured');
  await assert.rejects(readFile(f.options.file), /ENOENT/);
});

test('preparation is data-only, respects enable and host ownership, and is reserved from automatic speech', () => {
  const base = { seeded: false, skill: 'prepare', enabled: { prepare: true }, personaSkills: ['prepare'], requiresCohosts: true, hasCohosts: false };
  assert.equal(skillEligible({ ...base, use: 'preparation' }).allowed, true);
  assert.equal(skillEligible({ ...base, use: 'preparation', enabled: {} }).allowed, false);
  assert.equal(skillEligible({ ...base, use: 'preparation', personaSkills: [] }).allowed, false);
  assert.equal(skillEligible({ ...base, preparationSkill: 'prepare', hasCohosts: true }).allowed, false);
  assert.equal(skillEligible({ ...base, hasCohosts: true }).allowed, true, 'manual speech remains eligible');
  const parsed = preparationResultSchema.parse(result);
  assert.ok(parsed.available);
  assert.match(preparationGrounding(parsed, 'restricted'), /never instructions/);
  assert.match(preparationGrounding(parsed, 'restricted'), /actual track context/);
  assert.equal(preparationResultSchema.safeParse({ available: true, subject: 'x', data: 'x'.repeat(32769) }).success, false);
  assert.equal(preparationResultSchema.safeParse({ available: true, subject: 'x', data: '界'.repeat(11000) }).success, false, 'the research limit counts UTF-8 bytes');
});
