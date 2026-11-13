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
const { handoffGreetingPrompt } = await import('../src/llm/internal/prompts/scripts.js');
const { buildContextLines } = await import('../src/llm/internal/prompts/context.js');
const { introTask, exchangeContextLines } = await import('../src/llm/internal/prompts/programme.js');
const { NO_SUBJECT_LINE, namedSubjectLine } = await import('../src/broadcast/preparation-subject-wording.js');
after(() => removeTempDir(root));

type PlanDeps = NonNullable<Parameters<typeof programme.prepareBoundaryPlan>[1]>;
type Plan = Awaited<ReturnType<NonNullable<PlanDeps['generateProgrammePlan']>>>;
const plan = (angle: string): Plan => ({ angle, features: [], introNote: null, outroNote: null });

async function greeting(ctx: Parameters<typeof runPersonaHandoff>[1]) {
  let seen: { angle: string | null; subject: string | null; prompt: string } | undefined;
  await runPersonaHandoff({ getDjRecap: () => '', getRecentOpeners: () => [], announceExchange: async () => true }, ctx, {
    generateSignoff: async () => 'Goodbye.',
    generateHandoffGreeting: async (args) => {
      seen = { angle: args.episodeAngle ?? null, subject: args.episodeSubject ?? null, prompt: handoffGreetingPrompt(args) };
      return 'Welcome.';
    },
  });
  assert.ok(seen, 'the greeting was generated');
  return seen;
}
const greetingAngle = async (ctx: Parameters<typeof runPersonaHandoff>[1]) => (await greeting(ctx)).angle;

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

