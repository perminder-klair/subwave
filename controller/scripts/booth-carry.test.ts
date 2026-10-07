// Issue #1690: the listener booth must not go blank at a show boundary.
//
// A hard session roll starts the new session with `messages: []`, and every
// listener booth reads GET /session, so passive displays (Apple TV, wall
// screens) showed an empty booth the moment a new show began. The fix keeps a
// bounded, display-only tail of the outgoing show on the new session
// (`Session.boothCarry`) and composes it into GET /session behind a
// show-boundary separator.
//
// The hard constraint (#1479): carried turns are display only. They must
// never become the incoming DJ's prompt memory, so this file also pins that
// promptMemory(), priorPromptMemory() semantics, windowMessages(),
// queue.getDjRecap() and queue.getRecentOpeners() never see them.
//
// Run: npm test -- booth-carry

import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-booth-carry-'));
process.env.STATE_DIR = root;

const carry = await import('../src/broadcast/booth-carry.js');
const session = await import('../src/broadcast/session.js');
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { default: express } = await import('express');
const { router: publicRouter } = await import('../src/routes/public.js');

after(() => rmSync(root, { recursive: true, force: true }));

const MIN = 60_000;
// 2026-10-07T20:00:00Z — a fixed boundary so the pure tests never depend on now.
const BOUNDARY_MS = Date.UTC(2026, 9, 7, 20, 0, 0);
const BOUNDARY = new Date(BOUNDARY_MS).toISOString();

function turn(role: string, kind: string, text: string, minutesBefore: number, meta: Record<string, unknown> = {}) {
  return { t: new Date(BOUNDARY_MS - minutesBefore * MIN).toISOString(), role, kind, text, meta };
}

function outgoing(messages: ReturnType<typeof turn>[], key = 'show:s_bob') {
  return {
    id: 'sess_prev',
    key,
    show: { id: 's_bob', name: 'Bob After Dark' },
    persona: { id: 'p_bob', name: 'Bob' },
    messages,
  };
}

const incoming = { key: 'show:s_midnight', ctxAt: BOUNDARY, startedAt: BOUNDARY };

// --- snapshotBoothCarry ------------------------------------------------------

test('the carry keeps spoken, reasoning and track turns and drops events, sfx and empty text', () => {
  const prev = outgoing([
    turn('event', 'scenario', 'Show "Bob After Dark" begins. Host: Bob.', 20),
    turn('event', 'pick', 'Now playing "X" by Y. Pick the track to play next.', 9),
    turn('dj', 'pick', 'Something warm next.', 8),
    turn('track', 'play', '▶ Warm Song — The Band', 7),
    turn('segment', 'sfx', 'airhorn', 6),
    turn('segment', 'link', '', 5),
    turn('segment', 'link', 'That was the warm one.', 4),
  ]);
  const snap = carry.snapshotBoothCarry(prev, incoming, BOUNDARY_MS);
  assert.ok(snap);
  assert.deepEqual(snap.turns.map((t) => t.text), [
    'Something warm next.',
    '▶ Warm Song — The Band',
    'That was the warm one.',
  ]);
});

test('the carry is capped to the newest 12 eligible turns, oldest first', () => {
  const messages = Array.from({ length: 20 }, (_, i) => turn('segment', 'link', `line ${i}`, 20 - i));
  const snap = carry.snapshotBoothCarry(outgoing(messages), incoming, BOUNDARY_MS);
  assert.equal(carry.BOOTH_CARRY_MAX_TURNS, 12);
  assert.equal(snap?.turns.length, 12);
  assert.equal(snap?.turns[0].text, 'line 8');
  assert.equal(snap?.turns[11].text, 'line 19');
});

test('turns older than the 30 minute lookback before the boundary are not carried', () => {
  const prev = outgoing([
    turn('segment', 'link', 'forty minutes ago', 40),
    turn('segment', 'link', 'thirty-one minutes ago', 31),
    turn('segment', 'link', 'twenty-nine minutes ago', 29),
    { t: 'not a date', role: 'segment', kind: 'link', text: 'undated', meta: {} },
  ]);
  const snap = carry.snapshotBoothCarry(prev, incoming, BOUNDARY_MS);
  assert.deepEqual(snap?.turns.map((t) => t.text), ['twenty-nine minutes ago']);
});

