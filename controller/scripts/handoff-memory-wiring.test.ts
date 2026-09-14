// The WIRING of the persona mic-pass: which prompt memory each half is handed.
//
// prompt-memory-boundary.test.ts pins the selection policy — what belongs to a
// session and what a hard roll drops. This file pins how runPersonaHandoff
// composes it, which is where the two sides diverge and the half that was
// previously only verifiable by reading:
//
//   - An ordinary post-roll sign-off reads the archived session; a final-track
//     sign-off runs before the real roll and reads the still-live outgoing one.
//   - Either greeting opens a fresh editorial session and must NOT inherit the
//     outgoing memory — a clean slate at the boundary is the point of #1479.
//
// Swap those two and every policy assertion still passes, which is exactly how
// the defect shipped. The two model calls are injected (the artist-guard-run
// pattern), so there is no LLM here; the session, the queue readers and the
// roll are all real.
//
// Run: npm test -- handoff-memory-wiring

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-handoff-wiring-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const djAgent = await import('../src/broadcast/dj-agent.js');
const programme = await import('../src/broadcast/programme.js');
const { currentTalkAir } = await import('../src/broadcast/talk-air.js');

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// Cloned off the shipped default rather than hand-built: the persona schema
// validates tts slots, frequency and soul, and none of that is what this file
// is about.
const template = settings.get().personas[0];
const WREN = { ...template, id: 'p_wren', name: 'Wren' };
const GIGI = { ...template, id: 'p_gigi', name: 'Gigi' };

