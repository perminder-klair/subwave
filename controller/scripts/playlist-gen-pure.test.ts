// Unit tests for the playlist builder's pure helpers (music/playlist-gen-pure.ts):
// dedupe/merge, cap, energy-arc arrangement, artist spacing, the deterministic
// fallback's never-empty invariant, id resolution, and count fitting.
// Run: `tsx scripts/playlist-gen-pure.test.ts` (auto-discovered by run-tests.ts).
//
// node:assert-via-tsx style, matching scripts/programme.test.ts.

import assert from 'node:assert/strict';
import {
  energyRank,
  dedupeById,
  mergePools,
  capPool,
  capPerArtist,
  selectByScoreWithSpacing,
  arrangeArc,
  spaceArtists,
  pickDeterministic,
  orderByIds,
  fitToCount,
  totalDurationSec,
  type PoolTrack,
} from '../src/music/playlist-gen-pure.js';

function t(id: string, over: Partial<PoolTrack> = {}): PoolTrack {
  return { id, title: id, artist: id, durationSec: 180, ...over };
}

// ── energyRank ───────────────────────────────────────────────────────────────
{
  assert.equal(energyRank('low'), 0);
  assert.equal(energyRank('medium'), 1);
  assert.equal(energyRank('high'), 2);
  assert.equal(energyRank(null), 1, 'unknown energy sorts as medium');
  assert.equal(energyRank(undefined), 1);
}

// ── dedupeById ───────────────────────────────────────────────────────────────
{
  const merged = dedupeById([
    t('a', { score: 0.2, sources: ['mood'], artist: 'X' }),
    t('a', { score: 0.9, sources: ['sound'], genre: 'jazz' }),
    t('b', { score: 0.5 }),
  ]);
  assert.equal(merged.length, 2, 'duplicate ids collapse');
  const a = merged.find((x) => x.id === 'a')!;
  assert.equal(a.score, 0.9, 'keeps the max score');
  assert.deepEqual(a.sources, ['mood', 'sound'], 'unions source tags');
  assert.equal(a.genre, 'jazz', 'backfills empty fields from later rows');
  assert.equal(a.artist, 'X', 'keeps first-seen non-empty field');
}

// dropping rows without ids
{
  const merged = dedupeById([t('a'), { id: '' } as PoolTrack, null as any]);
  assert.equal(merged.length, 1);
}

// ── mergePools ───────────────────────────────────────────────────────────────
{
  const merged = mergePools([[t('a'), t('b')], [t('b'), t('c')]]);
  assert.deepEqual(merged.map((x) => x.id).sort(), ['a', 'b', 'c']);
}

// ── capPool ──────────────────────────────────────────────────────────────────
{
  const capped = capPool([t('a', { score: 0.1 }), t('b', { score: 0.9 }), t('c', { score: 0.5 })], 2);
  assert.deepEqual(capped.map((x) => x.id), ['b', 'c'], 'keeps highest scores');
  assert.equal(capPool([t('a'), t('b')], 5).length, 2, 'cap >= size is a no-op');
  // stable for equal scores → input order is the tiebreak
  const eq = capPool([t('a'), t('b'), t('c')], 2);
  assert.deepEqual(eq.map((x) => x.id), ['a', 'b']);
}

// ── arrangeArc ───────────────────────────────────────────────────────────────
{
  const lo = t('lo', { energy: 'low' });
  const mid = t('mid', { energy: 'medium' });
  const hi = t('hi', { energy: 'high' });

  assert.deepEqual(arrangeArc([hi, lo, mid], 'build').map((x) => x.id), ['lo', 'mid', 'hi']);
  assert.deepEqual(arrangeArc([lo, mid, hi], 'wind-down').map((x) => x.id), ['hi', 'mid', 'lo']);
  // flat leaves order untouched
  assert.deepEqual(arrangeArc([hi, lo, mid], 'flat').map((x) => x.id), ['hi', 'lo', 'mid']);
  // fewer than 3 → untouched
  assert.deepEqual(arrangeArc([hi, lo], 'build').map((x) => x.id), ['hi', 'lo']);
}

