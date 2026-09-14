// Review regression for #1651 / PR #1652: a listener request can land while
// the pair-drain deadline pick is waiting on asynchronous agent selection.
//
// This deliberately drives the production runTrackEvent -> pickViaAgent ->
// runArtistGuard -> enqueuePick -> queue.push path. Only pickerAgent.run is
// deferred and made deterministic, so no model, station, or credentials are
// involved. The assertions characterize the current race without promising
// that the captured pick-cycle anchor remains the FIFO predecessor: the real
// queue order and the softer guard result stay visible for a separate fix.
//
// Run: npm test -- pair-drain-interleaving

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-pair-drain-interleaving-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { pickerAgent, runTrackEvent } = await import('../src/broadcast/dj-agent.js');
const session = await import('../src/broadcast/session.js');

after(() => {
  const q = queue as any;
  if (q._persistTimer) clearTimeout(q._persistTimer);
  if (q._recentPlaysTimer) clearTimeout(q._recentPlaysTimer);
  library.shutdown();
  rmSync(stateRoot, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let observed: {
  queueOrder: string[];
  guard: string | null;
  transition: Record<string, unknown> | null;
  eventPrompt: string | null;
} | null = null;

before(async () => {
  await settings.load();
  const personas = settings.get().personas.map((persona, index) =>
    index === 0 ? { ...persona, djMode: true } : persona);
  await settings.update({
    personas,
    maxTrackSeconds: 120,
    llm: { pickerAgent: true, dailyTokenCap: 0, artistVarietyWindow: 5 },
    transitions: { pairDrain: true, effects: { washout: true } },
  });

  const onAir = {
    id: 'on-air', title: 'On air', artist: 'Someone Else', duration: 300,
  };
  const held = {
    id: 'held', title: "Heads We're Dancing", artist: 'Kate Bush',
    duration: 300, bpm: 120,
  };
  const requested = {
    id: 'request', title: 'Blue in Green', artist: 'Bill Evans', duration: 320,
  };
  const agentPick = {
    id: 'agent-pick', title: 'Waltz for Debby', artist: 'Bill Evans', duration: 360,
  };

  const q = queue as any;
  q.current = { track: onAir, source: 'ai' };
  q.upcoming = [{ track: held, sent: false, queuedAt: new Date().toISOString() }];
  q.history = [];
  q.djLog = [];
  q._recentPlays = [];
  q._recentEffects = [];
  // Keep the real fire-and-forget drain call, but model a sender already busy
  // so this test never touches Liquidsoap's handoff files.
  q.senderBusy = true;

  const selectionStarted = deferred();
  const resumeSelection = deferred();
  const realRun = (pickerAgent as any).run;
  let eventPrompt: string | null = null;
  (pickerAgent as any).run = async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
    selectionStarted.resolve();
    eventPrompt = messages.at(-1)?.content ?? null;
    await resumeSelection.promise;
    return {
      object: {
        id: agentPick.id,
        reason: 'Continue with Bill Evans.',
        say: null,
        transition: 'normal',
      },
      steps: 1,
      toolCalls: [],
      extras: { seen: new Map([[agentPick.id, agentPick]]) },
    };
  };

  try {
    const ctx = {
      activeShow: null,
      clock: {},
      time: { period: 'day' },
      dominantMood: null,
    };
    session.start(ctx as any);
    const pick = runTrackEvent(queue, ctx, {
      wantLink: false,
      pickAnchor: held,
      anchorPrior: onAir,
    });

    await selectionStarted.promise;
    await queue.push({ track: requested, requestedBy: 'isolated-review-listener' });
    resumeSelection.resolve();
    await pick;
  } finally {
    (pickerAgent as any).run = realRun;
    q.senderBusy = false;
  }

  const queueOrder = queue.upcoming.map((item) => item.track.id);
  const guardLine = queue.djLog.find((entry) =>
    entry.kind === 'picker' && entry.message.includes('artist "Bill Evans"'));

  // This is the transition-ownership half of the report: after the request
  // interleaves, the held track really ends before the request, not before the
  // agent pick. applyMixTransition must therefore name the request as successor.
  queue.applyMixTransition(queue.upcoming[0]);
  const transitionLine = queue.djLog.find((entry) =>
    entry.kind === 'mix' && entry.message.includes('washout armed'));

  observed = {
    queueOrder,
    guard: guardLine?.message ?? null,
    transition: transitionLine?.meta ?? null,
    eventPrompt,
  };
  console.log(`[pair-drain-interleaving] observed ${JSON.stringify(observed)}`);
});

test('the paused selection resumes behind the interleaved request in FIFO order', () => {
  assert.ok(observed);
  assert.deepEqual(observed.queueOrder, ['held', 'request', 'agent-pick'],
    'the request inserted while selection was paused is the actual FIFO predecessor');
});

test('the held exit diagnostic names the request as its actual successor', () => {
  assert.ok(observed);
  assert.deepEqual(observed.transition, {
    exitTrackId: 'held',
    exitTrackTitle: "Heads We're Dancing",
    successorTrackId: 'request',
    successorTrackTitle: 'Blue in Green',
  }, 'the held exit diagnostic follows the actual queue pair');
});

test('the event prompt names the captured anchor without claiming current adjacency', () => {
  assert.ok(observed);
  assert.match(observed.eventPrompt ?? '', /Pick-cycle anchor: "Heads We're Dancing"/);
  assert.match(observed.eventPrompt ?? '', /intended predecessor for this selection/);
  assert.doesNotMatch(observed.eventPrompt ?? '', /Now playing "Heads We're Dancing"|immediately preceding|twice in a row/);
});

test('the interleaved Bill Evans request currently makes the candidate a soft spacing repeat', () => {
  assert.ok(observed);
  assert.match(observed.guard ?? '', /^recently-played artist "Bill Evans" allowed/,
    'this diagnostic pins the pre-existing tail/artist race for its separate fix');
});
