// The transition-ask ledger and what the model is told about it.
//
// Three things regress here, each silently:
//
//  - The ANTI-STREAK strip is targeted. A third identical ask in a row loses
//    that ask and nothing else; the blanket strip it replaced also took the
//    length cap's auto-washout off a capped pick, so the forced cut aired as a
//    bare crossfade — the exact sound the auto-arm exists to prevent.
//  - The HISTORY the model sees is not one pick stale under pair-drain. The
//    ledger fills at drain, and a held head only drains after its successor is
//    picked, so the pick being built never saw the ask right before it.
//  - The agent's per-pick EFFECT CLAUSE names only the gestures left switched
//    on, and is the historical text byte for byte when all six are.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-transition-ledger-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const session = await import('../src/broadcast/session.js');
const { TRANSITION_EFFECTS } = await import('../src/settings/vocab.js');
const { queue } = await import('../src/broadcast/queue.js');
const { effectEventClause, pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');

after(() => {
  const q = queue as any;
  if (q._persistTimer) clearTimeout(q._persistTimer);
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  library.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const q = queue as any;
type Track = Record<string, unknown>;

async function seedDjMode(extra: Record<string, unknown> = {}) {
  await settings.load();
  const personas = settings.get().personas.map((p, i) => (i === 0 ? { ...p, djMode: true } : p));
  await settings.update({
    personas,
    maxTrackSeconds: 0,
    transitions: { pairDrain: true, effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, true])) },
    ...extra,
  });
}

// One pick drained behind an on-air track, with a ledger already holding two
// of the same ask.
function drain(track: Track, ledger: string[]) {
  q.current = { track: { id: 'on-air', title: 'On air', artist: 'A', duration: 300 } };
  q.djLog = [];
  q._recentEffects = [...ledger];
  const pick = { track: { id: 'pick', title: 'Pick', artist: 'B', ...track } };
  q.upcoming = [pick];
  queue.applyMixTransition(pick as never);
  return pick.track as Track;
}

const mixLines = () => (q.djLog as Array<{ kind: string; message: string }>)
  .filter(e => e.kind === 'mix').map(e => e.message);

test('a capped pick whose ask is the third sweep keeps the cap\'s auto-washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, sweep: true }, ['sweep', 'sweep']);
  assert.equal(track.sweep, undefined, 'the repeated ask is stripped');
  assert.equal(track.washout, true, 'the forced cut still echoes out');
  assert.equal(track.washoutAuto, true, 'as the cap\'s own washout, not a model choice');
  assert.ok(mixLines().includes('sweep dropped (variety — third sweep in a row)'));
  assert.ok(mixLines().some(l => l.startsWith('washout armed (length-cap exit)')),
    'and the booth log says the washout is the cap\'s');
  assert.deepEqual(q._recentEffects, ['sweep', 'sweep', 'sweep'], 'the ask still counts toward the streak');
});

test('a capped pick whose ask is the third washout airs it as the cap\'s washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, washout: true }, ['washout', 'washout']);
  assert.equal(track.washout, true, 'the cap would have armed it anyway');
  assert.equal(track.washoutAuto, true, 'so it comes back as the deterministic auto-arm');
  assert.ok(mixLines().includes('washout dropped (variety — third washout in a row)'));
  assert.equal(q._recentEffects.at(-1), 'washout', 'the model\'s ask is what the ledger recorded');
});

test('a capped pick whose ask is the third loop falls back to the cap\'s washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, bpm: 120, loop: true }, ['loop', 'loop']);
  assert.equal(track.loop, undefined);
  assert.equal(track.washoutAuto, true, 'the stripped loop no longer keeps the auto-arm off');
});

test('a capped loop with no measured tempo also falls back to the cap\'s washout', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, loop: true }, []);
  assert.equal(track.loop, undefined, 'a loop needs a bar length');
  assert.equal(track.washoutAuto, true, 'and the cut is not left bare');
});

test('an armed loop on a capped pick still keeps the auto-washout off', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  const track = drain({ duration: 900, bpm: 120, loop: true }, ['sweep', 'normal']);
  assert.equal(track.loop, true);
  assert.equal(track.washout, undefined, 'the loop already owns that ending');
});

test('the re-armed cap washout still honours the washout switch', async () => {
  await seedDjMode({ maxTrackSeconds: 120 });
  await settings.update({ transitions: { effects: { washout: false } } });
  const track = drain({ duration: 900, sweep: true }, ['sweep', 'sweep']);
  assert.equal(track.sweep, undefined);
  assert.equal(track.washout, undefined, 'switched off means a plain crossfade, even on a capped exit');
});

test('an uncapped third sweep loses only the sweep, never the washout beside it', async () => {
  await seedDjMode();
  const track = drain({ duration: 300, sweep: true, washout: true }, ['sweep', 'sweep']);
  assert.equal(track.sweep, undefined, 'the counted ask goes');
  assert.equal(track.washout, true, 'the exit gesture on the same pick stays');
  assert.equal(track.washoutAuto, undefined, 'and stays the model\'s');
});

