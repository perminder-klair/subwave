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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-prompt-memory-'));
process.env.STATE_DIR = root;

const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const scripts = await import('../src/llm/internal/prompts/scripts.js');
const { exchangeSegment } = await import('../src/broadcast/queue/pure.js');

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

// A turn with a chosen timestamp. appendTurn always stamps `now`, and the two
// tests below are about turns that are OLD.
function pushTurn(kind: string, text: string, agoMs: number) {
  (session.getSession() as any).messages.push({
    t: new Date(Date.now() - agoMs).toISOString(), role: 'segment', kind, text, meta: {},
  });
}

test('the recap window measures from the newest turn, not the oldest', () => {
  queue.djLog = [];
  session.start(context({ id: 's_long_run', name: 'The Long Run' }));
  // Session turns are stored oldest-first and reversed into prompt memory;
  // djLog, the source this replaced, was natively newest-first. getDjRecap
  // BREAKS on the first entry past its cutoff, so if that reverse is ever
  // dropped the oldest turn is examined first and the DJ silently gets no
  // memory at all — with every same-hour assertion in this file still passing.
  pushTurn('link', 'Three hours ago, in another mood entirely.', 3 * 60 * 60_000);
  pushTurn('link', 'An hour in, finding the thread.', 60 * 60_000);
  pushTurn('link', 'And that is where we are now.', 1_000);

  const recap = queue.getDjRecap() || '';
  assert.match(recap, /that is where we are now/);
  assert.match(recap, /finding the thread/);
  assert.doesNotMatch(recap, /another mood entirely/, 'past the 120-minute window');

  const lines = recap.split('\n');
  assert.match(lines[0], /that is where we are now/, 'newest line first');
  assert.deepEqual(queue.getRecentOpeners(), [
    'And that is where we',
    'An hour in, finding the',
    'Three hours ago, in another',
  ], 'openers carry no time cutoff of their own — only the recap does');
});

test('prompt memory survives a controller restart', async () => {
  queue.djLog = [];
  const ctx = context({ id: 's_resumed', name: 'Resumed Session' });
  // What recover() actually reads: a session.json written by the previous
  // process. The malformed turn is the reason promptMemoryEntries guards
  // `text` at all — nothing validates a turn's shape on the way back in.
  writeFileSync(join(root, 'session.json'), JSON.stringify({
    id: 's_persisted', kind: 'show', key: 'show:s_resumed',
    startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    ctxAt: new Date().toISOString(),
    endedAt: null,
    show: { id: 's_resumed', name: 'Resumed Session', topic: '' },
    persona: { id: 'p_host', name: 'The Host' },
    scenario: { period: 'morning', mood: 'calm', weather: null },
    handoff: null, programme: null,
    messages: [
      { t: new Date(Date.now() - 120_000).toISOString(), role: 'segment', kind: 'link', text: 'Said before the restart.', meta: {} },
      { t: new Date(Date.now() - 60_000).toISOString(), role: 'segment', kind: 'link', meta: {} },
    ],
  }));

  const resumed = await session.recover(ctx);
  assert.equal(resumed.id, 's_persisted', 'the persisted session was resumed, not replaced');
  assert.match(queue.getDjRecap() || '', /Said before the restart/);
  assert.deepEqual(queue.getRecentOpeners(), ['Said before the restart.']);
});

test('the 4h cap clears prompt memory the same way a show boundary does', async () => {
  queue.djLog = [];
  const ctx = context(null, 'morning');
  session.start(ctx);
  recordVoice('link', 'Said in hour one of a very long shift.');
  // MAX_SESSION_MS is the other hard roll. Same key, same daypart — only age
  // ends this session, and the soft-shift path must not swallow it.
  (session.getSession() as any).startedAt = new Date(Date.now() - 5 * 60 * 60_000).toISOString();

  await session.maybeRoll(ctx);

  assert.equal(queue.getDjRecap(), null, 'the fresh session starts clean');
  assert.match(queue.getDjRecap({ prior: true }) || '', /hour one of a very long shift/);
});

// --- the guest-attribution contract, end to end ----------------------------
// The test above synthesizes a guest turn's meta. These two pin who actually
// produces it: queue.announceExchange builds every rotated line through
// exchangeSegment, and queue.onSpoken is the one place that meta reaches the
// session. Without them, the rotation could stop stamping the speaker and a
// guest's words would silently become the host's own — with every assertion
// above still green.

test('a rotated exchange line is stamped with the voice that spoke it', () => {
  const seg = exchangeSegment(
    { persona: { id: 'p_guest', name: 'Sol' }, text: 'You brought the same coffee.' },
    'case-discussion',
  );
  assert.equal(seg.meta.personaId, 'p_guest', 'prompt memory and windowMessages key off this');
  assert.equal(seg.meta.personaName, 'Sol');
  assert.equal(seg.logText, 'Sol: You brought the same coffee.', 'the booth log names the speaker');
  assert.equal(seg.kind, 'case-discussion', 'custom co-hosted skill kinds preserve the exchange attribution path');
  assert.equal(seg.channel, 'say');
  assert.equal(seg.legacy, false, 'the exchange publishes ONE aggregate dj.say');

  // A line with no persona is the solo case — no attribution to invent.
  const solo = exchangeSegment({ persona: null, text: 'Just me in here.' }, 'banter');
  assert.equal(solo.logText, 'Just me in here.');
  assert.equal(solo.meta.personaId, undefined);
});

test('post-air bookkeeping carries that stamp into prompt memory', async () => {
  queue.djLog = [];
  session.start(context({ id: 's_guest_wired', name: 'Two Chairs' }));
  (session.getSession() as any).persona = { id: 'p_host', name: 'The Host' };

  // The real bookkeeping path, with only the mixer's air stamp faked — onSpoken
  // is what turns a SegmentDesc into a session turn.
  const spoke = (line: { persona: any; text: string }) => {
    const seg = exchangeSegment(line, 'banter');
    queue.onSpoken(
      { voiceId: 'v1', clipMs: 1000, aired: Promise.resolve(Date.now()) } as any,
      seg as any,
    );
  };
  spoke({ persona: { id: 'p_host', name: 'The Host' }, text: 'I brought the good coffee.' });
  spoke({ persona: { id: 'p_guest', name: 'Sol' }, text: 'You brought the same coffee.' });
  await new Promise((r) => setImmediate(r));

  const recap = queue.getDjRecap() || '';
  assert.match(recap, /Sol: You brought the same coffee/, "the guest's line keeps their name");
  assert.doesNotMatch(recap, /Sol: I brought the good coffee/);
  assert.match(recap, /\[banter\]: "I brought the good coffee/, "the host's own line is unprefixed");
});
