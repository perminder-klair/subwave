// Pins the one-boundary arbitration a cron skill meets when
// djTalkOnlyBetweenTracks is on (#2259 review). The slot planner holds every
// row while a rendered segment waits for the boundary, but a cron fire has no
// row, so the queue itself must refuse the displacement rather than drop a clip
// it already paid tokens and TTS for.
//
// Two rules are worth pinning here:
//
//  - A waiting segment keeps the boundary against another scheduled segment.
//    A clip past its age limit is dead, so it may be replaced, and a handoff
//    still takes the boundary by design.
//  - With the switch OFF the old ident rule stands: a fresh ident supersedes a
//    waiting one, exactly as before this fix.
//  - The rule is for SCHEDULED speech, which is speech inside a talk-air scope.
//    A manual trigger runs outside any scope (a Run now on a pause-and-talk show
//    reaches holdForNextTrack that way), so it keeps newer-wins.
//
// STATE_DIR is redirected before the first import, like talk-air.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-talk-hold-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { scheduledTalkAir, withTalkAir } = await import('../src/broadcast/talk-air.js');
// holdForNextTrack is synchronous; the scope wants a promise.
const scheduled = <T>(fn: () => T): Promise<T> => withTalkAir('next-track', async () => fn());
const { mayReplacePendingTalk, PENDING_VOICE_MAX_AGE_MS } =
  await import('../src/broadcast/queue/kinds.js');

const realSpeak = (queue as unknown as { _speak: unknown })._speak;
// The renderer is stubbed: the arbitration is what these tests pin, and fake
// TTS keeps them off the engine entirely.
const stubSpeak = () => {
  (queue as unknown as { _speak: unknown })._speak = async () => join(root, 'rendered.wav');
};

const clip = (text: string) => [{ text, wavPath: join(root, `${text}.wav`), persona: null, meta: {} }];
// White-box on purpose: the pending slot is the state under test, and the
// direct field reads are what keep this a unit test of the arbitration. The
// cast is for the `never` a same-scope `_pendingVoice = null` narrows to.
const pendingVoice = () =>
  (queue as unknown as { _pendingVoice: { kind: string; t: number } | null })._pendingVoice;
const pendingKind = (): string | undefined => pendingVoice()?.kind;

test('a waiting segment keeps the boundary against another scheduled segment', () => {
  const now = 1_000_000_000;
  const waiting = { kind: 'station-id', queuedAt: now - 1_000 };
  assert.equal(mayReplacePendingTalk('news', waiting, now), false,
    'a cron skill must not take the slot from a rendered ident');
  assert.equal(mayReplacePendingTalk('news', { kind: 'news', queuedAt: now - 1_000 }, now), false,
    'nor from another cron skill');
  assert.equal(mayReplacePendingTalk('handoff', waiting, now), true,
    'the mic-pass still names the show and supersedes what is waiting');
  assert.equal(
    mayReplacePendingTalk('news', { ...waiting, queuedAt: now - PENDING_VOICE_MAX_AGE_MS - 1 }, now),
    true,
    'a clip past its age limit is already dead, so the slot is free',
  );
});

test('the queue declines a second scheduled segment while the switch is on', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  queue._pendingVoice = null;
  let supersededAired: boolean | undefined;
  const accepted = await scheduled(() => queue.holdForNextTrack('station-id', clip('ident'), {
    onCompleted: aired => { supersededAired = aired; },
  }));
  assert.equal(accepted, true);
  assert.equal(await scheduled(() => queue.holdForNextTrack('news', clip('news'))), false,
    'no second segment is written over the one already waiting');
  assert.equal(pendingKind(), 'station-id', 'the ident keeps the boundary');
  assert.equal(supersededAired, undefined, 'and is not settled as a drop');
});

test('a manual trigger outside any scope still supersedes with the switch on', async () => {
  // A Run now on a pause-and-talk show reaches holdForNextTrack with no scope.
  // It has already paid for its script and TTS, and the operator asked for it,
  // so the one-boundary rule does not apply: newer wins, as it always did.
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  queue._pendingVoice = null;
  let supersededAired: boolean | undefined;
  await scheduled(() => queue.holdForNextTrack('station-id', clip('ident'), {
    onCompleted: aired => { supersededAired = aired; },
  }));
  assert.equal(queue.holdForNextTrack('news', clip('manual-news')), true,
    'the manual segment takes the boundary');
  assert.equal(pendingKind(), 'news');
  assert.equal(supersededAired, false, 'and the scheduled ident is settled as superseded');
  queue._pendingVoice = null;
});

test('a stale waiting segment is replaced rather than blocking the fire', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  queue._pendingVoice = null;
  await scheduled(() => queue.holdForNextTrack('station-id', clip('ident')));
  const held = pendingVoice();
  if (held) held.t = Date.now() - PENDING_VOICE_MAX_AGE_MS - 1;
  assert.equal(await scheduled(() => queue.holdForNextTrack('news', clip('news'))), true);
  assert.equal(pendingKind(), 'news');
});

test('the switch off keeps the ident replacement rule', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: false } as never);
  queue._pendingVoice = null;
  let supersededAired: boolean | undefined;
  queue.holdForNextTrack('station-id', clip('old-ident'), {
    onCompleted: aired => { supersededAired = aired; },
  });
  assert.equal(queue.holdForNextTrack('station-id', clip('fresh-ident')), true);
  assert.equal(pendingKind(), 'station-id');
  assert.equal(supersededAired, false, 'the waiting ident is dropped exactly as before');
  queue._pendingVoice = null;
});

test('a cron fire reaching announce() is refused, and the waiting clip survives', async () => {
  // The path a cron fire actually takes after the fix: scheduledTalkAir() scope
  // → announce() → placement → holdForNextTrack. No TTS here — the render is
  // stubbed, because the arbitration is what this pins.
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  stubSpeak();
  queue._pendingVoice = null;
  queue.holdForNextTrack('station-id', clip('ident'));

  const outcome = await withTalkAir(scheduledTalkAir(), () => queue.announce('Fresh news.', 'news'));
  assert.equal(scheduledTalkAir(), 'next-track');
  assert.equal(outcome.accepted, false, 'the fire is refused rather than rendered over the ident');
  assert.equal(await outcome.completed, false);
  assert.equal(pendingKind(), 'station-id', 'the waiting ident keeps the boundary');
});

test('with the switch off a next-track announce still replaces, as before', async () => {
  // Positive control for the test above: the rule is keyed on the setting, not
  // on the scope being present.
  await settings.update({ djTalkOnlyBetweenTracks: false } as never);
  stubSpeak();
  queue._pendingVoice = null;
  queue.holdForNextTrack('station-id', clip('ident'));

  const outcome = await withTalkAir('next-track', () => queue.announce('Fresh news.', 'news'));
  assert.equal(outcome.accepted, true);
  assert.equal(pendingKind(), 'news', 'the old ident is superseded exactly as before');
});

test.after(async () => {
  queue._pendingVoice = null;
  (queue as unknown as { _speak: unknown })._speak = realSpeak;
  await removeTempDir(root);
});