test('nothing eligible means no carry at all', () => {
  const prev = outgoing([
    turn('event', 'scenario', 'Show begins.', 3),
    turn('segment', 'link', 'too old', 90),
  ]);
  assert.equal(carry.snapshotBoothCarry(prev, incoming, BOUNDARY_MS), null);
  assert.equal(carry.snapshotBoothCarry({ ...outgoing([]), messages: undefined as any }, incoming, BOUNDARY_MS), null);
});

test('carried copies are marked and attributed without mutating the outgoing session', () => {
  const guest = turn('segment', 'banter', 'Guest line.', 3, { personaId: 'p_sol', personaName: 'Sol' });
  const host = turn('segment', 'link', 'Host line.', 2);
  const track = turn('track', 'play', '▶ Song', 1);
  const prev = outgoing([guest, host, track]);
  const before = structuredClone(prev);

  const snap = carry.snapshotBoothCarry(prev, incoming, BOUNDARY_MS)!;
  assert.deepEqual(prev, before, 'the outgoing session is untouched');
  assert.equal(snap.fromSessionId, 'sess_prev');
  assert.equal(snap.fromShow, 'Bob After Dark');
  assert.equal(snap.fromPersona, 'Bob');
  assert.equal(snap.boundaryAt, BOUNDARY);
  assert.equal(snap.sameShow, false);

  const [g, h, tr] = snap.turns;
  assert.deepEqual(g.meta, { personaId: 'p_sol', personaName: 'Sol', carried: true, carriedFrom: 'sess_prev' });
  assert.deepEqual(h.meta, { personaName: 'Bob', carried: true, carriedFrom: 'sess_prev' });
  assert.deepEqual(tr.meta, { carried: true, carriedFrom: 'sess_prev' }, 'tracks get no speaker');
  assert.equal(h.t, host.t, 'the original timestamp is kept');
});

test('a same-key roll (the 4h cap) carries plain copies: no carried flag, no boundary', () => {
  const prev = outgoing([turn('segment', 'link', 'Still the same show.', 2)], 'show:s_midnight');
  const snap = carry.snapshotBoothCarry(prev, incoming, BOUNDARY_MS)!;
  assert.equal(snap.sameShow, true);
  assert.deepEqual(snap.turns[0].meta, {});

  const feed = carry.composeBoothFeed(
    { messages: [turn('event', 'scenario', 'Show begins.', 0)], boothCarry: snap, show: { name: 'Midnight' }, persona: null },
    BOUNDARY_MS + MIN,
    () => '22:00',
  );
  assert.deepEqual(feed.map((t) => t.text), ['Still the same show.', 'Show begins.']);
  assert.ok(!feed.some((t) => t.kind === 'show-boundary'));
});

test('a carry never chains: only the immediately previous show is snapshotted', () => {
  const first = carry.snapshotBoothCarry(outgoing([turn('segment', 'link', 'From show one.', 5)]), incoming, BOUNDARY_MS);
  const middle = {
    id: 'sess_middle', key: 'show:s_midnight', show: { name: 'Midnight' }, persona: { id: 'p_m', name: 'Mae' },
    messages: [turn('segment', 'link', 'From show two.', 1)],
    boothCarry: first,
  };
  const snap = carry.snapshotBoothCarry(middle, { key: 'show:s_dawn', ctxAt: BOUNDARY, startedAt: BOUNDARY }, BOUNDARY_MS);
  assert.deepEqual(snap?.turns.map((t) => t.text), ['From show two.']);
});

// --- composeBoothFeed --------------------------------------------------------

function liveSession(boothCarry: unknown) {
  return {
    messages: [
      turn('event', 'scenario', 'Show "Midnight Bob’s Minor Incidents" begins. Host: Mae.', 0),
      turn('segment', 'sfx', 'airhorn', -1),
      turn('segment', 'link', 'Welcome in.', -2),
    ],
    boothCarry: boothCarry as any,
    show: { name: 'Midnight Bob’s Minor Incidents' },
    persona: { name: 'Mae' },
  };
}