// peak-then-cool: lowest energy at the ends, highest in the middle
{
  const rows = [
    t('e1', { energy: 'low' }),
    t('e2', { energy: 'low' }),
    t('e3', { energy: 'medium' }),
    t('e4', { energy: 'high' }),
    t('e5', { energy: 'high' }),
  ];
  const arranged = arrangeArc(rows, 'peak-then-cool');
  const ranks = arranged.map((x) => energyRank(x.energy));
  const mid = Math.floor(ranks.length / 2);
  assert.equal(Math.max(...ranks), ranks[mid], 'peak sits in the middle');
  assert.ok(ranks[0]! <= ranks[mid]! && ranks[ranks.length - 1]! <= ranks[mid]!, 'ends are lower than the peak');
  assert.equal(arranged.length, rows.length, 'no rows lost');
}

// ── spaceArtists ─────────────────────────────────────────────────────────────
{
  // A,A,B,C has enough spacers to fully separate the two A's.
  const rows = [
    t('1', { artist: 'A' }),
    t('2', { artist: 'A' }),
    t('3', { artist: 'B' }),
    t('4', { artist: 'C' }),
  ];
  const spaced = spaceArtists(rows, 2);
  let ok = true;
  for (let i = 1; i < spaced.length; i++) {
    if (spaced[i]!.artist === spaced[i - 1]!.artist) ok = false;
  }
  assert.ok(ok, 'adjacent same-artist avoided when spacers exist');
  assert.equal(spaced.length, rows.length, 'keeps every track');
}

// spacing relaxes rather than dropping when every remaining track clashes
{
  const rows = [t('1', { artist: 'A' }), t('2', { artist: 'A' }), t('3', { artist: 'A' })];
  const spaced = spaceArtists(rows, 2);
  assert.equal(spaced.length, 3, 'all-same-artist input keeps all tracks');
}

// blank artist never blocks
{
  const rows = [t('1', { artist: '' }), t('2', { artist: '' })];
  assert.equal(spaceArtists(rows, 2).length, 2);
}

// ── capPerArtist ─────────────────────────────────────────────────────────────
{
  const rows = [
    t('a1', { artist: 'A', score: 0.9 }),
    t('a2', { artist: 'A', score: 0.8 }),
    t('a3', { artist: 'A', score: 0.7 }),
    t('b1', { artist: 'B', score: 0.6 }),
  ];
  const capped = capPerArtist(rows, 2);
  assert.equal(capped.filter((x) => x.artist === 'A').length, 2, 'keeps only top-2 of artist A');
  assert.deepEqual(capped.filter((x) => x.artist === 'A').map((x) => x.id), ['a1', 'a2'], 'keeps highest-scoring of the artist');
  assert.ok(capped.some((x) => x.id === 'b1'), 'other artists untouched');
  // blank artists never capped
  const blanks = capPerArtist([t('x', { artist: '' }), t('y', { artist: '' })], 1);
  assert.equal(blanks.length, 2);
}

// ── selectByScoreWithSpacing ─────────────────────────────────────────────────
{
  // Artist A owns the top scores; selection must still interleave B/C.
  const pool = [
    t('a1', { artist: 'A', score: 0.99 }),
    t('a2', { artist: 'A', score: 0.98 }),
    t('a3', { artist: 'A', score: 0.97 }),
    t('b1', { artist: 'B', score: 0.50 }),
    t('c1', { artist: 'C', score: 0.40 }),
  ];
  const picked = selectByScoreWithSpacing(pool, 4, 2);
  assert.equal(picked.length, 4);
  assert.equal(picked[0]!.artist, 'A', 'still leads with the top score');
  // no same-artist within the gap where spacers existed
  assert.notEqual(picked[1]!.artist, 'A', 'second pick is a different artist despite lower score');
  // minGap 0 → pure score order
  assert.deepEqual(selectByScoreWithSpacing(pool, 3, 0).map((x) => x.id), ['a1', 'a2', 'a3']);
}

