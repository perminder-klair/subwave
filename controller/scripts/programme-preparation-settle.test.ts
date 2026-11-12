// #2321: a programme plan bought while the show's preparation is still waiting
// on a catalogue retry sees only the show's name, so the model invents the
// subject and the handoff greeting announces it. The plan now waits for the
// preparation to settle, one generation runs per episode, a plan finished after
// its subject moved on is dropped, and the greeting uses a plan's angle only
// while the occurrence and subject it was written from still match.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = await mkdtemp(join(tmpdir(), 'subwave-programme-settle-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const programme = await import('../src/broadcast/programme.js');
const { showPreparation, preparationPlanStamp, preparedPlanAngle } = await import('../src/broadcast/show-preparation.js');
const { runPersonaHandoff } = await import('../src/broadcast/dj-agent.js');
const registry = await import('../src/skills/registry.js');
const { getFullContext } = await import('../src/context.js');
after(() => removeTempDir(root));

type PlanDeps = NonNullable<Parameters<typeof programme.prepareBoundaryPlan>[1]>;
type Plan = Awaited<ReturnType<NonNullable<PlanDeps['generateProgrammePlan']>>>;
const plan = (angle: string): Plan => ({ angle, features: [], introNote: null, outroNote: null });

async function greetingAngle(ctx: Parameters<typeof runPersonaHandoff>[1]) {
  let angle: string | null | undefined;
  await runPersonaHandoff({ getDjRecap: () => '', getRecentOpeners: () => [], announceExchange: async () => true }, ctx, {
    generateSignoff: async () => 'Goodbye.',
    generateHandoffGreeting: async (args) => { angle = args.episodeAngle; return 'Welcome.'; },
  });
  return angle;
}

async function armBoundary(t: { mock: { method: typeof import('node:test').mock.method } }, showId: string, showName: string) {
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(showId);
  await settings.update({ schedule: {} });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('catalogue unreachable'); });
  const base = await getFullContext();
  const incoming = { ...base, activeShow: { id: showId, name: showName } };
  session.start({ ...incoming, activeShow: { id: 's_outgoing', name: 'Outgoing' } });
  await settings.update({ schedule: week });
  assert.equal(session.armBoundaryHandoff(incoming), true);
  return { incoming, fetchMock };
}

test('an unready preparation holds the plan and the greeting goes without an invented angle', async (t) => {
  await settings.load();
  const host = settings.get().personas[0];
  const outgoing = { ...host, id: 'p_outgoing', name: 'Outgoing host' };
  await settings.update({
    personas: [host, outgoing], activePersonaId: outgoing.id,
    shows: [
      { id: 's_dizzy', name: 'Dizzy Spells', personaId: host.id, programme: true, preparationSkill: 'prepare' },
      { id: 's_plain', name: 'Plain hour', personaId: host.id, programme: true },
    ],
    schedule: {}, skills: { enabled: { prepare: true } }, tts: { enabled: true },
  });
  registry.replaceLoadedCapabilities([{
    skill: 'prepare', kind: 'prepare', seeded: false,
    toolFn: async () => ({ available: true, subject: 'Prepared artist', music: { type: 'artist', artistId: 'ar-1' }, data: {} }),
  }]);
  // Every fetch fails, so the artist catalogue step rejects as a pool read past
  // the twelve-second cap does: the subject is chosen, a retry is a minute away.
  const { incoming } = await armBoundary(t, 's_dizzy', 'Dizzy Spells');

  let plans = 0;
  const deps: PlanDeps = { generateProgrammePlan: async () => { plans++; return plan('Invented: Dizzy Gillespie'); } };
  await programme.prepareBoundaryPlan(incoming, deps);
  const view = showPreparation.read({ context: incoming });
  assert.equal(view.status.kind, 'degraded');
  assert.equal(view.editorial, '');
  assert.equal(plans, 0, 'no plan is bought while the catalogue retry is still due');
  assert.equal(session.getBoundaryProgramme()?.status, 'pending');
  assert.equal(session.getBoundaryProgramme()?.plan, null);
  await programme.prepareBoundaryPlan(incoming, deps);
  assert.equal(plans, 0);

  assert.equal(await greetingAngle(incoming), null, 'the greeting does not wait for the plan and has no angle');
});

test('one generation per episode, stamped with its occurrence and subject; a stale one is dropped', async (t) => {
  const { incoming, fetchMock } = await armBoundary(t, 's_plain', 'Plain hour');
  fetchMock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));

  // Stale: the subject changes while the model writes.
  await programme.prepareBoundaryPlan(incoming, { generateProgrammePlan: async () => {
    session.getBoundaryProgramme()!.preparationSubject = 'Moved on';
    return plan('Stale angle');
  } });
  assert.equal(session.getBoundaryProgramme()?.status, 'pending', 'a plan finished after its subject moved on is not attached');
  assert.equal(session.getBoundaryProgramme()?.plan, null);

  // Concurrent callers share one generation.
  let plans = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deps: PlanDeps = { generateProgrammePlan: async () => { plans++; await gate; return plan('Plain angle'); } };
  const first = programme.prepareBoundaryPlan(incoming, deps);
  const second = programme.prepareBoundaryPlan(incoming, deps);
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await Promise.all([first, second]);
  assert.equal(plans, 1, 'the second caller waits for the first plan instead of buying another');
  const prog = session.getBoundaryProgramme();
  assert.equal(prog?.plan?.angle, 'Plain angle');
  assert.equal(prog?.preparationStamp, preparationPlanStamp(incoming));
  assert.equal(await greetingAngle(incoming), 'Plain angle', 'a plan written under the current preparation keeps its angle');
});

test('the greeting angle follows the plan stamp; an unstamped legacy plan keeps its angle', async (t) => {
  const { incoming } = await armBoundary(t, 's_plain', 'Plain hour');
  const current = preparationPlanStamp(incoming);
  const stamped = (preparationStamp?: string) => ({ status: 'ok' as const, plan: plan('Angle'), beats: {}, introAiredAt: null, preparationStamp });
  assert.equal(preparedPlanAngle(stamped(current), incoming), 'Angle');
  assert.equal(preparedPlanAngle(stamped(`${current}Invented artist`), incoming), null, 'a plan written for another subject loses its angle');
  assert.equal(preparedPlanAngle(stamped(undefined), incoming), 'Angle', 'a plan from before the stamp reads unchanged');
  assert.equal(preparedPlanAngle(null, incoming), null);

  session.attachBoundaryProgramme(stamped('another-occurrence:'));
  assert.equal(await greetingAngle(incoming), null);
});
