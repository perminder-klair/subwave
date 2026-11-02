// DELETE /personas/:id, over real HTTP against a real state dir (#1950).
//
// A persona Delete used to be a local form edit in the admin panel that only
// reached the station when some editor's Save persona was pressed, and a reload
// silently undid it. It is now persisted immediately, the same shape as
// DELETE /shows/:id: the route reads the PERSISTED roster (never the panel's,
// so unsaved edits elsewhere are neither saved nor lost), and one
// settings.update() carries the cascade through prepareUpdate's sweep.
//
// What this pins is the surface the panel relies on: the 404 that means "never
// saved, splice locally", the refusal that keeps one persona on the station,
// the cascade (hosted shows, their hours, a takeover pinning one, guest seats,
// the activePersonaId re-point), the response shape the panel caches, and that
// all of it survives a cold reload.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset (middleware/auth.ts),
// so the router mounts bare. Run: `npm test -- persona-delete`.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listen as listenHttp } from './test-utils/http.js';
import { createTempDir } from './test-utils/temp-dir.js';

const testRoot = createTempDir(path.join(tmpdir(), 'subwave-persona-delete-'));
const stateRoot = path.join(testRoot, 'state');
mkdirSync(stateRoot);
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { router } = await import('../src/routes/personas.js');

const app = express();
app.use(express.json());
app.use(router);
const { server, url: base } = await listenHttp(app);
// unref, or the listening socket holds the event loop open and the file never exits.
server.unref();

await settings.load();
// The seeded roster a fresh station boots with: three personas.
const SEED = JSON.parse(JSON.stringify(settings.get().personas)) as Array<{ id: string; name: string }>;
assert.ok(SEED.length >= 3, 'a fresh station seeds at least three personas');
const [first, second, third] = SEED as [typeof SEED[0], typeof SEED[0], typeof SEED[0]];

const weekWith = (cells: Array<[day: number, hour: number, id: string]>) => {
  const week: Record<number, Array<string | null>> = {};
  for (let d = 0; d < 7; d++) week[d] = Array.from({ length: 24 }, () => null);
  for (const [d, h, id] of cells) week[d]![h] = id;
  return week;
};

// `third` hosts Late Night (with a takeover on it) and guests on Breakfast,
// which `first` hosts. `first` is the default persona.
async function seed(personas = SEED) {
  await settings.update({
    scheduleOverride: null,
    personas,
    activePersonaId: first.id,
    shows: [
      { id: 's_late', name: 'Late Night', personaId: third.id, guestPersonaIds: [] },
      { id: 's_breakfast', name: 'Breakfast', personaId: first.id, guestPersonaIds: [third.id] },
    ],
    schedule: weekWith([[0, 21, 's_late'], [0, 8, 's_breakfast']]),
  });
  const now = Date.now();
  await settings.update({ scheduleOverride: { showId: 's_late', startedAt: now, expiresAt: now + 3600_000 } });
}

const del = (id: string) => fetch(`${base}/personas/${encodeURIComponent(id)}`, { method: 'DELETE' });

async function coldReload() {
  setCache(null);
  await settings.load();
  return settings.get();
}

test('an id the station never saved answers 404 and changes nothing', async () => {
  await seed();
  const res = await del('p_never_saved');
  assert.equal(res.status, 404, '404 is how the panel knows a local splice is enough');
  const after = await coldReload();
  assert.deepEqual(after.personas.map((p: any) => p.id), SEED.map(p => p.id));
  assert.equal(after.shows.length, 2);
});

test('deleting a host persists the roster and the whole cascade in one write', async () => {
  await seed();
  const res = await del(third.id);
  assert.equal(res.status, 200);
  const body = await res.json() as any;

  assert.deepEqual(body.personas.map((p: any) => p.id), [first.id, second.id]);
  // The show it hosted is gone; the show it only guested on survives without it.
  assert.deepEqual(body.shows.map((s: any) => s.id), ['s_breakfast']);
  assert.deepEqual(body.shows[0].guestPersonaIds, []);
  // Its show's hour is cleared, the surviving show keeps its own.
  assert.equal(body.schedule[0][21], null);
  assert.equal(body.schedule[0][8], 's_breakfast');
  // The takeover pinned the deleted show, so it ended with it.
  assert.equal(body.scheduleOverride, null);
  // Not the default persona, so the default stands.
  assert.equal(body.activePersonaId, first.id);

  // Persisted, not just answered: a cold reload sees the same station.
  const after = await coldReload();
  assert.deepEqual(after.personas.map((p: any) => p.id), [first.id, second.id]);
  assert.deepEqual(after.shows.map((s: any) => s.id), ['s_breakfast']);
  assert.equal(after.schedule[0][21], null);
  assert.equal(after.scheduleOverride, null);
});

test('a takeover pinning a show that survives the delete is left running', async () => {
  await seed();
  const now = Date.now();
  await settings.update({ scheduleOverride: { showId: 's_breakfast', startedAt: now, expiresAt: now + 3600_000 } });
  const body = await (await del(third.id)).json() as any;
  assert.equal(body.scheduleOverride?.showId, 's_breakfast');
  assert.equal((await coldReload()).scheduleOverride?.showId, 's_breakfast');
});

test('deleting the default persona re-points activePersonaId', async () => {
  await seed();
  const body = await (await del(first.id)).json() as any;
  assert.ok(body.personas.some((p: any) => p.id === body.activePersonaId),
    'the default must name a persona that still exists');
  assert.notEqual(body.activePersonaId, first.id);
  assert.equal((await coldReload()).activePersonaId, body.activePersonaId);
});

test('the last saved persona cannot be deleted, and the refusal says why', async () => {
  await settings.update({ scheduleOverride: null, shows: [], schedule: weekWith([]) });
  await settings.update({ personas: [first], activePersonaId: first.id });
  const res = await del(first.id);
  assert.equal(res.status, 409);
  const body = await res.json() as any;
  assert.match(body.error, /only saved persona/);
  assert.match(body.error, new RegExp(first.name));
  assert.deepEqual((await coldReload()).personas.map((p: any) => p.id), [first.id]);
});