test('the feed is carried turns, then the show-boundary separator, then the live session', () => {
  const snap = carry.snapshotBoothCarry(outgoing([
    turn('segment', 'link', 'Goodnight from Bob.', 2),
    turn('track', 'play', '▶ Last Song', 1),
  ]), incoming, BOUNDARY_MS);

  const feed = carry.composeBoothFeed(liveSession(snap), BOUNDARY_MS + 5 * MIN, () => '22:00');
  assert.deepEqual(feed.map((t) => `${t.role}/${t.kind}: ${t.text}`), [
    'segment/link: Goodnight from Bob.',
    'track/play: ▶ Last Song',
    'event/show-boundary: 22:00 · Midnight Bob’s Minor Incidents',
    'event/scenario: Show "Midnight Bob’s Minor Incidents" begins. Host: Mae.',
    'segment/link: Welcome in.',
  ]);
  const separator = feed[2];
  assert.equal(separator.t, BOUNDARY);
  assert.deepEqual(separator.meta, {
    boundary: {
      at: BOUNDARY,
      show: 'Midnight Bob’s Minor Incidents',
      persona: 'Mae',
      fromShow: 'Bob After Dark',
      fromSessionId: 'sess_prev',
    },
  });
});

test('the separator falls back to the incoming host, then to "On air"', () => {
  const snap = carry.snapshotBoothCarry(outgoing([turn('segment', 'link', 'Bye.', 1)]), incoming, BOUNDARY_MS);
  const hostOnly = carry.composeBoothFeed({ ...liveSession(snap), show: null }, BOUNDARY_MS, () => '22:00');
  assert.equal(hostOnly.find((t) => t.kind === 'show-boundary')?.text, '22:00 · Mae');
  const nobody = carry.composeBoothFeed({ ...liveSession(snap), show: null, persona: null }, BOUNDARY_MS, () => '22:00');
  assert.equal(nobody.find((t) => t.kind === 'show-boundary')?.text, '22:00 · On air');
});

test('after the 30 minute TTL, or with no carry, the feed is exactly the old non-sfx messages', () => {
  const live = liveSession(null);
  const old = live.messages.filter((m) => m.kind !== 'sfx');
  assert.deepEqual(carry.composeBoothFeed(live, BOUNDARY_MS, () => '22:00'), old);

  const snap = carry.snapshotBoothCarry(outgoing([turn('segment', 'link', 'Bye.', 1)]), incoming, BOUNDARY_MS);
  const withCarry = liveSession(snap);
  assert.equal(carry.composeBoothFeed(withCarry, BOUNDARY_MS + 30 * MIN, () => '22:00').length, old.length + 2,
    'still served at exactly the TTL');
  assert.deepEqual(carry.composeBoothFeed(withCarry, BOUNDARY_MS + 30 * MIN + 1, () => '22:00'), old);
});

// --- session integration and the #1479 prompt-memory boundary --------------

