// Durable pause-voice delivery protocol. Each file represents one crash point:
// before publication, after say.txt publication, after mixer queue acceptance,
// and after the first spoken sample. The strongest observed phase always wins.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-pause-delivery-'));
process.env.STATE_DIR = stateRoot;

const { config } = await import('../src/config.js');
const {
  inspectPauseVoiceDelivery,
  parsePauseVoiceAccepted,
  parsePauseVoiceStarted,
} = await import('../src/broadcast/queue/pause-voice-delivery.js');
const { voiceUri } = await import('../src/broadcast/queue/voice-io.js');

const deliveryId = '0123456789abcdef';
const wav = join(stateRoot, 'voice.wav');

function clearProtocolFiles() {
  for (const path of [
    config.liquidsoap.sayFile,
    config.liquidsoap.voicePlayingFile,
    config.liquidsoap.pauseVoiceAcceptedFile,
    config.liquidsoap.pauseVoiceStartedFile,
  ]) rmSync(path, { force: true });
}

test('the durable phases distinguish every controller crash boundary', () => {
  clearProtocolFiles();
  assert.deepEqual(inspectPauseVoiceDelivery(deliveryId), { phase: 'unpublished' });

  writeFileSync(config.liquidsoap.sayFile, voiceUri(wav, 0, deliveryId, deliveryId));
  assert.deepEqual(inspectPauseVoiceDelivery(deliveryId), { phase: 'published' });

  rmSync(config.liquidsoap.sayFile);
  writeFileSync(config.liquidsoap.pauseVoiceAcceptedFile, JSON.stringify({
    deliveryId, acceptedAt: 1_770_000_001.25,
  }));
  assert.deepEqual(inspectPauseVoiceDelivery(deliveryId), {
    phase: 'accepted', acceptedAt: 1_770_000_001_250,
  });

  writeFileSync(config.liquidsoap.pauseVoiceStartedFile, JSON.stringify({
    deliveryId, startedAt: 1_770_000_002.5,
  }));
  assert.deepEqual(inspectPauseVoiceDelivery(deliveryId), {
    phase: 'started', startedAt: 1_770_000_002_500,
  });
});

test('the generic voice marker is the older-mixer start acknowledgement', () => {
  clearProtocolFiles();
  writeFileSync(config.liquidsoap.voicePlayingFile, JSON.stringify({
    voiceId: deliveryId, channel: 'say', filename: wav, startedAt: 1_770_000_003,
  }));
  assert.deepEqual(inspectPauseVoiceDelivery(deliveryId), {
    phase: 'started', startedAt: 1_770_000_003_000,
  });
});

test('marker parsers fail closed on a missing delivery or unusable clock', () => {
  assert.equal(parsePauseVoiceAccepted('{bad'), null);
  assert.equal(parsePauseVoiceAccepted(JSON.stringify({ deliveryId: '', acceptedAt: 1 })), null);
  assert.equal(parsePauseVoiceStarted(JSON.stringify({ deliveryId, startedAt: 0 })), null);
});

test.after(() => rmSync(stateRoot, { recursive: true, force: true }));
