import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'subwave-episode-lifecycle-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const programme = await import('../src/broadcast/programme.js');
const { queue } = await import('../src/broadcast/queue.js');
const { runPersonaHandoff } = await import('../src/broadcast/dj-agent.js');
const registry = await import('../src/skills/registry.js');
const { getFullContext } = await import('../src/context.js');
const { prepareEpisodeContext, showPreparation } = await import('../src/broadcast/show-preparation.js');
const { config } = await import('../src/config.js');
after(() => rm(root, { recursive: true, force: true }));
await settings.load();

const plan = { angle: 'Episode angle', features: [], introNote: null, outroNote: null };
const consumed = { intro: true, 'feature:0': true, outro: true };
const weekFor = (id: string) => Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array(24).fill(id)]));

function fixtureFetch(): Response {
  return new Response(JSON.stringify({
    id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Welcome to the prepared episode.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { headers: { 'content-type': 'application/json' } });
}

for (const sameSubject of [false, true]) {
  test(`a same-show takeover resets legacy beats and restores the scheduled episode (${sameSubject ? 'same' : 'different'} subject)`, async t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
    const id = sameSubject ? 's_same_subject' : 's_new_subject';
    const skill = `prepare-${id}`;
    const host = settings.get().personas[0];
    await settings.update({
      timezone: 'UTC', scheduleOverride: null, schedule: weekFor(id),
      shows: [{ id, name: 'Prepared episode', personaId: host.id, programme: true, preparationSkill: skill }],
      skills: { enabled: { [skill]: true } }, tts: { enabled: false },
      llm: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', pauseWhenEmpty: false, fallback: { enabled: false } },
    });
    let toolCalls = 0;
    registry.replaceLoadedCapabilities([{ skill, kind: skill, seeded: false, toolFn: async () => ({
      available: true, subject: ++toolCalls === 1 || sameSubject ? 'FIRST' : 'SECOND', data: {},
    }) }]);
    const raw = await getFullContext(new Date(clock));
    const scheduled = await prepareEpisodeContext(raw);
    session.start(raw);
    session.attachProgramme({ status: 'ok', plan, beats: { ...consumed }, introAiredAt: raw.at, preparationSubject: 'FIRST' });
    // A persisted episode from before occurrence fields existed. No fillPlan
    // runs on the scheduled side before the operator starts the takeover.
    await writeFile(config.session.currentFile, JSON.stringify(session.getSession()));
    await session.recover(raw);
    assert.equal(session.getProgramme()?.preparationOccurrence, undefined);
    assert.equal(session.getSession()?.episodeOccurrenceId, undefined);

    clock += 1000;
    await settings.update({ scheduleOverride: { showId: id, startedAt: clock, expiresAt: clock + 3600_000 } });
    const takeover = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    await programme.ensurePlan(takeover, new Date(clock));
    assert.equal(toolCalls, 2);
    assert.notEqual(session.getProgramme()?.preparationOccurrence?.id, scheduled.episodeOccurrenceId);
    assert.deepEqual(session.getProgramme()?.beats, {});
    assert.equal(session.getProgramme()?.introAiredAt, null);

    let intros = 0;
    t.mock.method(queue, 'announce', async () => { intros++; return true; });
    await settings.update({ tts: { enabled: true } });
    await programme.ensurePlan(takeover, new Date(clock), { generateProgrammePlan: async () => plan });
    assert.equal(await programme.maybeRunIntro(queue, takeover, new Date(clock)), true);
    assert.equal(intros, 1, 'the fresh occurrence must actually dispatch its intro');
    assert.equal(await programme.maybeRunIntro(queue, takeover, new Date(clock)), false);

    // Persist/recover the suspended scheduled state before returning to it.
    await writeFile(config.session.currentFile, JSON.stringify(session.getSession()));
    await session.recover(takeover);
    await settings.update({ scheduleOverride: null });
    const returned = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    await programme.ensurePlan(returned, new Date(clock));
    assert.equal(session.getProgramme()?.preparationOccurrence?.id, scheduled.episodeOccurrenceId);
    assert.deepEqual(session.getProgramme()?.beats, consumed);
    assert.equal(session.getProgramme()?.introAiredAt, raw.at);
    assert.equal(await programme.maybeRunIntro(queue, returned, new Date(clock)), false);
    assert.equal(toolCalls, 2, 'returning to the scheduled airing cannot redraw its subject');
  });
}

test('upgrading a continuous legacy episode stamps its occurrence without clearing progress', async t => {
  t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
  const id = 's_legacy_continuous';
  const host = settings.get().personas[0];
  await settings.update({ scheduleOverride: null, schedule: weekFor(id),
    shows: [{ id, name: 'Continuous episode', personaId: host.id, programme: true, preparationSkill: 'legacy-prepare' }],
    skills: { enabled: { 'legacy-prepare': true } }, tts: { enabled: false } });
  registry.replaceLoadedCapabilities([{ skill: 'legacy-prepare', kind: 'legacy-prepare', seeded: false,
    toolFn: async () => ({ available: true, subject: 'Legacy subject', data: {} }) }]);
  const ctx = await getFullContext();
  session.start(ctx);
  session.attachProgramme({ status: 'ok', preparationSubject: 'Legacy subject', plan, beats: { ...consumed }, introAiredAt: ctx.at });
  await writeFile(config.session.currentFile, JSON.stringify(session.getSession()));
  await session.recover(ctx);
  await programme.ensurePlan(ctx);
  assert.deepEqual(session.getProgramme()?.beats, consumed);
  assert.equal(session.getProgramme()?.introAiredAt, ctx.at);
  assert.deepEqual(session.getProgramme()?.plan, plan);
  assert.equal(session.getProgramme()?.preparationOccurrence?.id, showPreparation.occurrence({ context: ctx })?.id);
});

for (const ending of ['cancel', 'expiry']) {
  test(`explicit session rolls retain scheduled progress across same-show takeover ${ending}`, async t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
    const id = `s_rolled_${ending}`;
    const skill = `prepare-${ending}`;
    const host = settings.get().personas[0];
    await settings.update({ scheduleOverride: null, schedule: weekFor(id),
      shows: [{ id, name: 'Interrupted programme', personaId: host.id, programme: true, preparationSkill: skill }],
      skills: { enabled: { [skill]: true } }, tts: { enabled: false } });
    let toolCalls = 0;
    registry.replaceLoadedCapabilities([{ skill, kind: skill, seeded: false,
      toolFn: async () => ({ available: true, subject: ++toolCalls === 1 ? 'Scheduled subject' : 'Takeover subject', data: {} }) }]);
    const scheduled = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    session.start(scheduled);
    await programme.ensurePlan(scheduled, new Date(clock));
    session.attachProgramme({ ...session.getProgramme(), status: 'ok', plan, beats: { ...consumed }, introAiredAt: scheduled.at });
    const forceRoll = async (ctx: session.SessionContext) => {
      const owner = session.getSession();
      assert.ok(owner);
      // #1801 rolls these discontinuities without the cap. Age the session
      // here so this branch also exercises a real end/start/persist sequence.
      owner.startedAt = new Date(clock - 5 * 3600_000).toISOString();
      const priorId = owner.id;
      await session.maybeRoll(ctx);
      assert.notEqual(session.getSession()?.id, priorId);
    };
    clock += 1000;
    const expiresAt = clock + 15 * 60_000;
    await settings.update({ scheduleOverride: { showId: id, startedAt: clock, expiresAt } });
    const takeover = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    await forceRoll(takeover);
    assert.equal(session.getProgramme()?.status, 'pending');
    assert.equal(session.getProgramme()?.preparationOccurrence, undefined);
    assert.deepEqual(session.getProgramme()?.beats, {});
    await programme.ensurePlan(takeover, new Date(clock));
    session.markProgrammeBeat('intro');
    assert.equal(session.getProgramme()?.preparationOccurrence?.id, takeover.episodeOccurrenceId);

    if (ending === 'cancel') await settings.update({ scheduleOverride: null });
    else clock = expiresAt + 1;
    const returned = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    await forceRoll(returned);
    assert.equal(session.getProgramme()?.preparationOccurrence, undefined, 'a roll carries snapshots into fresh state');
    await programme.ensurePlan(returned, new Date(clock));
    assert.equal(session.getProgramme()?.preparationOccurrence?.id, scheduled.episodeOccurrenceId);
    assert.equal(session.getProgramme()?.preparationSubject, 'Scheduled subject');
    assert.deepEqual(session.getProgramme()?.beats, consumed);
    assert.equal(session.getProgramme()?.introAiredAt, scheduled.at);
    assert.deepEqual(session.getProgramme()?.plan, plan);
    assert.equal(toolCalls, 2);
  });
}

