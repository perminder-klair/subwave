// The admin settings and personas pages are server components that CALL
// hostedFromEnv. Exported from a 'use client' module it is a client reference
// on the server, and calling it throws: the pilot's /admin/settings showed
// "Panel failed to render" (React #441) until it moved here. This pins the
// module server-safe, and the env parsing it does.
//
// Run: `npm test -- lib/hosted`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hostedFromEnv } from './hosted';

test('lib/hosted.ts is not a client module, and the pages import hostedFromEnv from it', () => {
  const src = readFileSync(new URL('./hosted.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*['"]use client['"]/m);
  for (const page of ['../app/admin/settings/page.tsx', '../app/admin/personas/page.tsx', '../app/admin/imaging/page.tsx']) {
    const p = readFileSync(new URL(page, import.meta.url), 'utf8');
    assert.match(p, /import \{ hostedFromEnv \} from '[./]+\/lib\/hosted'/, page);
    assert.doesNotMatch(p, /hostedFromEnv[^;]*components\/admin\/HostedContext/, page);
  }
});

test('hosted only for an explicit truthy SUBWAVE_HOSTED', () => {
  assert.deepEqual(hostedFromEnv({}), { hosted: false });
  assert.deepEqual(hostedFromEnv({ SUBWAVE_HOSTED: '0' }), { hosted: false });
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: ' TRUE ' }).hosted, true);
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1' }).hosted, true);
});

test('music URLs: https only, and only when hosted', () => {
  const env = { SUBWAVE_MUSIC_UPLOAD_URL: 'https://up.example/x', SUBWAVE_MUSIC_LIBRARY_URL: 'javascript:alert(1)' };
  assert.deepEqual(hostedFromEnv(env), { hosted: false });
  assert.deepEqual(hostedFromEnv({ ...env, SUBWAVE_HOSTED: '1' }), { hosted: true, musicUploadUrl: 'https://up.example/x' });
});

test('listener cap: a whole number from SUBWAVE_LISTENER_CAP, only when hosted', () => {
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1', SUBWAVE_LISTENER_CAP: '15' }).listenerCap, 15);
  assert.equal(hostedFromEnv({ SUBWAVE_LISTENER_CAP: '15' }).listenerCap, undefined);
  for (const bad of ['0', '-3', '2.5', 'many', '']) {
    assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1', SUBWAVE_LISTENER_CAP: bad }).listenerCap, undefined, bad);
  }
});

test('bitrate ceiling: whole kbps from SUBWAVE_MAX_BITRATE, only when hosted', () => {
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1', SUBWAVE_MAX_BITRATE: '192' }).maxBitrate, 192);
  assert.equal(hostedFromEnv({ SUBWAVE_MAX_BITRATE: '192' }).maxBitrate, undefined);
  // 48: under MP3's lowest bitrate (64), which the MP3 mount could never honour.
  for (const bad of ['', '16', '48', '19.5', 'lots']) {
    assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: '1', SUBWAVE_MAX_BITRATE: bad }).maxBitrate, undefined, bad);
  }
});

test('a malformed SUBWAVE_HOSTED is not hosted, as the controller reads it', () => {
  for (const word of ['ture', 'enabled', '2']) {
    assert.deepEqual(hostedFromEnv({ SUBWAVE_HOSTED: word }), { hosted: false }, word);
  }
  assert.equal(hostedFromEnv({ SUBWAVE_HOSTED: 'on' }).hosted, true);
});

test('the persona engine picker takes the controller\'s rule from the mirror, not a copy', () => {
  const src = readFileSync(new URL('../components/admin/tts/EngineVoiceFields.tsx', import.meta.url), 'utf8');
  assert.match(src, /import \{ hostedPersonaEngines \} from '[./]+\/lib\/schemas\.generated'/);
  assert.doesNotMatch(src, /\['inherit', 'kokoro', 'piper'/);
});

// SUB/WAVE Cloud sells listening hours; the listener and bitrate ceilings are
// unpublished guards for the box's shared port. The settings panel still
// enforces the bitrate ceiling but never shows the listener number, and no
// copy frames either one as the plan's limit.
test('the settings panel presents neither ceiling as a plan limit', () => {
  const src = readFileSync(new URL('../components/admin/SettingsPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /listenerCap/);
  assert.doesNotMatch(src, /(station&apos;s|station's|your|this) plan\b/i);
  assert.match(src, /const \{ maxBitrate \} = useHosted\(\)/);
  assert.match(src, /underCeiling\((OPUS|AAC|MP3)_BITRATES\)/);
});
