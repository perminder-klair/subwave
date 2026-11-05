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
  for (const page of ['../app/admin/settings/page.tsx', '../app/admin/personas/page.tsx']) {
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
