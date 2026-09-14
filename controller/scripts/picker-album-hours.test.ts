// settings.picker.albumHours — the album cooldown's operator dial (#1485 FR 3),
// and the ONE queue window both pick paths read through it.
//
// A COLD-LOAD round trip, for the reason llm-repeat-penalty.test.ts documents:
// load()'s section blocks compose explicitly instead of spreading DEFAULTS, so
// a field missing from load() still validates, still saves, still works for the
// rest of the process — then silently vanishes on the next restart. An
// in-process assertion passes on that bug; only a restart catches it.
//
// The second half pins queue.recentAlbumKeys, which is what makes the pool path
// and the agent path agree by construction rather than by two similar readings.
//
// Run: npm test -- picker-album-hours

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-album-hours-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { albumKey } = await import('../src/music/recency.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

async function coldLoad(picker: Record<string, unknown> | undefined) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(picker === undefined ? {} : { picker }));
  setCache(null);
  await settings.load();
  return settings.get().picker as { albumHours: number };
}

// ── the dial ───────────────────────────────────────────────────────────────

test('the shipped default is OFF, so an upgrade changes nothing', async () => {
  // The load-bearing assertion of the whole feature: a settings.json written
  // before this key existed must keep picking exactly as it did. 0 is not
  // timidity — the artist window already spaces everything a shorter album
  // window would catch, so only an operator can know the right number.
  assert.equal((await coldLoad(undefined)).albumHours, 0);
  assert.equal((await coldLoad({})).albumHours, 0);
});

test('a configured cooldown survives a controller restart', async () => {
  assert.equal((await coldLoad({ albumHours: 6 })).albumHours, 6);
  assert.equal((await coldLoad({ albumHours: 1.5 })).albumHours, 1.5, 'fractions are real answers');
});

test('a stored value is clamped rather than refused', async () => {
  assert.equal((await coldLoad({ albumHours: 999 })).albumHours, 72, 'ceiling');
  assert.equal((await coldLoad({ albumHours: -4 })).albumHours, 0, 'floor');
  // load() is lenient by contract — a hand-edited settings.json must not wedge
  // boot. The strict refusal belongs to the patch path below.
  assert.equal((await coldLoad({ albumHours: 'soon' })).albumHours, 0, 'junk falls back');
});

test('0 is a real value, not an absent one', async () => {
  assert.equal((await coldLoad({ albumHours: 0 })).albumHours, 0);
});

test('saving a cooldown then restarting keeps it — the operator story', async () => {
  await coldLoad({});
  await settings.update({ picker: { albumHours: 8 } } as never);
  assert.equal(settings.get().picker.albumHours, 8, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal(settings.get().picker.albumHours, 8, 'and survives the restart');
});

test('the patch path refuses what load() repairs', async () => {
  // The registry posture: a typed value out of range is an operator mistake at
  // the route and must be reported, not silently clamped.
  await coldLoad({ albumHours: 6 });
  await assert.rejects(
    () => settings.update({ picker: { albumHours: 500 } } as never),
    /picker\.albumHours must be between 0 and 72/,
  );
  assert.equal(settings.get().picker.albumHours, 6, 'a refused patch changes nothing');
});

// ── the window both paths read ─────────────────────────────────────────────

const play = (title: string, artist: string, album: string | null, minutesAgo: number) => ({
  id: `${title}-id`,
  title,
  artist,
  album,
  endedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

test('recentAlbumKeys is empty when the cooldown is off', () => {
  queue._recentPlays = [play('Idioteque', 'Radiohead', 'Kid A', 10)];
  assert.equal(queue.recentAlbumKeys(0).size, 0);
  assert.equal(queue.recentAlbumKeys(-1).size, 0);
});

test('recentAlbumKeys covers what aired inside the window, and stops at it', () => {
  queue._recentPlays = [
    play('Idioteque', 'Radiohead', 'Kid A', 30),
    play('Clampdown', 'The Clash', 'London Calling', 400),
  ];
  const keys = queue.recentAlbumKeys(2);
  assert.equal(keys.has(albumKey({ album: 'Kid A', artist: 'Radiohead' })), true);
  assert.equal(keys.has(albumKey({ album: 'London Calling', artist: 'The Clash' })), false);
});

test('recentAlbumKeys covers the QUEUED side too', () => {
  // A pick is not always adjacent to the track on air: with a pair-aware drain
  // (or a request stacked ahead) an album queued two slots out is exactly the
  // repeat this exists to catch, and it has no play row yet.
  queue._recentPlays = [];
  queue.upcoming = [
    { track: { id: 'q1', title: 'Optimistic', artist: 'Radiohead', album: 'Kid A' } },
  ] as never;
  queue.current = {
    track: { id: 'c0', title: 'Clampdown', artist: 'The Clash', album: 'London Calling' },
  } as never;
  const keys = queue.recentAlbumKeys(2);
  assert.equal(keys.has(albumKey({ album: 'Kid A', artist: 'Radiohead' })), true, 'queued');
  assert.equal(
    keys.has(albumKey({ album: 'London Calling', artist: 'The Clash' })), true, 'on air',
  );
  queue.upcoming = [];
  queue.current = null;
});

test('a compilation play never enters the window', () => {
  queue._recentPlays = [];
  queue.current = {
    track: { id: 'n1', title: 'A Track', artist: 'Act One', album: 'Now 47', isCompilation: true },
  } as never;
  assert.equal(queue.recentAlbumKeys(6).size, 0);
  queue.current = null;
});

test('a play row written before the cooldown existed takes no part in it', () => {
  // The sidecar is durable: rows on disk from an older build carry no album, so
  // an upgrade starts remembering records from the next play, never
  // retroactively — and never by guessing.
  queue._recentPlays = [
    { id: 'old', title: 'Idioteque', artist: 'Radiohead', endedAt: new Date().toISOString() },
  ] as never;
  assert.equal(queue.recentAlbumKeys(6).size, 0);
  queue._recentPlays = [];
});