function context(show: { id: string; name: string }, atMs: number) {
  return {
    at: new Date(atMs).toISOString(),
    time: { period: 'morning', vibe: 'morning', mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    date: {},
    clock: {},
    listeners: 1,
    activeShow: { ...show, topic: '', moods: ['calm'] },
  } as any;
}

// Records what each generator was handed. Neither returns anything the test
// asserts on — the arguments ARE the assertion.
function generators() {
  const seen: Record<string, {
    recap: string | null;
    recentOpeners: string[];
    personaOut: string;
    personaIn: string;
    showOut: string | null;
    showIn: string | null;
    episodeAngle?: string | null;
  }> = {};
  return {
    seen,
    deps: {
      generateSignoff: async ({ recap, recentOpeners, personaOut, personaIn, showOut, showIn }: any) => {
        seen.signoff = {
          recap: recap ?? null, recentOpeners: recentOpeners ?? [],
          personaOut: personaOut.name, personaIn: personaIn.name, showOut, showIn,
        };
        return 'That was the hour. Gigi has the next one.';
      },
      generateHandoffGreeting: async ({ recap, recentOpeners, personaOut, personaIn, showIn, episodeAngle }: any) => {
        seen.greeting = {
          recap: recap ?? null, recentOpeners: recentOpeners ?? [],
          personaOut: personaOut.name, personaIn: personaIn.name, showIn,
          episodeAngle: episodeAngle ?? null,
        };
        return 'Cultural Currents starts now.';
      },
    },
  };
}

// A hard roll with a real persona change, so pendingHandoff() is armed exactly
// the way the boundary arms it in production.
async function rollWithMicPass() {
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_soft_start', name: 'The Soft Start Procedure' }, t0));

  queue.log('link', "The ceiling fan thinks it's an aircraft propeller.");
  session.appendTurn({
    role: 'segment', kind: 'link',
    text: "The ceiling fan thinks it's an aircraft propeller.",
    meta: { personaId: WREN.id, personaName: WREN.name },
  });

  await settings.update({ activePersonaId: GIGI.id } as never);
  await session.maybeRoll(context({ id: 's_cultural', name: 'Cultural Currents' }, t0 + 60_000));
}

test('the mic-pass hands each half the session it actually belongs to', async () => {
  queue.djLog = [];
  await rollWithMicPass();
  assert.ok(session.pendingHandoff(), 'the roll armed a mic-pass');

  const { seen, deps } = generators();
  const announced: { text: string; personaId: string }[] = [];
  const realAnnounce = (queue as any).announce;
  const realExchange = (queue as any).announceExchange;
  (queue as any).announce = async (text: string, _kind: string, opts: any = {}) => {
    announced.push({ text, personaId: opts?.meta?.personaId });
  };
  (queue as any).announceExchange = async (lines: any[]) => {
    announced.push(...lines.map(line => ({ text: line.text, personaId: line.persona.id })));
    return true;
  };
  try {
    await djAgent.runPersonaHandoff(queue, context({ id: 's_cultural', name: 'Cultural Currents' }, Date.now()), deps);
  } finally {
    (queue as any).announce = realAnnounce;
    (queue as any).announceExchange = realExchange;
  }

  assert.ok(seen.signoff, 'the sign-off was generated');
  assert.ok(seen.greeting, 'the greeting was generated');

  // The outgoing DJ still remembers its own hour...
  assert.match(seen.signoff.recap || '', /ceiling fan/i);
  assert.deepEqual(seen.signoff.recentOpeners, ["The ceiling fan thinks it's"]);
  assert.equal(seen.signoff.showOut, 'The Soft Start Procedure');
  assert.equal(seen.signoff.showIn, 'Cultural Currents');

  // ...and the incoming one inherits none of it.
  assert.equal(seen.greeting.recap, null);
  assert.deepEqual(seen.greeting.recentOpeners, []);

  assert.deepEqual(
    announced.map((a) => a.personaId),
    [WREN.id, GIGI.id],
    'the sign-off is stamped with the outgoing persona and the greeting with the incoming one',
  );
});

test('a failed sign-off still leaves the greeting on a clean slate', async () => {
  queue.djLog = [];
  await rollWithMicPass();

  const { seen, deps } = generators();
  const realAnnounce = (queue as any).announce;
  (queue as any).announce = async () => {};
  try {
    await djAgent.runPersonaHandoff(
      queue,
      context({ id: 's_cultural', name: 'Cultural Currents' }, Date.now()),
      { ...deps, generateSignoff: async () => { throw new Error('tts down'); } },
    );
  } finally {
    (queue as any).announce = realAnnounce;
  }

  assert.equal(seen.signoff, undefined, 'the sign-off never reported its arguments');
  assert.ok(seen.greeting, 'the greeting still ran — it stands alone');
  assert.equal(seen.greeting.recap, null);
});

test('an enabled same-host show change renders one acknowledgement, not a self-handoff', async () => {
  queue.djLog = [];
  await settings.update({
    personas: [WREN], activePersonaId: WREN.id,
    djBehaviour: { sameHostAcknowledgement: true },
  } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_dawn', name: 'The Dawn Chorus' }, t0));
  await session.maybeRoll(context({ id: 's_go', name: 'Get up and Go!' }, t0 + 60_000));
  assert.equal(session.pendingHandoff()?.sameHost, true, 'the scheduled same-host change is armed');

  let signoffs = 0;
  let acknowledgement: any = null;
  const announced: string[] = [];
  const realAnnounce = (queue as any).announce;
  (queue as any).announce = async (text: string) => { announced.push(text); };
  try {
    await djAgent.runPersonaHandoff(
      queue,
      context({ id: 's_go', name: 'Get up and Go!' }, Date.now()),
      {
        generateSignoff: async () => { signoffs++; return 'This must not be used.'; },
        generateHandoffGreeting: async (args: any) => {
          acknowledgement = args;
          return 'A fresh start for Get up and Go!';
        },
      },
    );
  } finally {
    (queue as any).announce = realAnnounce;
  }

  assert.equal(signoffs, 0, 'the host does not sign off to themself');
  assert.equal(acknowledgement.sameHost, true);
  assert.equal(acknowledgement.showIn, 'Get up and Go!');
  assert.deepEqual(announced, ['A fresh start for Get up and Go!']);
});

test('a final-track handoff uses the incoming identity captured at arm time', async () => {
  queue.djLog = [];
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  session.appendTurn({
    role: 'segment', kind: 'link',
    text: 'The current outgoing hour followed the midnight train.',
    meta: { personaId: WREN.id, personaName: WREN.name },
  });

  // This models a scheduler edit or look-ahead resolution: the live session is
  // still Wren, while the next show belongs to Gigi.
  const priorShows = settings.get().shows;
  const priorSchedule = settings.get().schedule;
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('s_incoming');
  await settings.update({
    activePersonaId: GIGI.id,
    shows: [{
      id: 's_incoming', name: 'Cultural Currents', topic: 'culture',
      personaId: GIGI.id, programme: true,
    }],
    schedule: week,
  } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming), true);
  await programme.prepareBoundaryPlan(incoming, {
    generateProgrammePlan: async () => ({
      angle: 'Incoming programme angle', features: [], introNote: null, outroNote: null,
    }),
  });

  const { seen, deps } = generators();
  const aired: string[] = [];
  const realExchange = (queue as any).announceExchange;
  (queue as any).announceExchange = async (lines: any[]) => {
    aired.push(...lines.map(line => line.persona.name));
    return true;
  };
  try {
    await djAgent.runPersonaHandoff(queue, incoming, deps);
  } finally {
    (queue as any).announceExchange = realExchange;
  }

  assert.equal(seen.signoff.personaOut, WREN.name);
  assert.equal(seen.signoff.personaIn, GIGI.name);
  assert.equal(seen.signoff.showIn, 'Cultural Currents');
  assert.match(seen.signoff.recap || '', /current outgoing hour followed the midnight train/i,
    'a pre-roll sign-off reads the outgoing session that is still live');
  assert.equal(seen.greeting.recap, null,
    'the incoming greeting does not inherit the outgoing session');
  assert.deepEqual(seen.greeting.recentOpeners, [],
    'the incoming greeting also starts with a clean opener window');
  assert.equal(seen.greeting.personaIn, GIGI.name);
  assert.equal(seen.greeting.episodeAngle, 'Incoming programme angle',
    'the greeting reads the incoming programme plan prepared before the roll');
  assert.deepEqual(aired, [WREN.name, GIGI.name]);
  assert.equal(session.pendingHandoff(), null,
    'a live controller keeps the rendered pair in its queue instead of generating it twice');
  assert.equal(session.boundaryHandoffStatus()?.state, 'queued',
    'the pair is durable-but-not-aired until the stream edge confirms it');
  await session.maybeRoll(incoming);
  assert.equal(session.getProgramme()?.plan?.angle, 'Incoming programme angle',
    'the prepared programme plan transfers to the incoming session');
  let duplicateIntros = 0;
  await programme.maybeRunIntro({
    getDjRecap: () => null,
    getRecentOpeners: () => [],
    announce: async () => { duplicateIntros++; },
    announceExchange: async () => { duplicateIntros++; return true; },
    log: () => {},
  } as any, incoming);
  assert.equal(duplicateIntros, 0,
    'the queued handoff greeting owns the programme opening at the incoming roll');
  assert.equal(session.getProgramme()?.beats?.intro, true,
    'the standalone intro is durably marked covered rather than queued behind the handoff');
  session.markHandoffAired();
  assert.equal(session.boundaryHandoffStatus()?.state, 'aired');
  await settings.update({ shows: priorShows, schedule: priorSchedule } as never);
});

test('a queued final-track handoff survives a controller restart for re-rendering', async () => {
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming), true);
  session.markHandoffQueued();

  // The session writer is deliberately debounced in production. Once its
  // snapshot exists, recover() follows the same key-mismatch path a restart
  // after the actual clock boundary uses.
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await session.recover(incoming);

  assert.equal(session.boundaryHandoffStatus()?.state, 'queued');
  assert.equal(session.boundaryHandoffStatus()?.recovered, true);
  assert.ok(session.pendingHandoff(), 'the lost in-memory WAV pair is regenerated on the next queue cycle');
});