for (const transition of ['start', 'cancel', 'expiry']) {
  test(`direct recovery retains scheduled progress across same-show takeover ${transition}`, async t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
    const id = `s_recovery_${transition}`;
    const skill = `recovery-${transition}`;
    const host = settings.get().personas[0];
    await settings.update({ scheduleOverride: null, schedule: weekFor(id),
      shows: [{ id, name: 'Recovered programme', personaId: host.id, programme: true, preparationSkill: skill }],
      skills: { enabled: { [skill]: true } }, tts: { enabled: false } });
    let toolCalls = 0;
    registry.replaceLoadedCapabilities([{ skill, kind: skill, seeded: false,
      toolFn: async () => ({ available: true, subject: ++toolCalls === 1 ? 'Scheduled subject' : 'Takeover subject', data: {} }) }]);
    const scheduled = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    session.start(scheduled);
    await programme.ensurePlan(scheduled, new Date(clock));
    session.attachProgramme({ ...session.getProgramme(), status: 'ok', plan, beats: { ...consumed }, introAiredAt: scheduled.at });
    const directRecovery = async (ctx: session.SessionContext) => {
      const stored = structuredClone(session.getSession());
      assert.ok(stored);
      // A restart after end() persisted and before start() committed is a
      // fresh-session recovery on this branch as well as the #1801 branch.
      stored.endedAt = new Date(clock).toISOString();
      await writeFile(config.session.currentFile, JSON.stringify(stored));
      session.start(ctx);
      await session.recover(ctx);
      assert.equal(session.getProgramme()?.status, 'pending');
      assert.equal(session.getProgramme()?.preparationOccurrence, undefined);
      await programme.ensurePlan(ctx, new Date(clock));
    };
    clock += 1000;
    const expiresAt = clock + 15 * 60_000;
    await settings.update({ scheduleOverride: { showId: id, startedAt: clock, expiresAt } });
    const takeover = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    if (transition === 'start') {
      await directRecovery(takeover);
      assert.deepEqual(session.getProgramme()?.beats, {});
      assert.ok(session.getProgramme()?.interruptedEpisodes?.some(episode => episode.preparationOccurrence?.id === scheduled.episodeOccurrenceId));
    } else await programme.ensurePlan(takeover, new Date(clock));
    session.markProgrammeBeat('intro');
    if (transition === 'expiry') clock = expiresAt + 1;
    else await settings.update({ scheduleOverride: null });
    const returned = await prepareEpisodeContext(await getFullContext(new Date(clock)));
    await directRecovery(returned);
    assert.equal(session.getProgramme()?.preparationOccurrence?.id, scheduled.episodeOccurrenceId);
    assert.equal(session.getProgramme()?.preparationSubject, 'Scheduled subject');
    assert.deepEqual(session.getProgramme()?.beats, consumed);
    assert.deepEqual(session.getProgramme()?.plan, plan);
    assert.equal(session.getProgramme()?.introAiredAt, scheduled.at);
    assert.equal(toolCalls, 2);
    if (transition === 'expiry') assert.equal(session.getProgramme()?.interruptedEpisodes?.length, 0);
  });
}

