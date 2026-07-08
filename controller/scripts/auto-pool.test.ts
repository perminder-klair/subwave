// Regression test for the auto.m3u fallback pool builder (broadcast/auto-pool.ts)
// — the recency / dedup / artist-cap guards that keep the LLM-free coast from
// re-airing just-played tracks and from stacking duplicate library copies (#874).
// Run: `tsx scripts/auto-pool.test.ts`.
//
// node:assert-via-tsx style, matching scripts/recent-plays.test.ts.

import assert from 'node:assert/strict';
import { createPoolBuilder } from '../src/broadcast/auto-pool.js';

const song = (id: string, title: string, artist: string) => ({ id, title, artist });

// ── duplicate library copies are deduped by title|artist, not just id ────────

// A library holding the same song 6× has 6 distinct Subsonic ids for it. An
// id-only dedup would let all 6 into the pool and the fallback would stack the
// same track. The builder must keep exactly ONE copy (#874).
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 30, maxPerArtist: 99 });
  const copies = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(id => song(id, 'Eyes on Me', 'Faye Wong'));
  b.take('mood', copies, 30);
  assert.equal(b.pool.length, 1, 'six duplicate copies collapse to one pool entry');
  assert.equal(b.pool[0].id, 'c1', 'the first copy wins');
  assert.equal(b.fromSource.mood, 1, 'fromSource counts the single accepted copy');
}

// Dedup is case/whitespace-insensitive on the key (mirrors trackKey lowercasing).
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 30, maxPerArtist: 99 });
  b.take('mood', [song('a', 'Drama', 'Roy Kim'), song('b', '  DRAMA  ', 'roy kim')], 30);
  assert.equal(b.pool.length, 1, 'title|artist key ignores case and surrounding whitespace');
}

// ── recency filter blocks by id AND by title|artist key ──────────────────────

// A track whose id is NOT in recentIds but whose title|artist IS in recentKeys
// (a different copy of a just-played song) must still be blocked — this is the
// exact hole duplicate copies opened in the id-only filter.
{
  const b = createPoolBuilder({
    recentIds: new Set(['played-id']),
    recentKeys: new Set(['eyes on me|faye wong']),
    targetPool: 30,
    maxPerArtist: 99,
  });
  b.take('mood', [
    song('played-id', 'Eyes on Me', 'Faye Wong'),   // blocked by id
    song('other-copy', 'Eyes on Me', 'Faye Wong'),  // blocked by key (different id!)
    song('fresh', 'Separate Ways', 'Journey'),       // allowed
  ], 30);
  assert.equal(b.pool.length, 1, 'both the played id and its duplicate-copy key are blocked');
  assert.equal(b.pool[0].id, 'fresh', 'only the genuinely fresh track survives');
}

// ── artist cap ───────────────────────────────────────────────────────────────

// No one artist may exceed maxPerArtist even across sources / take() calls.
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 30, maxPerArtist: 2 });
  b.take('mood', [
    song('t1', 'Track One', 'Arjan Dhillon'),
    song('t2', 'Track Two', 'Arjan Dhillon'),
    song('t3', 'Track Three', 'Arjan Dhillon'),  // over the cap → dropped
  ], 30);
  b.take('starred', [song('t4', 'Track Four', 'Arjan Dhillon')], 30);  // still over cap
  assert.equal(b.pool.length, 2, 'artist cap holds across take() calls');
  assert(b.pool.every(t => t.id === 't1' || t.id === 't2'), 'first two of the artist are kept');
}

// ── caps: per-take cap and targetPool ceiling ────────────────────────────────

// The per-call `cap` limits how many a single source contributes.
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 30, maxPerArtist: 99 });
  const many = Array.from({ length: 10 }, (_, i) => song(`s${i}`, `Song ${i}`, `Artist ${i}`));
  b.take('random', many, 3);
  assert.equal(b.pool.length, 3, 'per-source cap limits contribution to 3');
}

// targetPool caps the whole pool regardless of per-source caps.
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 4, maxPerArtist: 99 });
  const many = Array.from({ length: 10 }, (_, i) => song(`s${i}`, `Song ${i}`, `Artist ${i}`));
  b.take('random', many, 30);
  assert.equal(b.pool.length, 4, 'targetPool ceiling stops accumulation');
}

// ── edge cases ───────────────────────────────────────────────────────────────

// Candidates without an id are skipped (they can't be enqueued / deduped).
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 30, maxPerArtist: 99 });
  b.take('mood', [{ title: 'No Id', artist: 'Ghost' }, song('real', 'Real', 'Band')], 30);
  assert.equal(b.pool.length, 1, 'id-less candidates are skipped');
  assert.equal(b.pool[0].id, 'real', 'only the id-bearing track is kept');
}

// A title-less row must NOT collapse an artist's whole catalogue via an empty
// key — two title-less tracks by one artist stay distinct (deduped by id only).
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 30, maxPerArtist: 99 });
  b.take('mood', [
    { id: 'x1', title: '', artist: 'Band' },
    { id: 'x2', title: '', artist: 'Band' },
  ], 30);
  assert.equal(b.pool.length, 2, 'title-less rows dedupe by id only, not by an empty key');
}

// Accepted tracks are stamped with their source label.
{
  const b = createPoolBuilder({ recentIds: new Set(), recentKeys: new Set(), targetPool: 30, maxPerArtist: 99 });
  b.take('starred', [song('s', 'S', 'A')], 30);
  assert.equal(b.pool[0]._source, 'starred', 'pool entry carries the source label');
}

console.log('auto-pool.test.ts: all assertions passed');