test('the history shows the held head\'s ask before it drains, and only once after', async () => {
  await seedDjMode();
  q.current = { track: { id: 'on-air', title: 'On air', artist: 'A', duration: 300 } };
  q._recentEffects = ['sweep', 'normal'];
  const held = { track: { id: 'held', title: 'Held', artist: 'B', duration: 300, washout: true }, aiPicked: true, sent: false };
  const request = { track: { id: 'req', title: 'Request', artist: 'C', duration: 300 }, requestedBy: 'listener', sent: false };
  q.upcoming = [held, request];

  assert.deepEqual(queue.recentTransitionChoices(), ['sweep', 'normal', 'washout'],
    'the held pick\'s ask is visible; the request is not invented as one');
  assert.deepEqual(q._recentEffects, ['sweep', 'normal'], 'reading it never touches the ledger itself');

  queue.applyMixTransition(held as never);
  assert.deepEqual(queue.recentTransitionChoices(), ['sweep', 'normal', 'washout'],
    'once the drain has ledgered it, the still-unsent item is not counted twice');
  held.sent = true;
  assert.deepEqual(queue.recentTransitionChoices(), ['sweep', 'normal', 'washout']);

  q._recentEffects = ['blend', 'normal', 'sweep', 'chop'];
  q.upcoming = [{ track: { id: 'x', title: 'X', artist: 'D', duration: 300, dissolve: true }, aiPicked: true, sent: false }];
  assert.deepEqual(queue.recentTransitionChoices(), ['normal', 'sweep', 'chop', 'dissolve'],
    'capped at the ledger\'s own length, newest kept');
});

test('a pair-drain pick event shows the model the held head\'s ask', async () => {
  await seedDjMode({ llm: { pickerAgent: true, dailyTokenCap: 0 } });
  const onAir = { id: 'on-air', title: 'On air', artist: 'Someone Else', duration: 300 };
  const held = { id: 'held', title: 'Held Head', artist: 'Held Artist', duration: 300, washout: true };
  const agentPick = { id: 'agent-pick', title: 'Next Pick', artist: 'Third Artist', duration: 300 };

  q.current = { track: onAir, source: 'ai' };
  q.upcoming = [{ track: held, aiPicked: true, sent: false, queuedAt: new Date().toISOString() }];
  q.history = [];
  q.djLog = [];
  q._recentPlays = [];
  q._recentEffects = ['sweep', 'normal'];
  // The pushed pick's fire-and-forget drain must not touch Liquidsoap's files.
  q.senderBusy = true;

  const realRun = (pickerAgent as any).run;
  let eventPrompt: string | null = null;
  (pickerAgent as any).run = async ({ messages }: { messages: Array<{ content: string }> }) => {
    eventPrompt = messages.at(-1)?.content ?? null;
    return {
      object: { id: agentPick.id, reason: 'A change of pace.', say: null, transition: 'normal' },
      steps: 1,
      toolCalls: [],
      extras: { seen: new Map([[agentPick.id, agentPick]]) },
    };
  };
  try {
    const ctx = { activeShow: null, clock: {}, time: { period: 'day' }, dominantMood: null };
    session.start(ctx as any);
    await runTrackEvent(queue, ctx, { wantLink: false, pickAnchor: held, anchorPrior: onAir });
  } finally {
    (pickerAgent as any).run = realRun;
    q.senderBusy = false;
  }
  assert.match(eventPrompt ?? '', /Your recent transition choices, oldest first: sweep, normal, washout —/,
    'the ask of the pick this one follows is in the turn that picks it');
});

const ALL_ON = ' Set "transition" by what THIS moment needs, per the TRANSITION EFFECTS guidance — "washout"/"loop" end your pick, "sweep"/"dissolve"/"chop" resolve a clash, "blend" only for an exceptionally locked pair, "normal" otherwise. Vary your craft: never the same transition three picks running, and if your last pick used an effect, lean "normal" now unless the moment clearly calls again.';

test('the per-pick effect clause names only the gestures left switched on', async () => {
  await seedDjMode();
  assert.equal(effectEventClause(), ALL_ON, 'all six on is the historical text byte for byte');
  assert.equal(effectEventClause(' NOTE'), `${ALL_ON} NOTE`, 'the history note rides on the end');

  await settings.update({ transitions: { effects: { sweep: false, dissolve: false, chop: false } } });
  const noClash = effectEventClause();
  assert.match(noClash, /— "washout"\/"loop" end your pick, "blend" only for an exceptionally locked pair, "normal" otherwise\./);
  assert.doesNotMatch(noClash, /resolve a clash|"sweep"|"dissolve"|"chop"/, 'a switched-off gesture is never offered');

  await settings.update({ transitions: { effects: { washout: false } } });
  assert.match(effectEventClause(), /— "loop" end your pick, "blend" only/);

  await settings.update({ transitions: { effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, false])) } });
  assert.equal(effectEventClause(' NOTE'), '', 'nothing left on reads exactly like DJ mode off');

  await settings.update({ transitions: { effects: Object.fromEntries(TRANSITION_EFFECTS.map(k => [k, true])) } });
  const personas = settings.get().personas.map(p => ({ ...p, djMode: false }));
  await settings.update({ personas });
  assert.equal(effectEventClause(), '', 'and DJ mode off is still no clause at all');
});