test('snapshot retention is bounded, drops expired occurrences and gives prepared boundary state precedence', async t => {
  t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
  const ctx = await getFullContext();
  const at = Date.now();
  const old: session.ProgrammeState = { status: 'ok', plan, beats: { ...consumed }, introAiredAt: ctx.at,
    preparationOccurrence: { id: 'expired', endsAt: at },
    interruptedEpisodes: Array.from({ length: 24 }, (_, i) => ({ status: 'ok', plan, beats: {}, introAiredAt: null,
      preparationOccurrence: { id: `retained-${i}`, endsAt: at + 3600_000 } })),
  };
  const retained = session.unexpiredProgrammeEpisodes(old, at);
  assert.equal(retained.length, 16);
  assert.equal(retained.some(episode => episode.preparationOccurrence?.id === 'expired'), false);
  const owner = session.start(ctx);
  const prepared: session.ProgrammeState = { status: 'ok', plan: { ...plan, angle: 'Prepared boundary' }, beats: {}, introAiredAt: null };
  owner.programme = old;
  owner.endedAt = ctx.at;
  owner.boundaryHandoff = {
    personaId: 'outgoing', personaName: 'Outgoing', showName: 'Outgoing',
    incomingPersonaId: 'incoming', incomingPersonaName: 'Incoming', incomingShowName: 'Incoming',
    targetKey: owner.key, boundaryAt: at, contextAt: ctx.at, aired: false, programme: prepared,
  };
  await writeFile(config.session.currentFile, JSON.stringify(owner));
  await session.recover(ctx);
  assert.deepEqual(session.getProgramme(), prepared);
});

