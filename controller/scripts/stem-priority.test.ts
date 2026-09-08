// Stem scan-order + retention ranking (#1622 FR 14) — music/stem-priority.ts,
// its SQL projection in library-db/stem-scan.ts, and the eviction order the
// byte-budget sweep now uses.
//
// The load-bearing property is AGREEMENT: the ranking is a pure scorer that
// nothing in production calls, and a SQL expression that everything in
// production calls. Two implementations of one rule drift silently — the era
// filter's lesson — so the first block below scores every crafted row BOTH
// ways and demands the same integer, branch by branch.
//
// The second property is that nothing is starved. `ORDER BY id` over opaque
// Navidrome hashes was a lottery, but a FROZEN one: on a library bigger than
// the stem budget the same tail lost every night. The tie class (both grids,
// never aired, unliked — most of a real library) is redrawn per pass, and the
// eviction order can no longer throw away what the scan just earned.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR, so STATE_DIR is set
// before library-db is imported (dynamic import below), matching
// scripts/stem-backfill.test.ts.
// Run: `tsx scripts/stem-priority.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-stem-priority-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  const policy = await import('../src/music/stem-priority.js');
  const stemCache = await import('../src/music/stem-cache.js');
  await db.open({ embeddingDim: 768, adoptStoredDim: true });

  const W = policy.STEM_PRIORITY_WEIGHTS;

  // -------------------------------------------------------------------------
  // The pure rule
  // -------------------------------------------------------------------------

  const facts = (over: Partial<import('../src/music/stem-priority.js').StemPriorityFacts> = {}) => ({
    hasHeadGrid: false,
    hasTailGrid: false,
    recentPlays: 0,
    everAired: false,
    airedRecently: false,
    operatorHeart: false,
    listenerLiked: false,
    ...over,
  });

  console.log('the ranking rule:');

  await test('a track with no bar grid scores zero however loved it is', () => {
    // The only consumer (broadcast/stem-blend.ts) rejects a track with no head
    // grid as an incoming side and no tail grid as an outgoing one, so its
    // stems are bytes that can never be spent. This is the single biggest win
    // of the whole ranking and it must not be reachable by any other signal.
    const beloved = facts({
      operatorHeart: true, listenerLiked: true,
      recentPlays: 99, everAired: true, airedRecently: true,
    });
    assert.equal(policy.stemPriority(beloved), 0);
    assert.equal(policy.seamSides(beloved), 0);
  });

  await test('seam sides MULTIPLY the value, they do not tier it', () => {
    // Both directions of the design matter. Untouched tracks are ordered by
    // how many sides of a seam they could serve (a pure tier could not do
    // this if value were merely added on top)…
    const bothUntouched = policy.stemPriority(facts({ hasHeadGrid: true, hasTailGrid: true }));
    const oneUntouched = policy.stemPriority(facts({ hasHeadGrid: true }));
    assert.equal(bothUntouched, 2 * W.base);
    assert.equal(oneUntouched, W.base);
    assert.ok(bothUntouched > oneUntouched);

    // …and a one-sided track with real curation still outranks a both-sided
    // one with no signal at all, so no class is sealed off from the top.
    const oneHearted = policy.stemPriority(facts({ hasHeadGrid: true, operatorHeart: true }));
    assert.ok(oneHearted > bothUntouched, `${oneHearted} !> ${bothUntouched}`);
  });

  await test('operator curation outranks a listener like', () => {
    const op = policy.stemPriority(facts({ hasHeadGrid: true, hasTailGrid: true, operatorHeart: true }));
    const listener = policy.stemPriority(facts({ hasHeadGrid: true, hasTailGrid: true, listenerLiked: true }));
    assert.ok(op > listener, `${op} !> ${listener}`);
  });

  await test('recent airplay saturates instead of dwarfing every other signal', () => {
    const at = (n: number) => policy.stemPriority(facts({ hasHeadGrid: true, hasTailGrid: true, recentPlays: n }));
    assert.equal(at(W.recentPlayCap), at(W.recentPlayCap + 500));
    assert.ok(at(3) > at(0));
    // The cap is what keeps the value half bounded, which is what lets the
    // seam multiplier stay meaningful.
    assert.equal(
      policy.stemPriority(facts({
        hasHeadGrid: true, hasTailGrid: true, operatorHeart: true, listenerLiked: true,
        recentPlays: 10_000, everAired: true, airedRecently: true,
      })),
      2 * policy.MAX_VALUE_SCORE,
    );
  });

  await test('a negative or fractional play count cannot go below the floor', () => {
    assert.equal(
      policy.stemPriority(facts({ hasHeadGrid: true, recentPlays: -5 })),
      W.base,
    );
    assert.equal(
      policy.stemPriority(facts({ hasHeadGrid: true, recentPlays: 2.9 })),
      W.base + 2 * W.perRecentPlay,
    );
  });

  // -------------------------------------------------------------------------
  // The SQL projection
  // -------------------------------------------------------------------------

  // One row per branch of the score. Written straight through the DB handle
  // where a normal writer could not produce the shape (a malformed column, a
  // tail grid with an invalid `ending`).
  const handle = db.requireDb();
  const rawAnalysis = handle.prepare(
    `UPDATE tracks SET bars_json = ?, outro_json = ?, analysis_version = 7 WHERE id = ?`,
  );
  const bars = JSON.stringify([0, 2000, 4000]);
  const outro = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ startMs: 180_000, ending: 'fade', bars: [180_000, 182_000], ...over });

  const rows: Array<{ id: string; bars: string | null; outro: string | null; duration: number }> = [
    { id: 'both',           bars,       outro: outro(),                      duration: 200 },
    { id: 'head-only',      bars,       outro: null,                         duration: 200 },
    { id: 'tail-only',      bars: null, outro: outro(),                      duration: 200 },
    { id: 'no-grid',        bars: null, outro: null,                         duration: 200 },
    { id: 'empty-bars',     bars: '[]', outro: outro({ bars: [] }),          duration: 200 },
    { id: 'malformed',      bars: '{oh no',  outro: 'not json at all',       duration: 200 },
    { id: 'bad-ending',     bars,       outro: outro({ ending: 'wobble' }),  duration: 200 },
    { id: 'bad-start',      bars,       outro: outro({ startMs: -1 }),       duration: 200 },
    { id: 'no-duration',    bars,       outro: outro(),                      duration: 0 },
    { id: 'hot',            bars,       outro: outro(),                      duration: 200 },
    { id: 'stale',          bars,       outro: outro(),                      duration: 200 },
    { id: 'ancient',        bars,       outro: outro(),                      duration: 200 },
    { id: 'heavy',          bars,       outro: outro(),                      duration: 200 },
    { id: 'op-heart',       bars,       outro: outro(),                      duration: 200 },
    { id: 'listener-like',  bars,       outro: outro(),                      duration: 200 },
  ];
  for (const r of rows) {
    db.upsertTrackMeta(r.id, { title: `Song ${r.id}`, artist: 'A', album: 'B', duration: r.duration });
    rawAnalysis.run(r.bars, r.outro, r.id);
  }

  const play = (id: string, at: string) =>
    db.recordPlay({
      trackId: id, title: `Song ${id}`, artist: 'A', album: 'B',
      playedAt: at, source: 'ai', requestedBy: null, showId: null, showName: null,
    });

  play('hot', daysAgo(2));                       // inside both windows
  play('stale', daysAgo(40));                    // inside the 90d window only
  play('ancient', daysAgo(400));                 // outside both, but ever-aired
  for (let i = 0; i < 25; i++) play('heavy', daysAgo(1 + i)); // past the cap

  const signals = { operatorLikedIds: ['op-heart'], listenerLikedIds: ['listener-like'], nowMs: NOW };
  const allIds = rows.map(r => r.id);

  console.log('SQL is a projection of the rule, not a second opinion:');

  await test('every crafted row scores identically in SQL and in JS', () => {
    const sqlScores = db.stemPriorityIndex(allIds, signals);
    const rowFacts = db.stemPriorityFactsFor(allIds, signals);
    assert.equal(sqlScores.size, allIds.length);
    for (const id of allIds) {
      const f = rowFacts.get(id);
      assert.ok(f, `no facts for ${id}`);
      assert.equal(
        sqlScores.get(id),
        policy.stemPriority(f),
        `${id}: SQL ${sqlScores.get(id)} vs JS ${policy.stemPriority(f)} for ${JSON.stringify(f)}`,
      );
    }
  });

  await test('the eligibility branches land where the seam gates put them', () => {
    const f = db.stemPriorityFactsFor(allIds, signals);
    const sides = (id: string) => policy.seamSides(f.get(id)!);
    assert.equal(sides('both'), 2);
    assert.equal(sides('head-only'), 1);
    assert.equal(sides('tail-only'), 1);
    assert.equal(sides('no-grid'), 0);
    assert.equal(sides('empty-bars'), 0, 'an empty array is not a grid');
    assert.equal(sides('malformed'), 0, 'a malformed column must not throw the scan');
    assert.equal(sides('bad-ending'), 1, 'parseOutroJson rejects the outro, so head only');
    assert.equal(sides('bad-start'), 1, 'same — a negative startMs is not an outro');
    assert.equal(sides('no-duration'), 1, 'stem-blend needs out.durationSec for the tail side');
  });

  await test('the play windows are read the way the policy defines them', () => {
    const f = db.stemPriorityFactsFor(allIds, signals);
    assert.deepEqual(
      { r: f.get('hot')!.recentPlays, ever: f.get('hot')!.everAired, hot: f.get('hot')!.airedRecently },
      { r: 1, ever: true, hot: true },
    );
    assert.deepEqual(
      { r: f.get('stale')!.recentPlays, ever: f.get('stale')!.everAired, hot: f.get('stale')!.airedRecently },
      { r: 1, ever: true, hot: false },
    );
    assert.deepEqual(
      { r: f.get('ancient')!.recentPlays, ever: f.get('ancient')!.everAired, hot: f.get('ancient')!.airedRecently },
      { r: 0, ever: true, hot: false },
    );
    assert.equal(f.get('both')!.everAired, false, 'a never-aired track claims no airplay');
  });

  await test('an absent like store simply drops the curation term', () => {
    // The tagger CLI never loads state/likes.json, and most stations have no
    // likes at all. That has to cost nothing but the term itself — the same
    // "absent config coerces to the pre-existing behaviour" posture.
    const withLikes = db.stemPriorityIndex(['op-heart', 'both'], signals);
    const without = db.stemPriorityIndex(['op-heart', 'both'], { nowMs: NOW });
    assert.equal(without.get('both'), withLikes.get('both'));
    assert.equal(without.get('op-heart'), 2 * W.base);
    assert.equal(withLikes.get('op-heart'), 2 * (W.base + W.operatorHeart));
  });

  await test('a track with no library row has no score to find', () => {
    assert.equal(db.stemPriorityIndex(['ghost'], signals).size, 0);
    assert.equal(db.stemPriorityIndex([], signals).size, 0);
  });

  // -------------------------------------------------------------------------
  // The scan order
  // -------------------------------------------------------------------------

  console.log('scan order:');

  await test('needsStemsIds hands back the scope in descending priority', () => {
    const ordered = db.needsStemsIds(undefined, signals);
    assert.equal(ordered.length, rows.length, 'nothing has been stem-scanned yet');
    const scores = db.stemPriorityIndex(ordered, signals);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(
        scores.get(ordered[i - 1])! >= scores.get(ordered[i])!,
        `${ordered[i - 1]} (${scores.get(ordered[i - 1])}) before ${ordered[i]} (${scores.get(ordered[i])})`,
      );
    }
    assert.equal(ordered[0], 'heavy', 'the station\'s own heavy rotation goes first');
    assert.equal(scores.get(ordered[ordered.length - 1]), 0, 'an unblendable track is last');
  });

  await test('a limited run takes the top of the ranking, not the top of the id order', () => {
    // 'both' sorts first alphabetically and would have led under ORDER BY id.
    const top = db.needsStemsIds(3, signals);
    assert.equal(top.length, 3);
    assert.deepEqual([...top].sort(), ['heavy', 'hot', 'op-heart']);
  });

  await test('the untouched tie class is redrawn per pass, never frozen', () => {
    // The never-starve property. On a real library most tracks tie exactly
    // (both grids, never aired, unliked) and the budget only ever reaches the
    // first few — so a stable tiebreak means the same tail loses every night,
    // forever. 60 identical rows, 5 slots: a frozen order repeats itself.
    for (let i = 0; i < 60; i++) {
      const id = `tie${String(i).padStart(2, '0')}`;
      db.upsertTrackMeta(id, { title: `Tie ${i}`, artist: 'T', album: 'T', duration: 200 });
      rawAnalysis.run(bars, outro(), id);
    }
    // Six tracks outscore the tie class outright, so a 12-slot draw reaches
    // into it by six — a frozen tiebreak would return the same six forever.
    const drawn = new Set<string>();
    for (let i = 0; i < 8; i++) {
      for (const id of db.needsStemsIds(12, signals)) if (id.startsWith('tie')) drawn.add(id);
    }
    assert.ok(drawn.size > 6, `eight draws only ever reached ${drawn.size} of the 60 tied tracks`);
  });

  await test('a track that has already had a pass leaves the scope for good', () => {
    // Resumption is the stems_at stamp's job, not the order's — which is the
    // whole reason the order is free to be a random-tiebroken ranking.
    db.upsertTrackAnalysis('heavy', { bpm: 120, stemsAttempted: true });
    assert.ok(!db.needsStemsIds(undefined, signals).includes('heavy'));
  });

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  console.log('eviction order:');

  await test('with no priorities at all the sort is the pre-#1622 mtime LRU', () => {
    const dirs = [
      { dir: 'c', mtimeMs: 300, priority: null },
      { dir: 'a', mtimeMs: 100, priority: null },
      { dir: 'b', mtimeMs: 200, priority: null },
    ];
    assert.deepEqual(policy.stemEvictionOrder(dirs).map(d => d.dir), ['a', 'b', 'c']);
  });

  await test('lowest priority goes first, oldest mtime breaks the tie', () => {
    const dirs = [
      { dir: 'loved-but-old', mtimeMs: 1, priority: 900 },
      { dir: 'worthless-new', mtimeMs: 999, priority: 0 },
      { dir: 'mid-old', mtimeMs: 10, priority: 200 },
      { dir: 'mid-new', mtimeMs: 20, priority: 200 },
    ];
    assert.deepEqual(
      policy.stemEvictionOrder(dirs).map(d => d.dir),
      ['worthless-new', 'mid-old', 'mid-new', 'loved-but-old'],
    );
  });

  await test('an orphan dir with no catalogue row is evicted before anything real', () => {
    const dirs = [
      { dir: 'real-but-unblendable', mtimeMs: 1, priority: 0 },
      { dir: 'orphan', mtimeMs: 999, priority: policy.UNKNOWN_TRACK_PRIORITY },
    ];
    assert.deepEqual(policy.stemEvictionOrder(dirs).map(d => d.dir), ['orphan', 'real-but-unblendable']);
  });

  await test('the sweep keeps what the scan earned, not what was written last', async () => {
    // The inversion this fixes: the backfill writes the BEST tracks FIRST, so
    // under the old oldest-mtime-first sweep they were the first evicted — and
    // stems_at stamps the attempt, so they would never be separated again.
    const write = (id: string, mtimeSec: number) => {
      const dir = stemCache.dirFor(id);
      mkdirSync(dir, { recursive: true });
      for (const s of stemCache.STEM_NAMES) {
        const f = join(dir, `head-${s}.flac`);
        writeFileSync(f, Buffer.alloc(1024 ** 2));
        utimesSync(f, mtimeSec, mtimeSec);
      }
    };
    write('op-heart', 1_000);   // scanned first → oldest on disk, highest value
    write('no-grid', 9_000);    // scanned last  → newest on disk, worth nothing

    // 5 MB budget against 8 MB on disk: exactly one dir has to go.
    const swept = await stemCache.sweep(5 * 1024 ** 2);
    assert.equal(swept.removed, 1);
    assert.ok(!existsSync(stemCache.dirFor('no-grid')), 'the unblendable dir is the one evicted');
    assert.ok(existsSync(stemCache.dirFor('op-heart')), 'the hearted dir survives despite being older');
  });

  db.close();

  await test('a sweep with the library DB closed still fits the budget', () => {
    // Fail-open: the priority lookup throws with no open handle, every dir
    // reports a null priority, and the sort degrades to plain mtime LRU rather
    // than the sweep giving up and leaving the cache over budget.
    return stemCache.sweep(1024).then((res) => {
      assert.equal(res.removed, 1);
      assert.equal(res.overBudgetBytes, 0);
    });
  });

  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall stem-priority tests passed');
}

await main();