function context(show: { id: string; name: string }) {
  return {
    at: new Date().toISOString(),
    time: { period: 'night', vibe: 'night', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm',
    date: {}, clock: {}, listeners: 1,
    activeShow: { ...show, topic: '', moods: ['calm'] },
  } as any;
}

const BOB = { id: 's_bob', name: 'Bob After Dark' };
const MIDNIGHT = { id: 's_midnight', name: 'Midnight Bob’s Minor Incidents' };

async function scheduleAllWeek(t: TestContext, showId: string) {
  const prior = structuredClone({ shows: settings.get().shows, schedule: settings.get().schedule });
  t.after(() => settings.update(prior));
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(showId);
  const personaId = settings.get().personas[0].id;
  await settings.update({
    shows: [{ ...BOB, topic: '', personaId }, { ...MIDNIGHT, topic: '', personaId }],
    schedule: week,
  } as never);
}

function recordVoice(kind: string, text: string) {
  queue.log(kind, text);
  session.appendTurn({ role: 'segment', kind, text });
}

const OUTGOING_TEXT = /ceiling fan|aircraft propeller|warm one/i;

test('a hard roll carries the outgoing tail for display but never into prompt memory', async () => {
  queue.djLog = [];
  session.start(context(BOB));
  recordVoice('banter', "The ceiling fan thinks it's an aircraft propeller.");
  session.appendTurn({ role: 'track', kind: 'play', text: '▶ Warm Song — The Band' });
  recordVoice('link', 'That was the warm one.');

  const next = await session.maybeRoll(context(MIDNIGHT));

  assert.deepEqual(next.messages.map((m) => m.kind), ['scenario'], 'the live session starts clean');
  assert.deepEqual(next.boothCarry?.turns.map((m) => m.text), [
    "The ceiling fan thinks it's an aircraft propeller.",
    '▶ Warm Song — The Band',
    'That was the warm one.',
  ]);
  assert.ok(next.boothCarry?.turns.every((m) => m.meta.carried === true));

  assert.equal(queue.getDjRecap(), null, 'the incoming recap is empty');
  assert.deepEqual(queue.getRecentOpeners(), []);
  assert.deepEqual(session.promptMemory(), []);
  const window = session.windowMessages().map((m) => m.content).join('\n');
  assert.doesNotMatch(window, OUTGOING_TEXT);
  // The outgoing sign-off's own memory is the archived session, not the carry.
  const prior = session.priorPromptMemory().map((e) => e.message);
  assert.deepEqual(prior, ['That was the warm one.', "The ceiling fan thinks it's an aircraft propeller."]);

  // Fresh speech in the new show still reaches prompt memory, alone.
  recordVoice('handoff', 'Welcome to Midnight.');
  assert.match(queue.getDjRecap() || '', /Welcome to Midnight/);
  assert.doesNotMatch(queue.getDjRecap() || '', OUTGOING_TEXT);
  assert.deepEqual(queue.getRecentOpeners(), ['Welcome to Midnight.']);
});

test('the carry is persisted and survives a same-run restart', async (t) => {
  await scheduleAllWeek(t, MIDNIGHT.id);
  session.start(context(BOB));
  recordVoice('link', 'That was the warm one.');
  const rolled = await session.maybeRoll(context(MIDNIGHT));

  const onDisk = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8'));
  assert.equal(onDisk.id, rolled.id);
  assert.deepEqual(onDisk.boothCarry?.turns.map((m: any) => m.text), ['That was the warm one.']);

  const resumed = await session.recover(context(MIDNIGHT));
  assert.equal(resumed.id, rolled.id, 'same session resumed');
  assert.deepEqual(resumed.boothCarry?.turns.map((m) => m.text), ['That was the warm one.']);
  assert.doesNotMatch(queue.getDjRecap() || '', OUTGOING_TEXT);
});

test('a restart past the boundary builds the carry from the stored outgoing session', async (t) => {
  await scheduleAllWeek(t, MIDNIGHT.id);
  writeFileSync(join(root, 'session.json'), JSON.stringify({
    id: 'sess_stored', kind: 'show', key: 'show:s_bob',
    startedAt: new Date(Date.now() - 60 * MIN).toISOString(),
    ctxAt: new Date(Date.now() - 60 * MIN).toISOString(),
    endedAt: null,
    show: { id: BOB.id, name: BOB.name, topic: '' },
    persona: { id: 'p_bob', name: 'Bob' },
    scenario: { period: 'night', mood: 'calm', weather: null },
    handoff: null, programme: null,
    messages: [
      { t: new Date(Date.now() - 50 * MIN).toISOString(), role: 'segment', kind: 'link', text: 'Too long ago.', meta: {} },
      { t: new Date(Date.now() - 3 * MIN).toISOString(), role: 'segment', kind: 'link', text: 'Just before the restart.', meta: {} },
    ],
  }));

  const next = await session.recover(context(MIDNIGHT));
  assert.notEqual(next.id, 'sess_stored');
  assert.deepEqual(next.messages.map((m) => m.kind), ['scenario']);
  assert.deepEqual(next.boothCarry?.turns.map((m) => m.text), ['Just before the restart.']);
  assert.equal(next.boothCarry?.turns[0].meta.personaName, 'Bob');
  assert.equal(queue.getDjRecap(), null);
  assert.deepEqual(session.promptMemory(), []);
});

test('GET /session serves carry, separator and live turns; the session header is unchanged', async (t) => {
  session.start(context(BOB));
  recordVoice('link', 'That was the warm one.');
  const next = await session.maybeRoll(context(MIDNIGHT));
  session.appendTurn({ role: 'segment', kind: 'sfx', text: 'airhorn' });

  const app = express();
  app.use(publicRouter);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;

  const body = await (await fetch(`http://127.0.0.1:${port}/session`)).json() as any;
  assert.deepEqual(body.session, {
    id: next.id, kind: 'show', key: 'show:s_midnight', startedAt: next.startedAt, show: MIDNIGHT.name,
  });
  assert.deepEqual(body.messages.map((m: any) => m.kind), ['link', 'show-boundary', 'scenario']);
  assert.equal(body.messages[0].meta.carried, true);
  assert.match(body.messages[1].text, /^\d{1,2}:\d{2}( [ap]m)? · Midnight Bob’s Minor Incidents$/);
  assert.equal(body.messages[1].meta.boundary.fromShow, BOB.name);
});

for (const handoff of ['persisted', 'legacy', 'absent', 'unrelated', 'stale'] as const) {
  test(`23:20 recovery keeps the 23:00 boundary (${handoff} handoff)`, async (t) => {
    const boundaryMs = Date.parse('2026-10-07T23:00:00Z');
    const restartMs = boundaryMs + 20 * MIN;
    t.mock.timers.enable({ apis: ['Date'], now: restartMs });
    const prior = structuredClone({
      timezone: settings.get().timezone, shows: settings.get().shows,
      schedule: settings.get().schedule, scheduleOverride: settings.get().scheduleOverride,
    });
    t.after(() => settings.update(prior));
    const week: Record<number, Array<string | null>> = {};
    for (let day = 0; day < 7; day++) week[day] = Array(24).fill(null);
    week[3][22] = BOB.id;
    week[3][23] = MIDNIGHT.id;
    const personaId = settings.get().personas[0].id;
    await settings.update({
      timezone: 'UTC', schedule: week, scheduleOverride: null,
      shows: [{ ...BOB, topic: '', personaId }, { ...MIDNIGHT, topic: '', personaId }],
    });
    const stored = session.start({ ...context(BOB), at: '2026-10-07T22:00:00Z' });
    stored.messages = [
      { t: '2026-10-07T22:29:00Z', role: 'segment', kind: 'link', text: 'Outside lookback.', meta: {} },
      { t: '2026-10-07T22:45:00Z', role: 'segment', kind: 'link', text: 'Eligible outgoing line.', meta: {} },
      { t: '2026-10-07T22:58:00Z', role: 'segment', kind: 'link', text: 'Final outgoing line.', meta: {} },
    ];
    if (handoff !== 'absent') {
      stored.boundaryHandoff = {
        personaId, personaName: 'Bob', showName: BOB.name,
        incomingPersonaId: personaId, incomingPersonaName: 'Mae', incomingShowName: MIDNIGHT.name,
        targetKey: handoff === 'unrelated' ? 'show:s_other' : `show:${MIDNIGHT.id}`,
        boundaryAt: handoff === 'legacy' ? null : handoff === 'stale' ? boundaryMs - 24 * 60 * MIN : boundaryMs,
        contextAt: handoff === 'stale' ? '2026-10-06T23:00:00Z' : '2026-10-07T23:00:00Z',
        takeoverStartedAt: null, aired: true,
      };
    }
    writeFileSync(join(root, 'session.json'), JSON.stringify(stored));

    const next = await session.recover({ ...context(MIDNIGHT), at: new Date(restartMs).toISOString() });
    assert.notEqual(next.id, stored.id);
    assert.equal(next.boothCarry?.boundaryAt, '2026-10-07T23:00:00.000Z');
    assert.deepEqual(next.boothCarry?.turns.map(m => m.text), ['Eligible outgoing line.', 'Final outgoing line.']);
    const feed = carry.composeBoothFeed(next, restartMs, () => '23:00');
    assert.equal(feed.find(m => m.kind === 'show-boundary')?.text, `23:00 · ${MIDNIGHT.name}`);
    assert.deepEqual(carry.composeBoothFeed(next, boundaryMs + 30 * MIN + 1, () => '23:00'), next.messages);
    assert.deepEqual(session.promptMemory(), []);
    assert.equal(queue.getDjRecap(), null);
    assert.deepEqual(queue.getRecentOpeners(), []);
    assert.doesNotMatch(session.windowMessages().map(m => m.content).join('\n'), /outgoing line/i);
    const disk = JSON.parse(readFileSync(join(root, 'session.json'), 'utf8'));
    assert.equal(disk.boothCarry.boundaryAt, next.boothCarry?.boundaryAt);
  });
}
