// The WIRING of the persona mic-pass: which prompt memory each half is handed.
//
// prompt-memory-boundary.test.ts pins the selection policy — what belongs to a
// session and what a hard roll drops. This file pins how runPersonaHandoff
// composes it, which is where the two sides diverge and the half that was
// previously only verifiable by reading:
//
//   - The sign-off closes the show that just ENDED. maybeRoll has already
//     hard-rolled by the time the mic-pass runs (it is driven off pendingHandoff
//     on the FRESH session), so reading the live session hands the outgoing DJ
//     an empty recap of an hour it just presented.
//   - The greeting opens the show that just STARTED, and must NOT inherit that
//     memory — a clean slate at the boundary is the point of #1479.
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
  const seen: Record<string, { recap: string | null; recentOpeners: string[] }> = {};
  return {
    seen,
    deps: {
      generateSignoff: async ({ recap, recentOpeners }: any) => {
        seen.signoff = { recap: recap ?? null, recentOpeners: recentOpeners ?? [] };
        return 'That was the hour. Gigi has the next one.';
      },
      generateHandoffGreeting: async ({ recap, recentOpeners }: any) => {
        seen.greeting = { recap: recap ?? null, recentOpeners: recentOpeners ?? [] };
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
  (queue as any).announce = async (text: string, _kind: string, opts: any = {}) => {
    announced.push({ text, personaId: opts?.meta?.personaId });
  };
  try {
    await djAgent.runPersonaHandoff(queue, context({ id: 's_cultural', name: 'Cultural Currents' }, Date.now()), deps);
  } finally {
    (queue as any).announce = realAnnounce;
  }

  assert.ok(seen.signoff, 'the sign-off was generated');
  assert.ok(seen.greeting, 'the greeting was generated');

  // The outgoing DJ still remembers its own hour...
  assert.match(seen.signoff.recap || '', /ceiling fan/i);
  assert.deepEqual(seen.signoff.recentOpeners, ["The ceiling fan thinks it's"]);

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
