// Tests for the library prune guard (music/prune-policy.ts + its use in
// music/id-rotation.ts adoptAndPrune).
//
// A complete Navidrome walk proves which ids are served NOW. When a music
// folder is unmounted, Navidrome rescans, its albums vanish, and the next
// reconcile used to delete every row the walk did not see: tags, analysis,
// vectors and play history, none of which come back without re-tagging and
// re-analysing. The guard keeps everything while Navidrome is mid-scan and
// holds a removal larger than max(200, 2 % of the library) until the
// operator confirms it. Ordinary deletions (an album here and there) prune as
// before.
//
// The second half runs adoptAndPrune against a real better-sqlite3 DB in a
// temp STATE_DIR (set before library-db is imported, as in id-adoption.test.ts).
// No Navidrome is configured, so getScanStatus() answers null (unknown).
// Run: `tsx scripts/prune-policy.test.ts` (auto-discovered by npm test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-prune-guard-'));
process.env.STATE_DIR = stateDir;

const policy = await import('../src/music/prune-policy.js');
const db = await import('../src/music/library-db.js');
const rotation = await import('../src/music/id-rotation.js');

test('threshold is max(200, 2 % of the library)', () => {
  assert.equal(policy.pruneHoldThreshold(0), 200);
  assert.equal(policy.pruneHoldThreshold(5_000), 200);
  assert.equal(policy.pruneHoldThreshold(76_336), 1_527);
});

test('nothing missing: prune (a no-op)', () => {
  assert.deepEqual(policy.decidePrune({ missing: 0, knownTracks: 1000, scanning: true, confirmed: false }), { prune: true });
});

test('an ordinary deletion prunes as before', () => {
  assert.deepEqual(policy.decidePrune({ missing: 40, knownTracks: 76_336, scanning: false, confirmed: false }), { prune: true });
  assert.deepEqual(policy.decidePrune({ missing: 1_527, knownTracks: 76_336, scanning: null, confirmed: false }), { prune: true });
});

test('a mass removal is held until confirmed', () => {
  const held = policy.decidePrune({ missing: 30_000, knownTracks: 76_336, scanning: false, confirmed: false });
  assert.equal(held.prune, false);
  assert.equal(held.prune === false && held.reason, 'mass-loss');
  assert.match(held.prune === false ? held.message : '', /--confirm-prune/);
  assert.deepEqual(policy.decidePrune({ missing: 30_000, knownTracks: 76_336, scanning: false, confirmed: true }), { prune: true });
});

test('nothing is pruned while Navidrome is scanning, confirmed or not', () => {
  for (const confirmed of [false, true]) {
    const d = policy.decidePrune({ missing: 5, knownTracks: 76_336, scanning: true, confirmed });
    assert.equal(d.prune === false && d.reason, 'scanning');
  }
});

test('an unknown scan status does not block an ordinary prune', () => {
  assert.deepEqual(policy.decidePrune({ missing: 5, knownTracks: 1000, scanning: null, confirmed: false }), { prune: true });
});

// ---- adoptAndPrune against a real DB --------------------------------------

await db.open({ embeddingDim: 8, adoptStoredDim: true });
const seed = (n: number, prefix: string) => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${String(i).padStart(5, '0')}`;
    db.upsertTrackMeta(id, { title: `T ${id}`, artist: 'A', album: 'B', duration: 200 });
    db.upsertTrackTags(id, { moods: ['warm'], energy: 'medium', source: 'llm', confidence: 0.9 });
    ids.push(id);
  }
  return ids;
};
// Ids with no rotated canonical image (lower-case + digits, not 32-hex), so
// adoption leaves them alone and only the prune decides.
const kept = seed(500, 'keep-');
const gone = seed(300, 'gone-');

test('a walk that misses 300 of 800 tracks holds the removal', async () => {
  const r = await rotation.adoptAndPrune(new Set(kept));
  assert.equal(r.pruned, 0);
  assert.equal(r.held?.reason, 'mass-loss');
  assert.equal(db.trackCount(), 800, 'every row, with its tags, is still there');
  assert.equal(db.countMissingTracks(new Set(kept)), 300);
});

test('the same removal goes through once confirmed', async () => {
  const r = await rotation.adoptAndPrune(new Set(kept), { confirmMassPrune: true });
  assert.equal(r.pruned, 300);
  assert.equal(r.held, undefined);
  assert.equal(db.trackCount(), 500);
});

test('a small removal needs no confirmation', async () => {
  const r = await rotation.adoptAndPrune(new Set(kept.slice(0, 490)));
  assert.equal(r.pruned, 10);
  assert.equal(r.held, undefined);
  assert.equal(db.trackCount(), 490);
  assert.equal(gone.length, 300);
});

test.after(() => {
  db.close?.();
  rmSync(stateDir, { recursive: true, force: true });
});
