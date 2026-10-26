// Per-show jingle and bed allowlists (#1875, #1188): the two show fields, and
// how the automatic draws honour them. An empty list allows everything.
//
// Run: `npm test -- show-imaging-allowlist`.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from './test-utils/http.js';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-show-imaging-allowlist-'));
process.env.STATE_DIR = root;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { router: publicRouter } = await import('../src/routes/public.js');
after(async () => { await removeTempDir(root); });

const LUNCH = 's_lunch';
async function lunchOnAir(over: Record<string, unknown> = {}) {
  await settings.load();
  const at = Date.now();
  const show = { id: LUNCH, name: 'The lunch show', personaId: settings.get().personas[0].id, ...over };
  await settings.update({
    shows: [show],
    scheduleOverride: { showId: LUNCH, startedAt: at - 60_000, expiresAt: at + 3600_000 },
  } as never);
}

test('allowlists survive settings cold load', async () => {
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'], allowedBeds: ['bed-x'] });
  setCache(null);
  await settings.load();
  const show = settings.resolveActiveShow() as any;
  assert.equal(show?.id, LUNCH);
  assert.deepEqual(show.allowedJingles, ['jingle_a.wav']);
  assert.deepEqual(show.allowedBeds, ['bed-x']);
});

test('public schedule omits allowlists', async () => {
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'], allowedBeds: ['bed-x'] });
  const app = express();
  app.use(publicRouter);
  const { server, url } = await listen(app);
  try {
    const body = await (await fetch(`${url}/schedule`)).json() as any;
    const entry = body.shows.find((s: any) => s.id === LUNCH);
    assert.ok(entry, 'the lunch show is listed');
    assert.equal('allowedJingles' in entry, false);
    assert.equal('allowedBeds' in entry, false);
  } finally {
    server.close();
  }
});

test('allowlist over the cap is refused on save and the stored show is unchanged', async () => {
  await lunchOnAir({ allowedJingles: ['jingle_a.wav'] });
  const { SHOW_IMAGING_ALLOWLIST_MAX } = await import('../src/schemas/show.js');
  const many = Array.from({ length: SHOW_IMAGING_ALLOWLIST_MAX + 1 }, (_, i) => `jingle_${i}.wav`);
  const lunch = settings.get().shows.find((s: any) => s.id === LUNCH);
  await assert.rejects(settings.update({ shows: [{ ...lunch, allowedJingles: many }] } as never), /allowedJingles/);
  const stored = settings.get().shows.find((s: any) => s.id === LUNCH) as any;
  assert.deepEqual(stored.allowedJingles, ['jingle_a.wav']);
});