test('a refused final-track handoff remains armed for retry', async () => {
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming), true);

  const { deps } = generators();
  const realExchange = (queue as any).announceExchange;
  (queue as any).announceExchange = async () => false;
  try {
    await djAgent.runPersonaHandoff(queue, incoming, deps);
  } finally {
    (queue as any).announceExchange = realExchange;
  }

  assert.equal(session.boundaryHandoffStatus()?.state, 'armed',
    'a pause-owned seam cannot be recorded as though the handoff reached the voice queue');
  assert.ok(session.pendingHandoff(), 'the handoff remains available to the next eligible seam');
});

test('an armed handoff survives a restart that crosses the boundary', async () => {
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming, {
    id: 'final-track', title: 'Last Song', artist: 'Wren',
  }), true);

  await new Promise(resolve => setTimeout(resolve, 1_100));
  await session.recover(incoming);

  assert.equal(session.boundaryHandoffStatus()?.state, 'armed');
  assert.ok(session.pendingHandoff(),
    'the incoming session can still render a handoff that was only armed before restart');
});

test('an aired boundary handoff survives a restart without reopening the incoming show', async () => {
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming), true);
  session.attachBoundaryProgramme({
    status: 'ok', plan: { angle: 'Already introduced angle' }, beats: {}, introAiredAt: null,
  });
  session.markHandoffQueued();
  session.markHandoffAired();

  await new Promise(resolve => setTimeout(resolve, 1_100));
  await session.recover(incoming);

  assert.equal(session.getProgramme()?.plan?.angle, 'Already introduced angle',
    'the incoming programme plan remains attached after recovery');
  assert.equal(session.getSession()?.handoffAired, true,
    'the recovered incoming session remembers that its mic-pass already aired');
  assert.ok(session.getSession()?.rolledFrom,
    'the aired handoff remains visible as the reason the standalone intro is covered');
  let duplicateIntros = 0;
  await programme.maybeRunIntro({
    getDjRecap: () => null,
    getRecentOpeners: () => [],
    announce: async () => { duplicateIntros++; },
    announceExchange: async () => { duplicateIntros++; return true; },
    log: () => {},
  } as any, incoming);
  assert.equal(duplicateIntros, 0);
});

