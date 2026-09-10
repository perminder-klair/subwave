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
      };
      tts?: Record<string, unknown> & { defaultEngine?: string };
    };
  };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.values);
  assert.ok(body.values.tts);
  return body.values;
}

test('GET /settings returns false for the default Talk placement', async () => {
  await settings.load();
  const values = await getSettings();
  assert.equal(values.djTalkOnlyBetweenTracks, false);
  assert.equal(values.pauseTalkMinSeconds, 20);
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

test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(stateRoot, { recursive: true, force: true });
});
