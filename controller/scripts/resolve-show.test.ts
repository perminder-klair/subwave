// Regression pins for settings.resolveActiveShow — the resolved-show object is
// what EVERY pick path consumes (dj-agent, pool picker, auto-playlist refresh),
// so a field the resolver drops is a feature silently disabled station-wide.
// The canonical case: excludedPlaylistIds was validated + persisted but never
// copied into the resolved show, so resolveExcludedPlaylistIds() always saw
// undefined and the #779 playlist blocklist was a global no-op.
//
// Run: npm test -- resolve-show

import assert from 'node:assert/strict';
import { resolveActiveShow } from '../src/settings.js';
import { setStationTimezone } from '../src/time.js';

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

// Deterministic wall clock: pin the station zone and resolve at a fixed
// instant — Saturday 2026-01-03 19:00 UTC (dow 6, hour 19).
setStationTimezone('UTC');
const at = new Date(Date.UTC(2026, 0, 3, 19, 0, 0));

const schedule: (string | null)[][] = Array.from({ length: 7 }, () => Array(24).fill(null));
schedule[6][19] = 's1';

const settings = {
  schedule,
  shows: [
    {
      id: 's1',
      name: 'Jazz Hour',
      topic: 'smooth jazz for the weekend evening',
      personaId: 'p1',
      moods: ['calm'],
      genres: ['Jazz'],
      eras: [{ fromYear: 1960, toYear: 1979 }],
      energies: ['low'],
      filtersStrict: true,
      playlistIds: ['pl-anchor-1', 'pl-anchor-2'],
      playlistStrict: true,
      excludedPlaylistIds: ['pl-blocked'],
    },
  ],
  personas: [{ id: 'p1', name: 'Miles', avatar: '' }],
};

console.log('resolveActiveShow field propagation:');
await test('resolves the scheduled show at the station-zone slot', () => {
  const show = resolveActiveShow(at, settings as any);
  assert.ok(show, 'expected a show at Sat 19:00');
  assert.equal(show!.id, 's1');
  assert.equal(show!.name, 'Jazz Hour');
});

await test('carries the playlist anchor (ids + strict toggle)', () => {
  const show = resolveActiveShow(at, settings as any)!;
  assert.deepEqual(show.playlistIds, ['pl-anchor-1', 'pl-anchor-2']);
  assert.equal(show.playlistStrict, true);
});

await test('carries excludedPlaylistIds — the blocklist the pick paths read (#779 no-op regression)', () => {
  const show = resolveActiveShow(at, settings as any)!;
  assert.deepEqual((show as any).excludedPlaylistIds, ['pl-blocked']);
});

await test('carries the strict music filters', () => {
  const show = resolveActiveShow(at, settings as any)!;
  assert.equal(show.filtersStrict, true);
  assert.deepEqual(show.genres, ['Jazz']);
  assert.deepEqual(show.moods, ['calm']);
  assert.deepEqual(show.energies, ['low']);
  assert.deepEqual(show.eras, [{ fromYear: 1960, toYear: 1979 }]);
});

await test('returns null on an unscheduled slot', () => {
  const off = new Date(Date.UTC(2026, 0, 3, 18, 0, 0)); // Sat 18:00 — empty cell
  assert.equal(resolveActiveShow(off, settings as any), null);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall resolve-show tests passed');
