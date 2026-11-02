// show.excludeExplicit as a setting: the schema's reading, a save, and a COLD
// load, because a field that only exists in memory passes every in-process
// assertion and vanishes at the next restart (controller/CLAUDE.md). The
// resolved show is pinned too: every pick path reads that, so a field missing
// from it is a silent no-op (the #779 failure).
// Run: `npm test -- explicit-show-setting`.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-explicit-setting-'));
process.env.STATE_DIR = dir;

const { STATE_DIR } = await import('../src/config.js');
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { showSchema } = await import('../src/schemas/show.js');
await settings.load();
after(() => removeTempDir(dir));

const schema = showSchema({ personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null });
const parse = (fields: Record<string, unknown>) => schema.parse({ id: 's_x', name: 'X', personaId: '', ...fields });
const host = () => settings.get().personas[0].id;

test('off unless it is literally true, so a show from before the field is unchanged', () => {
  assert.equal(parse({}).excludeExplicit, false);
  assert.equal(parse({ excludeExplicit: null }).excludeExplicit, false);
  assert.equal(parse({ excludeExplicit: 'yes' }).excludeExplicit, false);
  assert.equal(parse({ excludeExplicit: true }).excludeExplicit, true);
});

test('it stands alone: a show with no other filter can be clean', () => {
  const show = parse({ excludeExplicit: true });
  assert.equal(show.filtersStrict, false);
  assert.deepEqual(show.genres, []);
});

test('a saved clean show survives a controller restart', async () => {
  await settings.update({ shows: [{ id: 's_clean', name: 'Clean', personaId: host(), excludeExplicit: true }] } as never);
  assert.equal(settings.get().shows[0].excludeExplicit, true);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().shows[0].excludeExplicit, true);
});

test('a stored show with the field missing or malformed cold-loads as off and is kept', async () => {
  const personaId = host();
  // Shows live in schedule.json, which wins over settings.json on load.
  writeFileSync(join(STATE_DIR, 'schedule.json'), JSON.stringify({
    shows: [
      { id: 's_old', name: 'Old', personaId },
      { id: 's_bad', name: 'Bad', personaId, excludeExplicit: 'yes' },
      { id: 's_on', name: 'On', personaId, excludeExplicit: true },
    ],
    schedule: {},
    override: null,
  }));
  setCache(null);
  await settings.load();
  const shows = settings.get().shows;
  assert.deepEqual(shows.map((s: any) => [s.id, s.excludeExplicit]), [['s_old', false], ['s_bad', false], ['s_on', true]]);
});

test('the resolved show carries it, which is the object every pick path reads', async () => {
  const now = Date.now();
  await settings.update({
    shows: [{ id: 's_live', name: 'Live', personaId: host(), excludeExplicit: true }],
    scheduleOverride: { showId: 's_live', startedAt: now - 60_000, expiresAt: now + 3_600_000 },
  } as never);
  assert.equal(settings.resolveActiveShow()?.excludeExplicit, true);
  await settings.update({ scheduleOverride: null } as never);
});
