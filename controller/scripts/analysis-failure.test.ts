// Tests for the per-track analysis failure stamp (#1300 bug 3c) — the columns
// that let a track that can NEVER be analysed stop re-entering the queue, and
// let something finally name it.
//
// The reported shape: "audio backfill: +90 already-analysed tracks missing an
// audio vector", the same 90, every run, forever, with nothing in the UI, the
// API or the logs saying WHICH tracks. Half of that was a backend lying about
// its capability (analyze-capability.test.ts covers the other half); this half
// is a file the analyzer throws on. Every analysis column stays NULL after a
// throw, which is byte-identical to "never attempted", so the scope re-targets
// it on every pass.
//
// The contracts pinned here:
//   - a failure stamps the reason and increments a count;
//   - the count is CONSECUTIVE — a success wipes it, so a flaky mount doesn't
//     sentence a track that analyses fine the next night;
//   - past MAX_ANALYSIS_FAILURES the track leaves EVERY analysis scope, not
//     just the bpm/key one (the three widenings would otherwise keep pulling
//     it back in, which is the same churn in a different query);
//   - a --re-analyze and an explicit clear both restore it, so "give up" is
//     never permanent.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR, so STATE_DIR is set
// before library-db is imported — same shape as stem-backfill.test.ts.
// Run: `tsx scripts/analysis-failure.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
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
  const stateDir = createTempDir(join(tmpdir(), 'subwave-analyze-fail-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  await db.open({ embeddingDim: 768, adoptStoredDim: true });

  for (const id of ['t1', 't2', 't3']) {
    db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200 });
  }

  console.log('analysis failure stamp:');

  await test('a clean library reports no failures', () => {
    assert.equal(db.analysisFailedCount(), 0);
    assert.deepEqual(db.analysisFailures(), []);
    assert.deepEqual(db.needsAnalysisIds(), ['t1', 't2', 't3']);
  });

  await test('a failure records the reason and counts the attempt', () => {
    db.recordAnalysisFailure('t1', 'Subsonic error: song not found');
    const rows = db.analysisFailures();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 't1');
    assert.equal(rows[0].error, 'Subsonic error: song not found');
    assert.equal(rows[0].attempts, 1);
    // One failure is not a sentence — still retried, still in scope.
    assert.equal(rows[0].excluded, false);
    assert.deepEqual(db.needsAnalysisIds(), ['t1', 't2', 't3']);
    assert.equal(db.analysisFailedCount(), 0);
  });

  await test('the track leaves the bpm/key scope once it hits the limit', () => {
    for (let i = 1; i < db.MAX_ANALYSIS_FAILURES; i++) {
      db.recordAnalysisFailure('t1', 'Subsonic error: song not found');
    }
    assert.deepEqual(db.needsAnalysisIds(), ['t2', 't3']);
    assert.equal(db.analysisFailedCount(), 1);
    assert.equal(db.analysisFailures()[0].excluded, true);
  });

  await test('…and every widened scope with it, not just bpm/key', () => {
    // The three backfill widenings live in a different module and query the
    // tracks table directly. A widening that forgets the exclusion re-attempts
    // the dead track on every pass — the exact bug, relocated.
    assert.ok(!db.unanalysedAudioIds().includes('t1'), 'audio backfill still targets it');
    assert.ok(!db.needsVocalIds().includes('t1'), 'vocal backfill still targets it');
    assert.ok(!db.needsStemsIds().includes('t1'), 'stem backfill still targets it');
    // The healthy tracks are untouched.
    assert.deepEqual(db.needsVocalIds(), ['t2', 't3']);
  });

  await test('a success wipes the history — the count is CONSECUTIVE failures', () => {
    db.recordAnalysisFailure('t2', 'read ECONNRESET');
    db.recordAnalysisFailure('t2', 'read ECONNRESET');
    assert.equal(db.analysisFailures().find(r => r.id === 't2')?.attempts, 2);
    // t2 analyses fine on the next pass: it must start from zero rather than
    // carry two strikes into whenever it is next re-analysed.
    db.upsertTrackAnalysis('t2', { bpm: 120, musicalKey: 'Am' });
    assert.equal(db.analysisFailures().find(r => r.id === 't2'), undefined);
  });

  await test('an explicit clear puts a given-up track back in scope', () => {
    assert.equal(db.clearAnalysisFailures('t1'), 1);
    assert.equal(db.analysisFailedCount(), 0);
    assert.deepEqual(db.needsAnalysisIds(), ['t1', 't3']); // t2 is analysed now
  });

  await test('a --re-analyze clears failures too', () => {
    for (let i = 0; i < db.MAX_ANALYSIS_FAILURES; i++) {
      db.recordAnalysisFailure('t3', 'decode failed');
    }
    assert.equal(db.analysisFailedCount(), 1);
    // Without this, the tracks most in need of a retry would be the only ones
    // an explicit "do it all again" skipped.
    db.clearAnalysis();
    assert.equal(db.analysisFailedCount(), 0);
    assert.deepEqual(db.needsAnalysisIds(), ['t1', 't2', 't3']);
  });

  await test('clearing everything at once reports how many it touched', () => {
    db.recordAnalysisFailure('t1', 'x');
    db.recordAnalysisFailure('t3', 'y');
    assert.equal(db.clearAnalysisFailures(), 2);
    assert.equal(db.clearAnalysisFailures(), 0);
  });

  await test('the reason is truncated, not stored unbounded', () => {
    // Stack traces and multi-hundred-KB HTML error bodies both end up here.
    db.recordAnalysisFailure('t1', 'e'.repeat(5000));
    assert.equal(db.analysisFailures()[0].error?.length, 500);
  });

  db.close?.();
  if (failures > 0) {
    console.error(`✗ analysis-failure.test.ts: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('✓ analysis-failure.test.ts passed');
}

main();
