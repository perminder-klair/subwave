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

function recordVoice(kind: string, text: string) {
  queue.log(kind, text);
  session.appendTurn({ role: 'segment', kind, text });
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
