// Voice levelling is opt-in at render AND handoff, including after a cold load.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-voice-levelling-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { validateSettingsPatch } = await import('../src/settings/patch-registry.js');
const { levelTrimDb, measureClipLevel } = await import('../src/audio/clip-level.js');
const { airVoice, voiceUri } = await import('../src/broadcast/queue/voice-io.js');
const tts = await import('../src/audio/tts.js');
const remote = await import('../src/audio/remoteTts.js');
const ffmpeg = spawnSync('/bin/sh', ['-c', 'command -v ffmpeg']);
const realFfmpeg = String(ffmpeg.stdout).trim();
const audioTest = { skip: realFfmpeg ? false : 'ffmpeg not installed' };
const fixture = join(root, 'quiet.wav');
const capture = join(root, 'ffmpeg.log');
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

async function coldLoad(value?: unknown) {
  writeFileSync(join(root, 'settings.json'), JSON.stringify({
    tts: {
      defaultEngine: 'remote', remote: { url: 'https://remote.test' }, gainDb: { remote: 6 },
      ...(value === undefined ? {} : { voiceLevelling: value }),
    },
  }));
  setCache(null);
  await settings.load();
}

test.before(async () => {
  if (!realFfmpeg) return;
  const made = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=220:duration=3', '-af', 'volume=-5dB', '-ar', '44100', '-ac', '1', '-y', fixture]);
  assert.equal(made.status, 0, String(made.stderr));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SUBWAVE_TEST_FFMPEG_LOG"\nexec "$SUBWAVE_TEST_REAL_FFMPEG" "$@"\n', { mode: 0o755 });
  process.env.SUBWAVE_TEST_REAL_FFMPEG = realFfmpeg;
  process.env.SUBWAVE_TEST_FFMPEG_LOG = capture;
  process.env.PATH = `${bin}:${originalPath}`;
  globalThis.fetch = async input => String(input).endsWith('/health')
    ? Response.json({ ok: true })
    : new Response(readFileSync(fixture), { headers: { 'content-type': 'audio/wav' } });
  await coldLoad();
  await remote.refresh();
});

test.after(() => {
  process.env.PATH = originalPath;
  delete process.env.SUBWAVE_TEST_REAL_FFMPEG;
  delete process.env.SUBWAVE_TEST_FFMPEG_LOG;
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
});

test('absent, malformed and false settings cold-load OFF', async () => {
  for (const value of [undefined, 'true', 1, null, {}, false]) {
    await coldLoad(value);
    assert.equal(settings.get().tts.voiceLevelling, false, `stored ${JSON.stringify(value)}`);
  }
});

test('the boolean round-trips through settings and the patch registry rejects malformed saves', async () => {
  await coldLoad();
  for (const value of [true, false]) {
    assert.equal(validateSettingsPatch({ tts: { voiceLevelling: value } }), null);
    await settings.update({ tts: { voiceLevelling: value } });
    assert.equal(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')).tts.voiceLevelling, value);
    setCache(null);
    await settings.load();
    assert.equal(settings.get().tts.voiceLevelling, value);
    assert.equal(settings.get().tts.defaultEngine, 'remote', 'other TTS settings survive the partial schema');
  }
  for (const value of ['true', 1, null, {}]) {
    assert.equal(validateSettingsPatch({ tts: { voiceLevelling: value } })?.fieldErrors['tts.voiceLevelling'],
      'tts.voiceLevelling must be a boolean');
    await assert.rejects(() => settings.update({ tts: { voiceLevelling: value } }), /tts\.voiceLevelling must be a boolean/);
  }
});

test('OFF skips the render-time ebur128 pass; true measures, including the combined clamp', audioTest, async () => {
  await coldLoad(false);
  writeFileSync(capture, '');
  const off = await tts.speak('A quiet spoken take.', { kind: 'station-id', speedScale: 1 });
  assert.doesNotMatch(readFileSync(capture, 'utf8'), /ebur128/, 'no loudness measurement when off');
  assert.equal(levelTrimDb(off), 0);

  await settings.update({ tts: { voiceLevelling: true } });
  const on = await tts.speak('A quiet spoken take.', { kind: 'station-id', speedScale: 1 });
  assert.match(readFileSync(capture, 'utf8'), /ebur128=framelog=verbose/);
  assert.ok(levelTrimDb(on) > 6, 'the quiet take needs a lift');
  const handoff = join(root, 'say-on.txt');
  await airVoice(handoff, on, 'A quiet spoken take.', tts.voiceGainDb('station-id'), {
    voiceId: 'levelled', airMarkerPromise: Promise.resolve(null),
  });
  assert.equal(readFileSync(handoff, 'utf8'), voiceUri(on, 12, 'levelled'), 'operator gain plus trim stays clamped');

  writeFileSync(capture, '');
  await tts.speak('A jingle.', { kind: 'jingle' });
  assert.equal(readFileSync(capture, 'utf8'), '', 'jingles retain their separate levelling path');
});

test('cold-loaded absent, malformed and false preserve the exact old URI despite a cached trim', audioTest, async () => {
  await measureClipLevel(fixture);
  assert.ok(levelTrimDb(fixture) > 6);
  for (const value of [undefined, 'true', false]) {
    await coldLoad(value);
    const handoff = join(root, 'say-off.txt');
    const id = `off-${String(value)}`;
    await airVoice(handoff, fixture, 'A quiet spoken take.', 6, {
      voiceId: id, airMarkerPromise: Promise.resolve(null),
    });
    assert.equal(readFileSync(handoff, 'utf8'), voiceUri(fixture, 6, id));
  }
  await settings.update({ tts: { voiceLevelling: true } });
  await settings.update({ tts: { voiceLevelling: false } });
  const handoff = join(root, 'say-disabled.txt');
  await airVoice(handoff, fixture, 'A quiet spoken take.', 0, {
    voiceId: 'disabled', airMarkerPromise: Promise.resolve(null),
  });
  assert.equal(readFileSync(handoff, 'utf8'), voiceUri(fixture, 0, 'disabled'), 'turning off also restores the zero-gain URI');
});
