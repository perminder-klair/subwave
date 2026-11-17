// #2321: when a preparation settles, scheduler.replanAfterPreparation plans the
// live episode and an incoming one armed on the boundary record then, not at
// the next pick. Its own file: importing the scheduler registers the live
// onPreparationChange listener, which must not race the other #2321 tests.
// The show here has no preparation, so nothing fires that listener, and the
// plan is held back by the station voice switch instead.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = await mkdtemp(join(tmpdir(), 'subwave-programme-replan-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const programme = await import('../src/broadcast/programme.js');
const scheduler = await import('../src/broadcast/scheduler.js');
const { getFullContext } = await import('../src/context.js');
after(() => removeTempDir(root));

type PlanDeps = NonNullable<Parameters<typeof programme.prepareBoundaryPlan>[1]>;

test('replanAfterPreparation plans the armed incoming episode at the record\'s look-ahead moment', async (t) => {
  await settings.load();
  const host = settings.get().personas[0];
  const outgoing = { ...host, id: 'p_outgoing', name: 'Outgoing host' };
  await settings.update({
    personas: [host, outgoing], activePersonaId: outgoing.id,
    shows: [{ id: 's_plain', name: 'Plain hour', personaId: host.id, programme: true }],
    schedule: {}, tts: { enabled: false },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('s_plain');
  const base = await getFullContext();
  const incoming = { ...base, activeShow: { id: 's_plain', name: 'Plain hour' } };
  session.start({ ...incoming, activeShow: { id: 's_outgoing', name: 'Outgoing' } });
  await settings.update({ schedule: week });
  assert.equal(session.armBoundaryHandoff(incoming), true);

  const seen: string[] = [];
  const deps: PlanDeps = { generateProgrammePlan: async (args) => {
    seen.push(String(args.context?.at));
    return { angle: 'Replanned angle', features: [], introNote: null, outroNote: null };
  } };
  // Voice off: the boundary plan is held pending, as an unsettled preparation holds it.
  await programme.prepareBoundaryPlan(incoming, deps);
  assert.equal(seen.length, 0);
  assert.equal(session.getBoundaryProgramme()?.status, 'pending');

  await settings.update({ tts: { enabled: true } });
  await scheduler.replanAfterPreparation(deps);
  const prog = session.getBoundaryProgramme();
  assert.equal(prog?.status, 'ok', 'the armed incoming episode is planned now');
  assert.equal(prog?.plan?.angle, 'Replanned angle');
  assert.ok(seen.includes(session.boundaryHandoffContextAt()!.toISOString()),
    'planned at the boundary record\'s look-ahead moment, as the pick cycle does');

  const before = seen.length;
  await scheduler.replanAfterPreparation(deps);
  assert.equal(seen.length, before, 'idempotent: an unchanged subject buys no second plan');
});
