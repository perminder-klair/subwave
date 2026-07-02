// Integration tests for library-db's embedding-dim reconciliation in migrate().
//
// Pins the fix for the qwen3-embedding crash (Discord: "Subwave seems hardcoded
// to 768D"): the live controller creates track_vectors at the name→dim GUESS
// (768 for an unknown model) before the tagger probes the real width (1024), and
// the old check — keyed off the absent embedding_meta row rather than the table's
// own FLOAT[N] schema — neither recreated the table nor errored, so every embed
// insert crashed and wiping the DB didn't help.
//
// These run a REAL better-sqlite3 + sqlite-vec DB against a temp STATE_DIR, so
// STATE_DIR is set before library-db is imported (dynamic import below).
// Run: `tsx scripts/embedding-dim-migrate.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-dim-'));
  process.env.STATE_DIR = stateDir;

  // Imported AFTER STATE_DIR is set so DB_PATH resolves into the temp dir.
  const db = await import('../src/music/library-db.js');

  const vec = (dim: number) => new Float32Array(dim).fill(0.1);

  console.log('embedding-dim reconciliation (migrate):');

  await test('empty guessed-dim table self-heals to the real dim on a normal tag run', async () => {
    // Controller boots a fresh DB at the name→dim guess (768), writes no meta.
    await db.open({ embeddingDim: 768, adoptStoredDim: true });
    db.close();
    // Tagger probes the real dim (1024) on a NORMAL run — no --reseed.
    await db.open({ embeddingDim: 1024, reseed: false });
    // The empty 768 table is recreated at 1024, and 1024-d inserts succeed.
    assert.doesNotThrow(() => db.upsertTrackVector('t1', vec(1024)));
    assert.equal(db.hasVector('t1'), true);
    db.close();
  });

  await test('a POPULATED dim mismatch is gated behind --reseed (no silent wipe)', async () => {
    await assert.rejects(
      () => db.open({ embeddingDim: 512, reseed: false }),
      /embedding dim mismatch/i,
    );
    // DB left intact — the 1024-d vector from the previous test survives.
    await db.open({ embeddingDim: 1024, adoptStoredDim: true });
    assert.equal(db.hasVector('t1'), true);
    db.close();
  });

  await test('--reseed drops a populated index and recreates at the new dim', async () => {
    await db.open({ embeddingDim: 512, reseed: true });
    assert.equal(db.hasVector('t1'), false); // old vectors dropped
    assert.doesNotThrow(() => db.upsertTrackVector('t2', vec(512)));
    db.close();
  });

  await test('live controller adopts the on-disk dim over a wrong name→dim guess (#319)', async () => {
    // Table is 512 on disk (from the reseed above); controller boots guessing 768.
    await db.open({ embeddingDim: 768, adoptStoredDim: true });
    // It adopts 512 rather than wiping — the populated index keeps working.
    assert.doesNotThrow(() => db.upsertTrackVector('t3', vec(512)));
    assert.equal(db.hasVector('t2'), true);
    db.close();
  });

  await test('dim-change reseed: embeddedIds() is empty but unembeddedIds() is the whole library', async () => {
    // Fresh DB for this scenario (the tests above left vectors around).
    db.close();
    for (const f of ['library.db', 'library.db-wal', 'library.db-shm']) {
      rmSync(join(stateDir, f), { force: true });
    }
    // A populated 768-d index: three tracks, each embedded.
    await db.open({ embeddingDim: 768, reseed: false });
    for (const id of ['a', 'b', 'c']) {
      db.upsertTrackMeta(id, { title: id, artist: 'x', album: 'y', year: 2020, genre: 'z' });
      db.upsertTrackVector(id, vec(768));
    }
    assert.equal(db.embeddedIds().length, 3);
    db.close();

    // Model swap to a 1024-d model → the tagger opens with reseed:true. migrate
    // drops the mismatched populated table, so the OLD snapshot source (the set
    // captured AFTER open) comes back empty — which is why "Re-embed all tracks"
    // silently rebuilt 0 vectors on exactly the model swap it advertises.
    await db.open({ embeddingDim: 1024, reseed: true });
    assert.deepEqual(db.embeddedIds(), []);
    // The fix's fallback source yields the whole library to re-embed instead.
    const reembed = db.unembeddedIds();
    assert.deepEqual([...reembed].sort(), ['a', 'b', 'c']);
    for (const id of reembed) db.upsertTrackVector(id, vec(1024));
    assert.equal(db.embeddedIds().length, 3);
    db.close();
  });

  await test('embedding_meta round-trips text_mode; legacy rows read as null', async () => {
    await db.open({ embeddingDim: 1024, adoptStoredDim: true });
    // Legacy write (no mode) — reads back null, which resolveIndexTextMode
    // treats as 'plain' on a populated index.
    db.setEmbeddingMeta('ollama:nomic-embed-text', 1024);
    assert.equal(db.getEmbeddingMeta()?.textMode, null);
    db.setEmbeddingMeta('ollama:nomic-embed-text', 1024, 'prefixed');
    assert.equal(db.getEmbeddingMeta()?.textMode, 'prefixed');
    db.close();
  });

  rmSync(stateDir, { recursive: true, force: true });

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall embedding-dim migrate tests passed');
}

main();