test('an ordinary delayed roll saves outgoing research and recovers it independently of incoming research', async t => {
  let clock = Math.floor(Date.now() / 3600_000) * 3600_000 + 3600_000 - 60_000;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
  const host = settings.get().personas[0];
  const nextHost = { ...host, id: 'p_next_host', name: 'Incoming host' };
  const nextAt = clock + 60_000;
  const date = new Date(nextAt);
  const week = weekFor('s_outgoing');
  week[date.getUTCDay()][date.getUTCHours()] = 's_incoming';
  await settings.update({ timezone: 'UTC', scheduleOverride: null, schedule: week, personas: [host, nextHost],
    shows: [
      { id: 's_outgoing', name: 'Outgoing', personaId: host.id, preparationSkill: 'out-prep' },
      { id: 's_incoming', name: 'Incoming', personaId: nextHost.id, preparationSkill: 'in-prep' },
    ], skills: { enabled: { 'out-prep': true, 'in-prep': true } }, tts: { enabled: true } });
  registry.replaceLoadedCapabilities(['out', 'in'].map(side => ({ skill: `${side}-prep`, kind: `${side}-prep`, seeded: false,
    toolFn: async () => ({ available: true, subject: side === 'out' ? 'ALPHA OUTGOING' : 'BETA INCOMING', data: { fact: `${side} evidence` } }) })));
  const outgoing = await prepareEpisodeContext(await getFullContext(new Date(clock)));
  session.start(outgoing);
  // Even preparing the incoming show early must leave the live snapshot alone.
  await prepareEpisodeContext(await getFullContext(new Date(nextAt + 5000)));
  assert.match(session.getSession()?.episodeEditorial || '', /ALPHA OUTGOING/);
  clock = nextAt + 5000;
  const incoming = await prepareEpisodeContext(await getFullContext(new Date(clock)));
  await session.maybeRoll(incoming);
  assert.match(session.pendingHandoff()?.episodeEditorial || '', /ALPHA OUTGOING/);
  assert.match(await readFile(config.session.currentFile, 'utf8'), /ALPHA OUTGOING/);
  session.start(incoming);
  await session.recover(incoming);
  let signoff = '';
  let greeting = '';
  await runPersonaHandoff({ getDjRecap: () => '', getRecentOpeners: () => [], announceExchange: async () => true }, incoming, {
    generateSignoff: async args => { signoff = args.context.episodeEditorial; return 'Goodbye.'; },
    generateHandoffGreeting: async args => { greeting = args.context.episodeEditorial; return 'Welcome.'; },
  });
  assert.match(signoff, /ALPHA OUTGOING/);
  assert.doesNotMatch(signoff, /BETA INCOMING/);
  assert.match(greeting, /BETA INCOMING/);
  assert.doesNotMatch(greeting, /ALPHA OUTGOING/);
});

test('a delayed plan cannot replace the state of a new same-show preparation occurrence', async t => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async () => fixtureFetch());
  const id = 's_delayed_plan';
  const host = settings.get().personas[0];
  await settings.update({ scheduleOverride: null, schedule: weekFor(id),
    shows: [{ id, name: 'Delayed plan', personaId: host.id, programme: true, preparationSkill: 'delayed-prep' }],
    skills: { enabled: { 'delayed-prep': true } }, tts: { enabled: true } });
  registry.replaceLoadedCapabilities([{ skill: 'delayed-prep', kind: 'delayed-prep', seeded: false,
    toolFn: async () => ({ available: true, subject: 'Same subject', data: {} }) }]);
  const ctx = await prepareEpisodeContext(await getFullContext(new Date(clock)));
  session.start(ctx);
  let complete = (_plan: typeof plan) => {};
  let started = () => {};
  const generating = new Promise<void>(resolve => { started = resolve; });
  const oldPlan = programme.ensurePlan(ctx, new Date(clock), { generateProgrammePlan: () => {
    started();
    return new Promise(resolve => { complete = resolve; });
  } });
  await generating;
  clock += 1000;
  await settings.update({ scheduleOverride: { showId: id, startedAt: clock, expiresAt: clock + 3600_000 } });
  const takeover = await prepareEpisodeContext(await getFullContext(new Date(clock)));
  const newPlan = { ...plan, angle: 'New occurrence' };
  await programme.ensurePlan(takeover, new Date(clock), { generateProgrammePlan: async () => newPlan });
  complete({ ...plan, angle: 'Stale result' });
  await oldPlan;
  assert.equal(session.getProgramme()?.plan?.angle, 'New occurrence');
  assert.equal(session.getProgramme()?.preparationOccurrence?.id, takeover.episodeOccurrenceId);
});
