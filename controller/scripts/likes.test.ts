// Unit tests for the listener-likes store (broadcast/likes.ts), focused on the
// operator like (#1253) — a real like record under a reserved listener key.
//
// The three rules worth pinning are the ones that are invisible until they
// break: an operator like is idempotent per song, it is exempt from topLiked()'s
// window cutoff, and it is exempt from the MAX_RECORDS trim. Get either
// exemption wrong and the operator's curation silently disappears weeks later.
// Run: `tsx scripts/likes.test.ts`.
//
// node:assert-via-tsx style, matching scripts/blocklist.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time — likes.ts
// derives STORE_FILE from config.stateDir at module scope.
const stateDir = mkdtempSync(join(tmpdir(), 'likes-test-'));
process.env.STATE_DIR = stateDir;

// The window test needs records that are genuinely old, and recordLike/
// operatorLike always stamp `now`. The store loads exactly once per process, so
// seed the file first and let load() read the ages in — no test-only seam on
// the module itself.
const AGED = new Date(Date.now() - 90 * 86_400_000).toISOString();
const NOW = new Date().toISOString();
writeFileSync(join(stateDir, 'likes.json'), JSON.stringify({
  secret: 'test-secret',
  likes: [
    { songId: 'stale', track: { id: 'stale', title: 'Stale' }, airingKey: 'stale|1', listenerKey: 'aaaa', likedAt: AGED },
    { songId: 'curated', track: { id: 'curated', title: 'Curated' }, airingKey: 'curated|operator', listenerKey: 'operator', likedAt: AGED, via: 'operator' },
    { songId: 'fresh', track: { id: 'fresh', title: 'Fresh' }, airingKey: 'fresh|1', listenerKey: 'aaaa', likedAt: NOW },
  ],
}));

const likes = await import('../src/broadcast/likes.js');

const track = (id: string, title = `Song ${id}`) => ({ id, title, artist: 'Someone' });

try {
  await likes.load();

  // ── topLiked(): the window cuts listener likes, never operator likes ──────
  const inWindow = likes.topLiked({ windowDays: 30, limit: 10 }).map((e) => e.track.id);
  assert.ok(inWindow.includes('fresh'), 'a recent listener like is inside the window');
  assert.ok(!inWindow.includes('stale'), 'an aged listener like must fall out of the window');
  assert.ok(
    inWindow.includes('curated'),
    'an aged OPERATOR like must survive the window — curation is not a taste snapshot',
  );
  // windowDays: 0 means all-time, so everything is back.
  assert.equal(likes.topLiked({ windowDays: 0, limit: 10 }).length, 3);

  // ── a plain listener like is unchanged by #1253 ────────────────────────────
  await likes.clear();
  const l1 = await likes.recordLike({ track: track('a'), startedAt: '2026-08-01T10:00:00Z', ip: '10.0.0.1' });
  assert.deepEqual(l1, { ok: true, duplicate: false, count: 1 });

  // Same listener, same airing → deduped. Different airing → likeable again.
  const dupe = await likes.recordLike({ track: track('a'), startedAt: '2026-08-01T10:00:00Z', ip: '10.0.0.1' });
  assert.deepEqual(dupe, { ok: true, duplicate: true, count: 1 });
  const later = await likes.recordLike({ track: track('a'), startedAt: '2026-08-01T14:00:00Z', ip: '10.0.0.1' });
  assert.deepEqual(later, { ok: true, duplicate: false, count: 2 });

  // ── operator like: idempotent per song, counts, marks ─────────────────────
  const op1 = await likes.operatorLike(track('a'));
  assert.deepEqual(op1, { ok: true, added: true, count: 3 }, 'operator like must count alongside listener likes');

  const op2 = await likes.operatorLike(track('a'));
  assert.deepEqual(op2, { ok: true, added: false, count: 3 }, 'a second operator like is a no-op, not a second record');

  // A missing id is refused rather than stored under an empty key.
  assert.deepEqual(await likes.operatorLike({ title: 'no id' }), { ok: false, added: false, count: 0 });

  // ── index() and likedSongs() ──────────────────────────────────────────────
  await likes.operatorLike(track('b'));
  const idx = likes.index();
  assert.deepEqual(idx.a, { count: 3, operator: true });
  assert.deepEqual(idx.b, { count: 1, operator: true });
  assert.equal(idx.nope, undefined);

  const liked = likes.likedSongs();
  assert.equal(liked.length, 2, 'one entry per song, not per record');
  const likedA = liked.find((e) => e.songId === 'a');
  assert.ok(likedA);
  assert.equal(likedA.count, 3);
  assert.equal(likedA.operator, true);

  // ── operator unlike removes ONLY the operator's record ────────────────────
  const un = await likes.operatorUnlike('a');
  assert.deepEqual(un, { removed: true, count: 2 }, 'the two listener likes must survive');
  assert.deepEqual(likes.index().a, { count: 2, operator: false });

  // Unliking what was never operator-liked is a no-op, and still reports the
  // count so the route can decide about unstarring.
  assert.deepEqual(await likes.operatorUnlike('a'), { removed: false, count: 2 });

  // Un-hearting the last like standing leaves the song with nothing — this is
  // the state the route keys its Navidrome unstar off.
  assert.deepEqual(await likes.operatorUnlike('b'), { removed: true, count: 0 });
  assert.equal(likes.index().b, undefined);

  // ── trimTo(): evicts oldest LISTENER records, keeps operator records ──────
  await likes.clear();
  await likes.operatorLike(track('keep-me'));
  for (let i = 0; i < 10; i++) {
    await likes.recordLike({ track: track(`l${i}`), startedAt: `air-${i}`, ip: `10.0.1.${i}` });
  }
  assert.equal(likes.stats().total, 11);

  likes.trimTo(4);
  assert.equal(likes.stats().total, 4);
  const survivors = likes.index();
  assert.equal(survivors.l0, undefined, 'oldest listener records go first');
  assert.ok(survivors.l9, 'newest listener records stay');

  // Degenerate case: more operator records than the cap. The cap still holds —
  // the bound wins over the exemption.
  await likes.clear();
  for (let i = 0; i < 6; i++) await likes.operatorLike(track(`op${i}`));
  likes.trimTo(3);
  assert.equal(likes.stats().total, 3, 'the cap must hold even when it can only evict curation');

  console.log('likes.test.ts: all assertions passed');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
