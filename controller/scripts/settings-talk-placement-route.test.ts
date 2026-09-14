// The authenticated GET /settings response contract for Talk placement (#1638).
// Persistence and air-policy coverage live in talk-air.test.ts; this file pins
// the read projection the admin form uses after save, on its poll, and on reload.
//
// Run: `npm test -- settings-talk-placement-route`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-settings-talk-placement-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { router } = await import('../src/routes/settings/core.js');

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const authorization = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;

async function getSettings() {
  const res = await fetch(`${base}/settings`, { headers: { authorization } });
  const body = await res.json() as {
    values?: {
      djTalkOnlyBetweenTracks?: boolean;
      pauseTalkMinSeconds?: number;
      djBehaviour?: {
        releaseYearMentions?: string;
        recapLimit?: number;
        recapMinutes?: number;
        recapChars?: number;
      };
      tts?: Record<string, unknown> & { defaultEngine?: string };
    };
  };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.values);
  assert.ok(body.values.tts);
  return body.values;
}

async function postSettings(patch: unknown) {
  const res = await fetch(`${base}/settings`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json() as { saved?: unknown; error?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

test('GET /settings returns false for the default Talk placement', async () => {
  await settings.load();
  const values = await getSettings();
  assert.equal(values.djTalkOnlyBetweenTracks, false);
  assert.equal(values.pauseTalkMinSeconds, 20);
  assert.equal(values.djBehaviour?.recapLimit, 10);
  assert.equal(values.djBehaviour?.recapMinutes, 120);
  assert.equal(values.djBehaviour?.recapChars, 140);
});

test('GET /settings returns saved Talk placement without changing Voice engine', async () => {
  const defaultEngine = settings.get().tts.defaultEngine;
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);

  const values = await getSettings();
  assert.equal(values.djTalkOnlyBetweenTracks, true);
  assert.equal(values.tts!.defaultEngine, defaultEngine);
  assert.equal('djTalkOnlyBetweenTracks' in values.tts!, false, 'Talk placement stays a top-level value');

  await settings.update({ djTalkOnlyBetweenTracks: false } as never);
  assert.equal((await getSettings()).djTalkOnlyBetweenTracks, false);
});

test('GET /settings returns the saved pause-and-talk threshold', async () => {
  await settings.update({ pauseTalkMinSeconds: 37 } as never);
  assert.equal((await getSettings()).pauseTalkMinSeconds, 37);
});

test('GET /settings returns saved DJ behaviour for authoritative form hydration', async () => {
  await settings.update({ djBehaviour: { releaseYearMentions: 'rare' } } as never);
  const values = await getSettings();
  assert.equal(values.djBehaviour?.releaseYearMentions, 'rare');

  await settings.update({ djBehaviour: { releaseYearMentions: 'occasional' } } as never);
  assert.equal((await getSettings()).djBehaviour?.releaseYearMentions, 'occasional');
});

test('DJ recap controls survive the authenticated settings route and a cold load', async () => {
  await postSettings({
    djBehaviour: { recapLimit: 17, recapMinutes: 90, recapChars: 280 },
  });

  setCache(null);
  await settings.load();

  const values = await getSettings();
  assert.deepEqual(
    {
      recapLimit: values.djBehaviour?.recapLimit,
      recapMinutes: values.djBehaviour?.recapMinutes,
      recapChars: values.djBehaviour?.recapChars,
    },
    { recapLimit: 17, recapMinutes: 90, recapChars: 280 },
  );
  assert.equal(values.djBehaviour?.releaseYearMentions, 'occasional', 'a partial block preserves siblings');

  const stored = JSON.parse(readFileSync(path.join(stateRoot, 'settings.json'), 'utf8'));
  assert.deepEqual(
    {
      recapLimit: stored.djBehaviour?.recapLimit,
      recapMinutes: stored.djBehaviour?.recapMinutes,
      recapChars: stored.djBehaviour?.recapChars,
    },
    { recapLimit: 17, recapMinutes: 90, recapChars: 280 },
  );
});

test('the settings route reports each invalid DJ recap control at its nested field', async () => {
  const res = await fetch(`${base}/settings`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      djBehaviour: { recapLimit: 0, recapMinutes: 241, recapChars: 39 },
    }),
  });
  const body = await res.json() as { fieldErrors?: Record<string, string> };
  assert.equal(res.status, 400, JSON.stringify(body));
  assert.deepEqual(body.fieldErrors, {
    'djBehaviour.recapLimit': 'djBehaviour.recapLimit must be a whole number between 1 and 50',
    'djBehaviour.recapMinutes': 'djBehaviour.recapMinutes must be a whole number of minutes between 1 and 240',
    'djBehaviour.recapChars': 'djBehaviour.recapChars must be a whole number between 40 and 1000',
  });
});

test('DJ behaviour segmented controls expose their visible labels and help text', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    path.resolve(here, '../../web/components/admin/settings/DjBehaviourSection.tsx'),
    'utf8',
  );
  for (const aria of ['talkPlacementAria', 'linkStyleAria']) {
    assert.match(source, new RegExp(`<Label \\{\\.\\.\\.${aria}\\.labelledByProps\\}`));
    assert.match(source, new RegExp(`<Seg\\s+\\{\\.\\.\\.${aria}\\.groupProps\\}`));
    assert.match(source, new RegExp(`<p \\{\\.\\.\\.${aria}\\.descriptionProps\\}`));
  }
});

test('DJ recap controls hydrate, save and display nested validation errors', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const section = readFileSync(
    path.resolve(here, '../../web/components/admin/settings/DjBehaviourSection.tsx'),
    'utf8',
  );
  const panel = readFileSync(
    path.resolve(here, '../../web/components/admin/SettingsPanel.tsx'),
    'utf8',
  );
  for (const [field, fallback] of [
    ['recapLimit', '10'],
    ['recapMinutes', '120'],
    ['recapChars', '140'],
  ]) {
    assert.match(panel, new RegExp(`${field}: String\\(v\\.djBehaviour\\?\\.${field} \\?\\? ${fallback}\\)`));
    assert.match(section, new RegExp(`${field}: Number\\(form\\.djBehaviour\\.${field}\\)`));
    assert.match(section, new RegExp(`path="djBehaviour\\.${field}"`));
  }
  assert.match(section, /<Card title="Prompt memory"/);
});

test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(stateRoot, { recursive: true, force: true });
});
