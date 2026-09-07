// The schema-mirror guard for Navidrome ID adoption
// (music/library-db/id-adoption.ts).
//
// Adoption moves a rotated track's derived data onto its new id. Which columns
// move used to be a hand-written list, and that list went stale the way every
// hand-written mirror of a growing schema does: seven columns landed after it
// was written (lead/tail silence, tail_start_ms, the three analyze-failure
// counters, text_vector_dirty) and every one of them would have been dropped
// on every adopted row — with `analysis_version` carried on top, so nothing
// would ever have re-derived them. The library would have come out of the
// migration quietly missing days of analysis, and no test would have noticed.
//
// So the carried set is now DERIVED (all physical columns minus the walk-owned
// denylist) and this file is the reminder that survives the next migration:
// every column must be CLASSIFIED — walk-owned, grouped, special, or carried
// by the COALESCE default. The runtime default is safe either way, which is
// the point: this test fails the suite, not the operator's library.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR so the classification
// is checked against the schema `migrate()` actually builds, not a copy of it.
// STATE_DIR is set before library-db is imported (dynamic import below),
// matching scripts/stem-backfill.test.ts.
// Run: `tsx scripts/id-adoption-columns.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-adopt-cols-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

const plan = db.columnPlan();

test('every physical tracks column is classified', () => {
  assert.deepEqual(
    plan.unclassified,
    [],
    `unclassified tracks column(s): ${plan.unclassified.join(', ')}.\n` +
      '      A migration added these. They are carried by the COALESCE default, which is\n' +
      '      the safe answer — but decide explicitly in library-db/id-adoption.ts:\n' +
      '        • re-derived by the walk (upsertTrackMeta)  → add to WALK_OWNED\n' +
      '        • written atomically with an existing group → add to that group\n' +
      '        • NOT NULL, or needs a bespoke rule         → add to SPECIAL + mergeRow()\n' +
      '        • otherwise                                 → leave it; just list it here.',
  );
});

test('no classification rule names a column the table no longer has', () => {
  assert.deepEqual(
    plan.missing,
    [],
    `id-adoption.ts names column(s) absent from tracks: ${plan.missing.join(', ')}. ` +
      'A rename would silently stop carrying them.',
  );
});

test('the walk-owned denylist is the only thing NOT carried', () => {
  const carried = new Set([
    ...plan.grouped.flatMap((g) => g.cols),
    ...plan.coalesced,
    ...plan.special,
  ]);
  // `id` is the key being rewritten; `genre` is GENERATED ALWAYS and PRAGMA
  // table_info omits it, so it never reaches the plan at all.
  const expected = plan.all.filter((c) => c !== 'id' && !plan.walkOwned.includes(c));
  assert.deepEqual([...carried].sort(), expected.sort());
  assert.ok(!carried.has('genre'), 'genre is GENERATED ALWAYS — writing it throws');
});

// The seven columns the hand-written list had already lost. Named individually
// rather than trusted to the derivation, because "it is derived now" is exactly
// the claim under test.
test('the columns the hand-written list dropped are carried', () => {
  const carried = new Set([
    ...plan.grouped.flatMap((g) => g.cols),
    ...plan.coalesced,
    ...plan.special,
  ]);
  for (const col of [
    'lead_silence_ms', 'tail_silence_ms', 'tail_start_ms',
    'analyze_error', 'analyze_failed_at', 'analyze_fail_count',
    'text_vector_dirty',
  ]) {
    assert.ok(carried.has(col), `${col} must be carried across a rotated id`);
  }
});

// A success on the NEW row must clear the OLD row's strikes, so the trio has to
// ride the analysis anchor rather than COALESCE — a COALESCE would resurrect
// three failures onto a track that had just analysed cleanly.
test('the analyze-failure counters ride the analysis group, not COALESCE', () => {
  const analysis = plan.grouped.find((g) => g.anchor === 'analysis_version');
  assert.ok(analysis, 'analysis group present');
  for (const col of ['analyze_error', 'analyze_failed_at', 'analyze_fail_count']) {
    assert.ok(analysis.cols.includes(col), `${col} belongs to the analysis group`);
    assert.ok(!plan.coalesced.includes(col), `${col} must not be a plain COALESCE`);
  }
});

test('walk-owned columns are never written by adoption', () => {
  // Spot-check the ones a rotation would visibly corrupt: carrying a stale
  // album_id/artist_id would re-break the album blocks #1467 fixed.
  for (const col of ['title', 'artist', 'album', 'album_id', 'artist_id', 'genres', 'era_untrusted']) {
    assert.ok(plan.walkOwned.includes(col), `${col} is walk-owned`);
    assert.ok(!plan.coalesced.includes(col), `${col} must not be carried`);
    assert.ok(
      !plan.grouped.some((g) => g.cols.includes(col)),
      `${col} must not be carried`,
    );
  }
});

test.after(() => {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
});
