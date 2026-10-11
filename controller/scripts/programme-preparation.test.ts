import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'subwave-programme-preparation-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const programme = await import('../src/broadcast/programme.js');
const { runPersonaHandoff } = await import('../src/broadcast/dj-agent.js');
const registry = await import('../src/skills/registry.js');
const { getFullContext } = await import('../src/context.js');
after(() => rm(root, { recursive: true, force: true }));

test('late preparation replaces a generic plan while preserving aired programme beats', async () => {
  await settings.load();
  const host = settings.get().personas[0];
  const outgoing = { ...host, id: 'p_outgoing', name: 'Outgoing host' };
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('s_prepared');
  await settings.update({
    personas: [host, outgoing], activePersonaId: outgoing.id,
    shows: [{ id: 's_prepared', name: 'Artist hour', personaId: host.id, programme: true, preparationSkill: 'prepare' }],
    schedule: {},
    skills: { enabled: { prepare: true } },
    tts: { enabled: true },
  });
  let toolCalls = 0;
  registry.replaceLoadedCapabilities([{
    skill: 'prepare', kind: 'prepare', seeded: false,
    toolFn: async () => {
      toolCalls++;
      return { available: true, subject: 'Prepared artist', data: { fact: 'A supplied fact.' } };
    },
  }]);
  const realFetch = globalThis.fetch;
  let baseContext;
  try {
    globalThis.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    baseContext = await getFullContext();
  } finally {
    globalThis.fetch = realFetch;
  }
  const incoming = { ...baseContext, activeShow: { id: 's_prepared', name: 'Artist hour' } };
  session.start({ ...incoming, activeShow: { id: 's_outgoing', name: 'Outgoing' } });
  await settings.update({ schedule: week });
  assert.equal(session.armBoundaryHandoff(incoming), true);
  const introAiredAt = incoming.at;
  session.attachBoundaryProgramme({
    status: 'ok', plan: { angle: 'Generic angle', features: [], introNote: null, outroNote: null },
    beats: { intro: true, 'feature:0': true }, introAiredAt,
  });
  let plans = 0;
  const deps: NonNullable<Parameters<typeof programme.prepareBoundaryPlan>[1]> = {
    generateProgrammePlan: async (args) => {
      plans++;
      assert.match(args.context.episodeEditorial, /Prepared artist/);
      assert.match(args.context.episodeEditorial, /A supplied fact/);
      return { angle: 'Prepared angle', features: [], introNote: null, outroNote: null };
    },
  };
  await programme.prepareBoundaryPlan(incoming, deps);
  const prepared = session.getBoundaryProgramme();
  assert.equal(prepared?.preparationSubject, 'Prepared artist');
  assert.equal(prepared?.plan?.angle, 'Prepared angle');
  assert.deepEqual(prepared?.beats, { intro: true, 'feature:0': true });
  assert.equal(prepared?.introAiredAt, introAiredAt);
  await programme.prepareBoundaryPlan(incoming, deps);
  assert.equal(plans, 1, 'unchanged preparation must not buy another programme plan');
  assert.equal(toolCalls, 1, 'reading later programme context must not repeat preparation');

  let greetingEditorial: string | undefined;
  let signoffEditorial: string | undefined;
  await runPersonaHandoff({
    getDjRecap: () => '', getRecentOpeners: () => [],
    announceExchange: async () => true,
  }, incoming, {
    generateSignoff: async (args) => {
      signoffEditorial = args.context.episodeEditorial;
      return 'Goodbye.';
    },
    generateHandoffGreeting: async (args) => {
      greetingEditorial = args.context.episodeEditorial;
      return 'Welcome.';
    },
  });
  assert.match(greetingEditorial ?? '', /Prepared artist/);
  assert.match(greetingEditorial ?? '', /A supplied fact/);
  assert.doesNotMatch(signoffEditorial ?? '', /Prepared artist/);
  assert.equal(toolCalls, 1, 'handoff generation must reuse the saved preparation');
});
