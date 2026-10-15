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

import test from 'node:test';

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
      vocals: 'instrumental',
      filtersStrict: true,
      playlistIds: ['pl-anchor-1', 'pl-anchor-2'],
      playlistStrict: true,
      playlistInOrder: true,
      playlistExhaust: true,
      excludedPlaylistIds: ['pl-blocked'],
    },
  ],
  personas: [{ id: 'p1', name: 'Miles', avatar: '' }],
};

test('resolves the scheduled show at the station-zone slot', () => {
  const show = resolveActiveShow(at, settings as any);
  assert.ok(show, 'expected a show at Sat 19:00');
  assert.equal(show!.id, 's1');
  assert.equal(show!.name, 'Jazz Hour');
});

test('carries the playlist anchor (ids + strict toggle)', () => {
  const show = resolveActiveShow(at, settings as any)!;
  assert.deepEqual(show.playlistIds, ['pl-anchor-1', 'pl-anchor-2']);
  assert.equal(show.playlistStrict, true);
});

test('carries playlistInOrder — the running-order switch the pick branch reads (#779)', () => {
  const show = resolveActiveShow(at, settings as any)!;
  assert.equal(show.playlistInOrder, true);
  assert.equal(show.playlistExhaust, true);
});

test('carries excludedPlaylistIds — the blocklist the pick paths read (#779 no-op regression)', () => {
  const show = resolveActiveShow(at, settings as any)!;
  assert.deepEqual((show as any).excludedPlaylistIds, ['pl-blocked']);
});

test('carries the strict music filters', () => {
  const show = resolveActiveShow(at, settings as any)!;
  assert.equal(show.filtersStrict, true);
  assert.deepEqual(show.genres, ['Jazz']);
  assert.deepEqual(show.moods, ['calm']);
  assert.deepEqual(show.energies, ['low']);
  assert.deepEqual(show.eras, [{ fromYear: 1960, toYear: 1979 }]);
  // Scalar, not a list — but the same silent-disable failure mode as the rest.
  assert.equal((show as any).vocals, 'instrumental');
});

test('a live Default programming takeover suppresses the weekly show without mutating the grid', () => {
  const before = structuredClone(schedule);
  const overridden = {
    ...settings,
    scheduleOverride: {
      showId: null,
      startedAt: at.getTime() - 60_000,
      expiresAt: at.getTime() + 60_000,
    },
  };
  assert.equal(resolveActiveShow(at, overridden as any), null);
  assert.deepEqual(schedule, before);
});

test('the weekly show resumes before and after a Default programming takeover', () => {
  const overridden = {
    ...settings,
    scheduleOverride: {
      showId: null,
      startedAt: at.getTime() + 10 * 60_000,
      expiresAt: at.getTime() + 20 * 60_000,
    },
  };
  assert.equal(resolveActiveShow(at, overridden as any)?.id, 's1');
  assert.equal(resolveActiveShow(new Date(at.getTime() + 30 * 60_000), overridden as any)?.id, 's1');
});

test('a malformed takeover target voids the takeover rather than reading as Default programming', () => {
  // The drift the shared predicates exist to close: `showId === null` would
  // read this as a show pin, `typeof showId === 'string'` as an explicit
  // Default programming takeover. Neither is right — a target naming nothing
  // real has always just let the weekly grid resume, and the resolver and
  // getScheduleOverride must agree about that.
  for (const bad of [undefined, '', 42]) {
    const overridden = {
      ...settings,
      scheduleOverride: {
        showId: bad,
        startedAt: at.getTime() - 60_000,
        expiresAt: at.getTime() + 60_000,
      },
    };
    assert.equal(resolveActiveShow(at, overridden as any)?.id, 's1', String(bad));
  }
});

test('a live named-show takeover retains its existing precedence', () => {
  const alternate = {
    id: 's2', name: 'Dawn Patrol', topic: 'early sounds', personaId: 'p1',
  };
  const overridden = {
    ...settings,
    shows: [...settings.shows, alternate],
    scheduleOverride: {
      showId: 's2',
      startedAt: at.getTime() - 60_000,
      expiresAt: at.getTime() + 60_000,
    },
  };
  assert.equal(resolveActiveShow(at, overridden as any)?.id, 's2');
});

test('returns null on an unscheduled slot', () => {
  const off = new Date(Date.UTC(2026, 0, 3, 18, 0, 0)); // Sat 18:00 — empty cell
  assert.equal(resolveActiveShow(off, settings as any), null);
});
