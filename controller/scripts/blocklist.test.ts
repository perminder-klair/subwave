// Unit tests for the never-play blocklist (music/blocklist.ts): add/remove/
// dedupe round-trips through blocklist.json, and the isBlocked() matching
// contract — id-first (track/album/artist), exact normalised-name fallback for
// album/artist entries (library-db rows carry no Subsonic ids), and NO name
// matching for track entries (covers/re-recordings share titles).
// Run: `tsx scripts/blocklist.test.ts`.
//
// node:assert-via-tsx style, matching scripts/auto-pool.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time.
const stateDir = mkdtempSync(join(tmpdir(), 'blocklist-test-'));
process.env.STATE_DIR = stateDir;

const blocklist = await import('../src/music/blocklist.js');

try {
  await blocklist.load(); // no file yet — starts empty, must not throw
  assert.equal(blocklist.isEmpty(), true);
  assert.deepEqual(blocklist.list(), []);

  // Empty list blocks nothing and rejectBlocked is identity.
  assert.equal(blocklist.isBlocked({ id: 'x', artist: 'Anyone' }), false);
  const arr = [{ id: 'a' }, { id: 'b' }];
  assert.equal(blocklist.rejectBlocked(arr), arr);

  // ── track entries: id-only, never by name ─────────────────────────────────
  const t = await blocklist.add({ type: 'track', id: 'trk1', name: 'Song X', artist: 'Y' });
  assert.ok(t);
  assert.equal(blocklist.isBlocked({ id: 'trk1' }), true);
  assert.equal(blocklist.isBlocked({ id: 'other', title: 'Song X', artist: 'Y' }), false, 'track entries must not name-match');

  // Dedupe on (type, id).
  assert.equal(await blocklist.add({ type: 'track', id: 'trk1' }), null);
  assert.equal(blocklist.list().length, 1);

  // ── album entries: id, then (name, artist) pair ───────────────────────────
  await blocklist.add({ type: 'album', id: 'alb1', name: 'Greatest Hits', artist: 'Ambient Guy' });
  assert.equal(blocklist.isBlocked({ id: 's1', albumId: 'alb1' }), true);
  assert.equal(blocklist.isBlocked({ id: 's2', album: 'greatest  hits', artist: 'AMBIENT GUY' }), true, 'album name+artist fallback, normalised');
  assert.equal(blocklist.isBlocked({ id: 's3', album: 'Greatest Hits', artist: 'Someone Else' }), false, 'same album title by another artist stays playable');

  // ── artist entries: id, then normalised name ──────────────────────────────
  await blocklist.add({ type: 'artist', id: 'art1', name: 'Ambient Guy' });
  assert.equal(blocklist.isBlocked({ id: 's4', artistId: 'art1' }), true);
  assert.equal(blocklist.isBlocked({ id: 's5', artist: ' ambient guy ' }), true, 'artist name fallback, normalised');
  assert.equal(blocklist.isBlocked({ id: 's6', artist: 'Ambient Guy Trio' }), false, 'exact match only, no substring');

  // rejectBlocked drops only the blocked rows.
  const filtered = blocklist.rejectBlocked([{ id: 'trk1' }, { id: 'ok' }, { id: 's7', artist: 'Ambient Guy' }]);
  assert.deepEqual(filtered.map((s: any) => s.id), ['ok']);

  // ── persistence round-trip ────────────────────────────────────────────────
  const onDisk = JSON.parse(readFileSync(join(stateDir, 'blocklist.json'), 'utf8'));
  assert.equal(onDisk.entries.length, 3);
  assert.ok(onDisk.entries.every((e: any) => e.addedAt));

  // ── remove ────────────────────────────────────────────────────────────────
  assert.equal(await blocklist.remove('artist', 'art1'), true);
  assert.equal(await blocklist.remove('artist', 'art1'), false, 'second remove is a miss');
  assert.equal(blocklist.isBlocked({ id: 's5', artist: 'ambient guy' }), false, 'artist unblocked');
  assert.equal(blocklist.isBlocked({ id: 'trk1' }), true, 'other entries survive a remove');

  console.log('blocklist.test.ts: all assertions passed');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
