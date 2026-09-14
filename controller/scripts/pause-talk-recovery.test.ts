// Pause-and-talk commits a real silence item to Liquidsoap. These tests pin the
// two failure boundaries around that commit: a controller restart must recover
// the matching voice, and the pending slot must remain owned until that voice
// has actually joined the serialised say queue.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-pause-recovery-'));
process.env.STATE_DIR = root;
const fakePiper = join(root, 'fake-piper.sh');
const fakePiperWav = join(root, 'fake-piper.wav');
writeFileSync(fakePiper, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output_file" ]; then cp "$FAKE_PIPER_WAV" "$2"; exit 0; fi
  shift
done
exit 2
`);
chmodSync(fakePiper, 0o755);
process.env.PIPER_BIN = fakePiper;
process.env.FAKE_PIPER_WAV = fakePiperWav;

const { config } = await import('../src/config.js');
const { PAUSE_TALK_COMMIT_FILE, writePauseTalkCommit, writeSilentWav } = await import('../src/audio/wav-silence.js');
const { queue } = await import('../src/broadcast/queue.js');
const { voiceUri } = await import('../src/broadcast/queue/voice-io.js');
const settings = await import('../src/settings.js');
const { withTalkAir } = await import('../src/broadcast/talk-air.js');

const voice = join(root, 'voice.wav');
await writeSilentWav(voice, 25);
await writeSilentWav(fakePiperWav, 6_000);

const clip = (text = 'The held line') => ({ text, wavPath: voice, persona: null, meta: {} });
const item = () => ({ track: { id: 'next', title: 'Next', artist: 'Artist', duration: 180 } }) as any;
const waitFor = async (fn: () => boolean, timeoutMs = 1_000) => {
  const until = Date.now() + timeoutMs;
  while (!fn() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fn(), true);
};

function clearPauseProtocol() {
  for (const path of [
    config.liquidsoap.sayFile,
    config.liquidsoap.voicePlayingFile,
    config.liquidsoap.pauseVoiceAcceptedFile,
    config.liquidsoap.pauseVoiceStartedFile,
    config.liquidsoap.pauseTalkPlayingFile,
  ]) rmSync(path, { force: true });
}

function acceptAndStart(pauseId: string) {
  rmSync(config.liquidsoap.sayFile, { force: true });
  writeFileSync(config.liquidsoap.pauseVoiceAcceptedFile, JSON.stringify({
    deliveryId: pauseId, acceptedAt: Date.now() / 1000,
  }));
  writeFileSync(config.liquidsoap.pauseVoiceStartedFile, JSON.stringify({
    deliveryId: pauseId, startedAt: Date.now() / 1000,
  }));
}

async function recoverCommittedPause(pauseId: string) {
  clearPauseProtocol();
  rmSync(PAUSE_TALK_COMMIT_FILE, { force: true });
  (queue as any)._pendingVoice = null;
  await writePauseTalkCommit({
    kind: 'news', clips: [clip(`Voice ${pauseId}`)], daypart: null,
    exchange: false, t: Date.now(), pauseTalk: true, pauseId,
    pauseArmedAt: Date.now(), pauseIncomingCrossMs: 0,
    pauseSilenceMs: 10_000, pauseTrackKey: 'id:next', pauseDelaySec: 6.5,
  });
  queue.recover();
  writeFileSync(config.liquidsoap.pauseTalkPlayingFile, JSON.stringify({
    pauseId, startedAt: Date.now() / 1000,
  }));
}

test('a committed pause voice is recovered even when no queue snapshot exists', async () => {
  rmSync(config.queue.file, { force: true });
  (queue as any)._pendingVoice = null;
  assert.equal(queue.holdForNextTrack('news', [clip()], { pauseTalk: true }), true);
  const next = item();
  assert.equal(await queue.maybePushPauseTalk(next), true);
  assert.ok(existsSync(PAUSE_TALK_COMMIT_FILE), 'the voice commitment is durable before restart');

  // Simulate a controller process losing its heap. The queue snapshot is
  // deliberately absent: the sidecar is the commit, not a best-effort debounce.
  (queue as any)._pendingVoice = null;
  queue.recover();
  assert.deepEqual(queue.pendingVoiceTalk(), { kind: 'news', queuedAt: (queue as any)._pendingVoice.t });
  assert.equal((queue as any)._pendingVoice.pauseId.length, 16);
  assert.equal(await queue.maybePushPauseTalk(next), true,
    'the recovered commitment still owns its original seam instead of allowing a bed');
  assert.ok(next.pauseDelaySec > 0,
    'the recovered item regains the hidden timeline delay persisted with the commitment');

  rmSync(config.liquidsoap.queueFile, { force: true });
  queue.disarmPauseTalk((queue as any)._pendingVoice, 'test cleanup');
  await waitFor(() => !existsSync(PAUSE_TALK_COMMIT_FILE));
  (queue as any)._pendingVoice = null;
});

test('the committed slot stays occupied until the pause voice joins say.txt', async () => {
  clearPauseProtocol();
  const pauseId = '0123456789abcdef';
  (queue as any)._pendingVoice = {
    kind: 'curiosity', clips: [clip('Original')], daypart: null,
    exchange: false, t: Date.now(), pauseTalk: true, pauseId,
    pauseArmedAt: Date.now(), pauseIncomingCrossMs: 120,
  };
  writeFileSync(config.liquidsoap.pauseTalkPlayingFile, JSON.stringify({
    pauseId, startedAt: Date.now() / 1000,
  }));

  queue.onPauseTalkStarted();
  assert.equal(queue.pendingVoiceTalk()?.kind, 'curiosity', 'the release delay still owns the slot');
  assert.equal(
    queue.holdForNextTrack('station-id', [clip('Replacement')]),
    false,
    'another scheduled voice cannot steal the silence while the crossfade tail clears',
  );
  assert.equal(queue.pendingVoiceTalk()?.kind, 'curiosity');
  assert.equal(
    queue.holdForNextTrack('handoff', [clip('Show handoff')], { notBefore: Date.now() + 1_000 }),
    false,
    'a final-track handoff must retry rather than falsely replacing an armed silence',
  );
  assert.equal(queue.pendingVoiceTalk()?.kind, 'curiosity');

  await waitFor(() => existsSync(config.liquidsoap.sayFile));
  assert.ok(readFileSync(config.liquidsoap.sayFile, 'utf8').includes(`subwave_pause_delivery="${pauseId}"`));
  acceptAndStart(pauseId);
  await waitFor(() => queue.pendingVoiceTalk() === null);
  await waitFor(() => !existsSync(PAUSE_TALK_COMMIT_FILE));
});

test('restart before voice publication publishes the stable id exactly once', async () => {
  const pauseId = '1111111111111111';
  await recoverCommittedPause(pauseId);
  queue.onPauseTalkStarted();
  await waitFor(() => existsSync(config.liquidsoap.sayFile), 3_000);
  assert.equal(
    readFileSync(config.liquidsoap.sayFile, 'utf8'),
    voiceUri(voice, 0, pauseId, pauseId),
  );
  acceptAndStart(pauseId);
  await waitFor(() => queue.pendingVoiceTalk() === null);
});

test('restart after publication leaves the existing say.txt handoff untouched', async () => {
  const pauseId = '2222222222222222';
  await recoverCommittedPause(pauseId);
  const published = `${voiceUri(voice, 0, pauseId, pauseId)},fixture-sentinel`;
  writeFileSync(config.liquidsoap.sayFile, published);
  queue.onPauseTalkStarted();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(readFileSync(config.liquidsoap.sayFile, 'utf8'), published,
    'recovery observes publication instead of overwriting it');
  acceptAndStart(pauseId);
  await waitFor(() => queue.pendingVoiceTalk() === null);
});

test('restart after mixer consumption trusts acceptance and never republishes', async () => {
  const pauseId = '3333333333333333';
  await recoverCommittedPause(pauseId);
  writeFileSync(config.liquidsoap.pauseVoiceAcceptedFile, JSON.stringify({
    deliveryId: pauseId, acceptedAt: Date.now() / 1000,
  }));
  queue.onPauseTalkStarted();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(existsSync(config.liquidsoap.sayFile), false);
  acceptAndStart(pauseId);
  await waitFor(() => queue.pendingVoiceTalk() === null);
});

test('mixer acceptance arriving inside the recovery ambiguity wait prevents replay', async () => {
  const pauseId = '6666666666666666';
  await recoverCommittedPause(pauseId);
  queue.onPauseTalkStarted();
  await new Promise(resolve => setTimeout(resolve, 100));
  writeFileSync(config.liquidsoap.pauseVoiceAcceptedFile, JSON.stringify({
    deliveryId: pauseId, acceptedAt: Date.now() / 1000,
  }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(existsSync(config.liquidsoap.sayFile), false,
    'a controller must not republish after the surviving mixer claims the consumed handoff');
  acceptAndStart(pauseId);
  await waitFor(() => queue.pendingVoiceTalk() === null);
});

test('restart after voice start acknowledges and cleans up without publication', async () => {
  const pauseId = '4444444444444444';
  await recoverCommittedPause(pauseId);
  writeFileSync(config.liquidsoap.pauseVoiceStartedFile, JSON.stringify({
    deliveryId: pauseId, startedAt: Date.now() / 1000,
  }));
  queue.onPauseTalkStarted();
  await waitFor(() => queue.pendingVoiceTalk() === null);
  assert.equal(existsSync(config.liquidsoap.sayFile), false);
  await waitFor(() => !existsSync(PAUSE_TALK_COMMIT_FILE));
});

test('restart after controller acknowledgement performs cleanup only', async () => {
  clearPauseProtocol();
  const pauseId = '5555555555555555';
  await writePauseTalkCommit({
    kind: 'news', pauseTalk: true, pauseId, pauseAcknowledgedAt: Date.now(),
  });
  (queue as any)._pendingVoice = null;
  queue.recover();
  assert.equal(queue.pendingVoiceTalk(), null);
  assert.equal(existsSync(config.liquidsoap.sayFile), false);
  await waitFor(() => !existsSync(PAUSE_TALK_COMMIT_FILE));
});

test('announce reports a held delivery and pause eligibility wins over boundary mode', async () => {
  await settings.load();
  const personaId = settings.get().personas[0].id;
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('pause_show');
  await settings.update({
    pauseTalkMinSeconds: 5,
    shows: [{ id: 'pause_show', name: 'Pause Show', topic: 'tests', personaId, pauseTalk: true }],
  });
  await settings.update({ schedule: week });

  queue.senderBusy = true; // keep the test off the real drain/LLM path
  try {
    const held = await withTalkAir('next-track', () =>
      queue.announce('A deliberately long line.', 'curiosity', { pauseTalkEligible: true }));
    assert.deepEqual(
      { accepted: held.accepted, deferred: held.deferred },
      { accepted: true, deferred: true },
    );
    assert.equal((queue as any)._pendingVoice.pauseTalk, true,
      'the general between-track mode does not downgrade a qualifying real break');
    queue.dropPendingVoice('test cleanup');
    assert.equal(await held.completed, false, 'a displaced hold is never reported as aired');

    const programme = await withTalkAir('next-track', () =>
      queue.announce('The programme feature.', 'programme-feature', { pauseTalkEligible: false }));
    assert.equal((queue as any)._pendingVoice.pauseTalk, false,
      'programme callers can explicitly retain their ordinary boundary delivery');
    queue.dropPendingVoice('test cleanup');
    assert.equal(await programme.completed, false);
  } finally {
    queue.senderBusy = false;
    queue.pendingForceDrain = false;
  }
});

test('a selected SFX waits with its deferred voice instead of firing at render time', async () => {
  const sfxDir = join(root, 'sfx');
  mkdirSync(sfxDir, { recursive: true });
  writeFileSync(join(sfxDir, 'sting.wav'), 'effect');
  writeFileSync(join(root, 'sfx.json'), JSON.stringify({
    items: { sting: { file: 'sting.wav', description: 'test', durationSec: 1 } },
  }));
  rmSync(config.liquidsoap.sfxFile, { force: true });

  const held = await withTalkAir('next-track', () =>
    queue.announce('Hold the effect with me.', 'news', {
      pauseTalkEligible: false,
      sfx: 'sting',
    }));
  assert.equal(held.deferred, true);
  assert.equal(existsSync(config.liquidsoap.sfxFile), false,
    'rendering a held line does not detach its effect onto the current song');

  await queue.airPendingVoice(null);
  assert.equal(existsSync(config.liquidsoap.sfxFile), true,
    'the effect is handed over only when the matching voice is');
  rmSync(config.liquidsoap.introFile, { force: true });
  rmSync(config.liquidsoap.sfxFile, { force: true });
});

test.after(() => rmSync(root, { recursive: true, force: true }));
