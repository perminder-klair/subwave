// DJ Doc's co-host rescue-voice finding (#2029). A host whose engine fails
// mid-render is rescued in the station fallback voice unless the persona has a
// rescue voice of its own; on a co-hosted show that one voice can make one
// host sound like the other. The check is static: it names the hosts on each
// co-hosted show that have no rescue voice.
// Run: npm test -- doctor-cohost-rescue

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-doctor-cohost-'));
const { checkTts, coHostRescueFinding } = await import('../src/doctor/checks-services.js');

const tom = { id: 'p_tom', name: 'Tom', fallbackVoice: null };
const emma = { id: 'p_emma', name: 'Emma', fallbackVoice: null };
const kai = { id: 'p_kai', name: 'Kai', fallbackVoice: { engine: 'kokoro', cloudProvider: 'openai', voice: 'am_adam' } };
const RESCUE = { engine: 'gemini', cloudProvider: 'openai', voice: 'Kore' };

test('a co-hosted show with hosts lacking a rescue voice warns and names them', () => {
  const f = coHostRescueFinding({
    personas: [tom, emma, kai],
    shows: [{ name: 'The Late Shift', personaId: 'p_emma', guestPersonaIds: ['p_tom', 'p_kai'] }],
  });
  assert.equal(f?.label, 'co-host rescue voices');
  assert.equal(f?.status, 'warn');
  assert.equal(f?.detail, 'no rescue voice — The Late Shift: Emma, Tom');
  assert.match(f?.hint || '', /Personas → Voice/);
});

test('every host with a rescue voice is ok', () => {
  const f = coHostRescueFinding({
    personas: [{ ...tom, fallbackVoice: RESCUE }, { ...emma, fallbackVoice: RESCUE }],
    shows: [{ name: 'The Late Shift', personaId: 'p_emma', guestPersonaIds: ['p_tom'] }],
  });
  assert.equal(f?.status, 'ok');
  assert.equal(f?.hint, undefined);
});

test('solo shows, deleted guests and a station with no shows add no finding', () => {
  assert.equal(coHostRescueFinding({ personas: [tom, emma], shows: [{ name: 'Solo', personaId: 'p_tom', guestPersonaIds: [] }] }), null);
  assert.equal(coHostRescueFinding({ personas: [tom], shows: [{ name: 'Gone', personaId: 'p_tom', guestPersonaIds: ['p_deleted'] }] }), null);
  assert.equal(coHostRescueFinding({ personas: [tom, emma] }), null);
  assert.equal(coHostRescueFinding(null), null);
});

test('checkTts carries the finding into the Voice (TTS) section', async () => {
  const findings = await checkTts({
    tts: { defaultEngine: 'piper' },
    personas: [tom, emma],
    shows: [{ name: 'Drive', personaId: 'p_tom', guestPersonaIds: ['p_emma'] }],
  });
  const f = findings.find((x) => x.label === 'co-host rescue voices');
  assert.equal(f?.status, 'warn');
  assert.equal(f?.detail, 'no rescue voice — Drive: Tom, Emma');
});
