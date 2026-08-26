// Regression coverage for issue #1479: prompt memory follows the DJ session,
// while the operator-facing booth log remains station-wide.
//
// The reported failure carried a ceiling-fan riff from one show into another
// because queue.getDjRecap()/getRecentOpeners() read Queue.djLog directly. The
// session already hard-rolls on a real show:<id> change, so prompt memory should
// read the current session's aired segment turns instead. Autonomous daypart
// changes are soft shifts and deliberately retain the same memory.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-prompt-memory-'));
process.env.STATE_DIR = root;

const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const scripts = await import('../src/llm/internal/prompts/scripts.js');

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function context(show: { id: string; name: string } | null, period = 'morning') {
  return {
    at: new Date().toISOString(),
    time: { period, vibe: period, mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    date: {},
    clock: {},
    listeners: 1,
    activeShow: show ? { ...show, topic: '', moods: ['calm'] } : null,
  } as any;
}

function recordVoice(kind: string, text: string, meta: Record<string, unknown> = {}) {
  queue.log(kind, text);
  session.appendTurn({ role: 'segment', kind, text, meta });
}

test('same-session prompt memory includes speech that actually aired', () => {
  queue.djLog = [];
  session.start(context({ id: 's_soft_start', name: 'The Soft Start Procedure' }));
  recordVoice('banter', 'The room is holding its breath.');

  assert.match(queue.getDjRecap() || '', /room is holding its breath/);
  assert.deepEqual(queue.getRecentOpeners(), ['The room is holding its']);
});

test('a hard show roll drops old speech from prompts but preserves the booth log', async () => {
  queue.djLog = [];
  session.start(context({ id: 's_soft_start', name: 'The Soft Start Procedure' }));
  recordVoice('banter', "The ceiling fan thinks it's an aircraft propeller.");

  await session.maybeRoll(context({ id: 's_cultural', name: 'Cultural Currents' }));
  recordVoice('handoff', 'Welcome to Cultural Currents.');

  const recap = queue.getDjRecap() || '';
  assert.match(recap, /Welcome to Cultural Currents/);
  assert.doesNotMatch(recap, /ceiling fan|aircraft propeller/i);
  assert.deepEqual(queue.getRecentOpeners(), ['Welcome to Cultural Currents.']);

  const window = session.windowMessages().map((m) => m.content).join('\n');
  assert.doesNotMatch(window, /ceiling fan|aircraft propeller/i);

  assert.ok(
    queue.djLog.some((entry) => /ceiling fan/i.test(entry.message)),
    'the operator booth log keeps the prior-show line',
  );
});

test('an autonomous soft shift keeps the running prompt memory', async () => {
  queue.djLog = [];
  session.start(context(null, 'early-morning'));
  recordVoice('link', 'A thread worth carrying into the next hour.');

  await session.maybeRoll(context(null, 'morning'));

  assert.match(queue.getDjRecap() || '', /thread worth carrying/);
  assert.deepEqual(queue.getRecentOpeners(), ['A thread worth carrying into']);
});

test('the incoming greeting acknowledges the presenter without ingesting their raw sign-off', () => {
  assert.equal(
    typeof (scripts as any).handoffGreetingPrompt,
    'function',
    'scripts exports the pure greeting prompt builder',
  );
  const prompt = (scripts as any).handoffGreetingPrompt({
    personaIn: { name: "Gigi 'La Divina' Castro" },
    personaOut: { name: 'Wren' },
    signoffText: "The ceiling fan has its own flight plan.",
    showIn: 'Cultural Currents',
    episodeAngle: null,
    context: null,
  });

  assert.match(prompt, /taking over the mic from Wren/);
  assert.match(prompt, /Cultural Currents/);
  assert.doesNotMatch(prompt, /ceiling fan|flight plan/i);
});

test("the outgoing DJ's sign-off still reads its own show's memory", async () => {
  queue.djLog = [];
  session.start(context({ id: 's_soft_start', name: 'The Soft Start Procedure' }));
  recordVoice('link', "The ceiling fan thinks it's an aircraft propeller.");

  // The mic-pass runs AFTER the roll, so the sign-off's recap comes from the
  // archived session — otherwise the outgoing DJ signs off with no memory of
  // the hour it just presented.
  await session.maybeRoll(context({ id: 's_cultural', name: 'Cultural Currents' }));

  assert.equal(queue.getDjRecap(), null, 'the fresh session starts clean');
  assert.match(queue.getDjRecap({ prior: true }) || '', /ceiling fan/i);
  assert.deepEqual(queue.getRecentOpeners(6, { prior: true }), ["The ceiling fan thinks it's"]);
});

test("the sign-off never becomes the incoming persona's prompt memory", async () => {
  queue.djLog = [];
  session.start(context({ id: 's_soft_start', name: 'The Soft Start Procedure' }));
  await session.maybeRoll(context({ id: 's_cultural', name: 'Cultural Currents' }));

  // queue.announce tags the sign-off with the OUTGOING persona; the greeting
  // that follows is the new session's own voice.
  recordVoice('handoff', 'The ceiling fan has its own flight plan.', {
    personaId: 'p_wren', personaName: 'Wren',
  });
  recordVoice('handoff', 'Welcome to Cultural Currents.');

  const recap = queue.getDjRecap() || '';
  assert.doesNotMatch(recap, /ceiling fan|flight plan/i);
  assert.match(recap, /Welcome to Cultural Currents/);
  assert.deepEqual(queue.getRecentOpeners(), ['Welcome to Cultural Currents.']);

  assert.ok(
    queue.djLog.some((entry) => /ceiling fan/i.test(entry.message)),
    'the operator booth log keeps the sign-off',
  );
});

test("a guest co-host's lines keep their attribution in the recap", () => {
  queue.djLog = [];
  const s = session.start(context({ id: 's_guest', name: 'Two Chairs' }));
  const hostId = s.persona?.id ?? null;

  recordVoice('banter', 'I brought the good coffee.', hostId ? { personaId: hostId } : {});
  recordVoice('banter', 'You brought the same coffee.', {
    personaId: 'p_guest', personaName: 'Sol',
  });

  const recap = queue.getDjRecap() || '';
  assert.match(recap, /Sol: You brought the same coffee/);
  assert.doesNotMatch(recap, /Sol: I brought the good coffee/);
});

test('a malformed persisted turn is skipped, not thrown on', () => {
  queue.djLog = [];
  session.start(context({ id: 's_broken', name: 'Recovered Session' }));
  // recover() validates that `messages` is an array, not each turn's shape —
  // getDjRecap runs synchronously inside POST /request, so this must not 500.
  session.appendTurn({ role: 'segment', kind: 'link', text: undefined as any });
  (session.getSession() as any).messages.push({ t: new Date().toISOString(), role: 'segment', kind: 'link' });
  recordVoice('link', 'Still on the air.');

  assert.match(queue.getDjRecap() || '', /Still on the air/);
  assert.deepEqual(queue.getRecentOpeners(), ['Still on the air.']);
});