test('an unready preparation holds the plan; the greeting names the chosen subject without an angle', async (t) => {
  await settings.load();
  const host = settings.get().personas[0];
  const outgoing = { ...host, id: 'p_outgoing', name: 'Outgoing host' };
  await settings.update({
    personas: [host, outgoing], activePersonaId: outgoing.id,
    shows: [
      { id: 's_dizzy', name: 'Dizzy Spells', personaId: host.id, programme: true, preparationSkill: 'prepare' },
      { id: 's_plain', name: 'Plain hour', personaId: host.id, programme: true },
      { id: 's_unchosen', name: 'Unchosen hour', personaId: host.id, programme: true, preparationSkill: 'prepare_fails' },
      { id: 's_exhausted', name: 'Spent hour', personaId: host.id, programme: true, preparationSkill: 'prepare' },
    ],
    schedule: {}, skills: { enabled: { prepare: true, prepare_fails: true } }, tts: { enabled: true },
  });
  registry.replaceLoadedCapabilities([{
    skill: 'prepare', kind: 'prepare', seeded: false,
    toolFn: async () => ({ available: true, subject: 'Prepared artist', music: { type: 'artist', artistId: 'ar-1' }, data: {} }),
  }, {
    skill: 'prepare_fails', kind: 'prepare_fails', seeded: false,
    toolFn: async () => { throw new Error('research source down'); },
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

  // The skill has chosen its subject, so the greeting names it, with no angle.
  const chosen = await greeting(incoming);
  assert.equal(chosen.angle, null, 'the greeting does not wait for the plan and has no angle');
  assert.equal(chosen.subject, 'Prepared artist');
  assert.ok(chosen.prompt.includes(namedSubjectLine('Prepared artist')), 'the shared wording reaches the greeting');
  assert.match(chosen.prompt, /This episode's subject is "Prepared artist": name it, but state no facts about it or about what will play/);
  assert.doesNotMatch(chosen.prompt, /angle|an hour of/i, 'no angle, and no promise of an hour of the subject');

  // A same-host boundary opens with the standalone intro instead: it reads the
  // same helper, so it names the chosen subject too, with no angle.
  let intro: { subject: string | null; task: string } | undefined;
  await programme.runIntro({
    getDjRecap: () => '', getRecentOpeners: () => [], announce: async () => ({ accepted: true }),
  } as unknown as Parameters<typeof programme.runIntro>[0], incoming, new Date(String(incoming.at)), {}, {
    generateProgrammeIntro: async (args) => {
      intro = { subject: args.episodeSubject ?? null, task: introTask(args) };
      return 'Welcome to the show.';
    },
  });
  assert.equal(intro?.subject, 'Prepared artist');
  assert.ok(intro?.task.includes(namedSubjectLine('Prepared artist')));
  assert.doesNotMatch(intro?.task ?? '', /angle/i);

  // With a guest in the studio the intro is a co-host exchange: its prompt
  // names the chosen subject the same way, with no angle.
  const shows = settings.get().shows;
  await settings.update({ shows: shows.map(s => (s.id === 's_dizzy' ? { ...s, guestPersonaIds: [outgoing.id] } : s)) });
  t.after(() => settings.update({ shows }));
  let exchange: string | undefined;
  await programme.runIntro({
    getDjRecap: () => '', getRecentOpeners: () => [], announceExchange: async () => true,
  } as unknown as Parameters<typeof programme.runIntro>[0], incoming, new Date(String(incoming.at)), {}, {
    generateProgrammeExchange: async (args) => {
      exchange = exchangeContextLines(args).join('\n');
      return [{ persona: host, text: 'Welcome in.' }, { persona: outgoing, text: 'Glad to be here.' }];
    },
    generateProgrammeIntro: async () => { throw new Error('the exchange should have aired'); },
  });
  assert.ok(exchange?.includes(namedSubjectLine('Prepared artist')), 'the co-host intro names the chosen subject');
  assert.doesNotMatch(exchange ?? '', /angle/i);
});

test("the co-host intro's producer note rides with the angle, as the solo intro's does", () => {
  const show = { name: 'Dizzy Spells' };
  const withheld = { angle: null, introNote: 'Open on the invented artist', outroNote: 'Close on it', features: [] };
  assert.doesNotMatch(introTask({ show, plan: withheld }), /invented artist/);
  assert.doesNotMatch(exchangeContextLines({ beat: 'intro', show, plan: withheld }).join('\n'), /invented artist/,
    'a withheld angle takes its intro note with it');
  const current = { ...withheld, angle: 'Current angle', introNote: 'Open warm' };
  assert.match(exchangeContextLines({ beat: 'intro', show, plan: current }).join('\n'), /Producer's note for this beat: Open warm/);
  assert.match(exchangeContextLines({ beat: 'outro', show, plan: withheld }).join('\n'), /Producer's note for this beat: Close on it/,
    'the outro keeps its note as before');
});

test('an unready preparation with no chosen subject gives the greeting neither subject nor angle', async (t) => {
  const { incoming } = await armBoundary(t, 's_unchosen', 'Unchosen hour');
  let plans = 0;
  await programme.prepareBoundaryPlan(incoming, { generateProgrammePlan: async () => { plans++; return plan('Invented angle'); } });
  const view = showPreparation.read({ context: incoming });
  assert.equal(view.status.kind, 'failed');
  assert.equal(plans, 0, 'the tool retry is still due');
  const none = await greeting(incoming);
  assert.equal(none.angle, null);
  assert.equal(none.subject, null);
  assert.doesNotMatch(none.prompt, /subject is|angle/i);
});

test('the tool fails twice: the plan is told no subject was chosen, and the opening trusts its angle like every beat', async (t) => {
  // The same occurrence as above: its first tool failure is on record, the
  // retry a minute away.
  const { incoming } = await armBoundary(t, 's_unchosen', 'Unchosen hour');
  const seen: string[] = [];
  const deps: PlanDeps = { generateProgrammePlan: async (args) => {
    seen.push(buildContextLines(args.context, { steer: false }).join('\n'));
    return plan('An hour of whatever the night brings');
  } };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  await programme.prepareBoundaryPlan(incoming, deps);
  const view = showPreparation.read({ context: incoming });
  assert.equal(view.status.kind, 'failed');
  assert.equal(seen.length, 1, 'no retry left: the plan goes ahead');
  assert.ok(seen[0].includes(NO_SUBJECT_LINE), 'the plan is told no subject was chosen');
  assert.equal(session.getBoundaryProgramme()?.plan?.angle, 'An hour of whatever the night brings');
  // The no-subject brief is what keeps that plan honest, so the greeting uses
  // its angle as the feature and outro beats do (one rule for the hour).
  assert.equal(preparedPlanAngle(session.getBoundaryProgramme(), incoming), 'An hour of whatever the night brings');
  const spoken = await greeting(incoming);
  assert.equal(spoken.angle, 'An hour of whatever the night brings');
  assert.equal(spoken.subject, null);
});

test('both catalogue attempts spent: the plan names the chosen subject with no facts, and the greeting takes its angle', async (t) => {
  const { incoming } = await armBoundary(t, 's_exhausted', 'Spent hour');
  const seen: string[] = [];
  const deps: PlanDeps = { generateProgrammePlan: async (args) => {
    seen.push(buildContextLines(args.context, { steer: false }).join('\n'));
    return plan('An hour named for Prepared artist');
  } };
  await programme.prepareBoundaryPlan(incoming, deps);
  assert.equal(seen.length, 0, 'first catalogue failure: a retry is still due');

  // A minute on, the retry fails too: the preparation is settled, ungrounded.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  await programme.prepareBoundaryPlan(incoming, deps);
  const view = showPreparation.read({ context: incoming });
  assert.equal(view.status.kind, 'degraded');
  assert.equal(view.editorial, '');
  assert.equal(seen.length, 1, 'no retry left: the plan goes ahead');
  assert.ok(seen[0].includes(namedSubjectLine('Prepared artist')), 'the plan gets the same wording as the opening');
  assert.doesNotMatch(seen[0], /episode-source-data|Verified episode subject/, 'no catalogue facts or invented grounding');
  const prog = session.getBoundaryProgramme();
  assert.equal(prog?.preparationSubject, 'Prepared artist');
  assert.equal(prog?.preparationStamp, preparationPlanStamp(incoming));

  const spoken = await greeting(incoming);
  assert.equal(spoken.angle, 'An hour named for Prepared artist', 'the greeting takes the angle of the plan grounded in the chosen subject');
  assert.equal(spoken.subject, null);
  await programme.prepareBoundaryPlan(incoming, deps);
  assert.equal(seen.length, 1, 'an unchanged subject and stamp buy no second plan');
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
  assert.equal(preparedPlanAngle(stamped(JSON.stringify([...JSON.parse(current).slice(0, 1), 'Invented artist', false])), incoming), null, 'a plan written for another subject loses its angle');
  assert.equal(preparedPlanAngle(stamped(undefined), incoming), 'Angle', 'a plan from before the stamp reads unchanged');
  assert.equal(preparedPlanAngle(null, incoming), null);

  // A plan whose stamp no longer matches is replanned, so plan and greeting agree.
  session.attachBoundaryProgramme(stamped('another-occurrence:'));
  assert.equal(preparedPlanAngle(session.getBoundaryProgramme(), incoming), null);
  let plans = 0;
  await programme.prepareBoundaryPlan(incoming, { generateProgrammePlan: async () => { plans++; return plan('Replanned'); } });
  assert.equal(plans, 1);
  assert.equal(session.getBoundaryProgramme()?.preparationStamp, current);
  assert.equal(await greetingAngle(incoming), 'Replanned');
});