test('an armed handoff waits for confirmed playback of its final outgoing track', async () => {
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  const finalTrack = { id: 'final-track', title: 'Last Song', artist: 'Wren' };
  assert.equal(session.armBoundaryHandoff(incoming, finalTrack), true);

  assert.equal(session.boundaryHandoffReadyForTrack({
    id: 'preceding-track', title: 'One Song Early', artist: 'Wren',
  }), false, 'pair-drain look-ahead cannot speak over the preceding track');
  assert.equal(session.boundaryHandoffReadyForTrack(finalTrack), true,
    'the handoff becomes eligible when Liquidsoap confirms the final track');
  assert.equal(session.boundaryHandoffContextAt()?.toISOString(), incoming.at,
    'the later runner can reconstruct the incoming show context without rolling early');

  await session.maybeRoll(incoming);
  assert.equal(session.boundaryHandoffStatus()?.state, 'armed',
    'the wall-clock roll cannot discard the armed final-track confirmation');
  assert.equal(session.boundaryHandoffReadyForTrack(finalTrack), true,
    'the explicit final-track runner still owns the handoff after the roll');
});

test('the queue runs an armed handoff only while the recorded final track is live', async () => {
  await settings.update({
    personas: [WREN, GIGI], activePersonaId: WREN.id,
    djTalkOnlyBetweenTracks: true,
    tts: { ...settings.get().tts, enabled: false },
  } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  const finalTrack = { id: 'final-track', title: 'Last Song', artist: 'Wren' };
  assert.equal(session.armBoundaryHandoff(incoming, finalTrack), true);

  const calls: string[] = [];
  const deps = {
    getContext: async () => { calls.push('context'); return incoming; },
    preparePlan: async () => { calls.push('plan'); },
    runHandoff: async () => { calls.push(`handoff:${currentTalkAir()}`); },
  };
  queue.current = {
    track: { id: 'preceding-track', title: 'One Song Early', artist: 'Wren' },
    startedAt: new Date().toISOString(), source: 'ai',
  } as never;
  await (queue as any).runArmedBoundaryHandoff(deps);
  assert.deepEqual(calls, [], 'the preceding track cannot trigger the pair');

  queue.current = {
    track: finalTrack, startedAt: new Date().toISOString(), source: 'ai',
  } as never;
  await (queue as any).runArmedBoundaryHandoff(deps);
  assert.deepEqual(calls, ['context', 'plan', 'handoff:next-track']);
  await settings.update({
    djTalkOnlyBetweenTracks: false,
    tts: { ...settings.get().tts, enabled: true },
  } as never);
});

test('a handoff pair settles only after its final live-edge marker', async () => {
  await settings.update({ personas: [WREN, GIGI], activePersonaId: WREN.id } as never);
  const t0 = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, t0));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, t0 + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming), true);
  session.markHandoffQueued();

  let resolveSignoff!: (at: number) => void;
  let resolveGreeting!: (at: number) => void;
  const signoffAired = new Promise<number>(resolve => { resolveSignoff = resolve; });
  const greetingAired = new Promise<number>(resolve => { resolveGreeting = resolve; });

  (queue as any).onSpoken(
    { voiceId: 'signoff', clipMs: 1_000, aired: signoffAired },
    {
      kind: 'handoff', channel: 'say', text: 'That was the hour.',
      persona: WREN, meta: {}, legacy: false, settlesHandoff: false,
    },
  );
  (queue as any).onSpoken(
    { voiceId: 'greeting', clipMs: 1_000, aired: greetingAired },
    {
      kind: 'handoff', channel: 'say', text: 'The next show starts here.',
      persona: GIGI, meta: {}, legacy: false, settlesHandoff: true,
    },
  );

  resolveSignoff(Date.now());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.boundaryHandoffStatus()?.state, 'queued',
    'hearing the sign-off alone does not make the complete pair durable as aired');

  resolveGreeting(Date.now() + 1_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.boundaryHandoffStatus()?.state, 'aired',
    'the final line marker settles the complete pair');
});