// ── pickDeterministic (never-empty invariant) ────────────────────────────────
{
  const pool = [
    t('a', { score: 0.9, energy: 'high', artist: 'A' }),
    t('b', { score: 0.8, energy: 'low', artist: 'B' }),
    t('c', { score: 0.7, energy: 'medium', artist: 'A' }),
    t('d', { score: 0.6, energy: 'low', artist: 'C' }),
  ];
  const picked = pickDeterministic(pool, { targetCount: 3, energyArc: 'build', artistSpacing: 2 });
  assert.equal(picked.length, 3, 'honours targetCount');
  assert.ok(picked.length > 0, 'non-empty pool → non-empty result');
  // a non-empty pool with targetCount larger than the pool still returns rows
  const all = pickDeterministic(pool, { targetCount: 99, energyArc: 'flat', artistSpacing: 0 });
  assert.equal(all.length, 4);
  // empty pool → empty (no throw)
  assert.deepEqual(pickDeterministic([], { targetCount: 5, energyArc: 'flat', artistSpacing: 2 }), []);

  // diversity: one artist owning the top scores must NOT fill the whole set
  // (the live-test regression — 11 Snoop Dogg tracks in a row).
  const flooded = [
    ...Array.from({ length: 8 }, (_, i) => t(`z${i}`, { artist: 'Z', score: 0.9 - i * 0.01, energy: 'medium' })),
    t('m1', { artist: 'M', score: 0.4, energy: 'low' }),
    t('n1', { artist: 'N', score: 0.35, energy: 'high' }),
    t('o1', { artist: 'O', score: 0.3, energy: 'medium' }),
  ];
  const div = pickDeterministic(flooded, { targetCount: 6, energyArc: 'flat', artistSpacing: 2 });
  const zCount = div.filter((x) => x.artist === 'Z').length;
  assert.ok(zCount < 6, `dominant artist should not fill the set (got ${zCount}/6)`);
  assert.ok(new Set(div.map((x) => x.artist)).size >= 3, 'set draws from multiple artists');
}

// ── orderByIds ───────────────────────────────────────────────────────────────
{
  const pool = [t('a'), t('b'), t('c')];
  assert.deepEqual(orderByIds(['c', 'a'], pool).map((x) => x.id), ['c', 'a'], 'honours model order');
  assert.deepEqual(orderByIds(['x', 'b', 'b'], pool).map((x) => x.id), ['b'], 'drops unknown + duplicate ids');
  assert.deepEqual(orderByIds([null as any, 1 as any, 'a'], pool).map((x) => x.id), ['a'], 'ignores non-strings');
}

// ── fitToCount ───────────────────────────────────────────────────────────────
{
  const pool = [t('a', { score: 0.9 }), t('b', { score: 0.8 }), t('c', { score: 0.7 }), t('d', { score: 0.6 })];
  // too few → tops up from the pool by score
  const up = fitToCount([t('a', { score: 0.9 })], pool, 3);
  assert.equal(up.length, 3);
  assert.equal(up[0]!.id, 'a');
  assert.ok(!up.slice(1).some((x) => x.id === 'a'), 'no duplicate of an already-chosen track');
  // too many → trims to target
  const down = fitToCount(pool, pool, 2);
  assert.deepEqual(down.map((x) => x.id), ['a', 'b']);
}

// ── totalDurationSec ─────────────────────────────────────────────────────────
{
  assert.equal(totalDurationSec([{ durationSec: 100 }, { durationSec: 50 }, { durationSec: null }]), 150);
  assert.equal(totalDurationSec([]), 0);
}

console.log('✓ playlist-gen-pure tests passed');
