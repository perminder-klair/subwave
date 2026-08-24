// Tests for the airing-memory policy (music/airing.ts) and the plays-table
// queries behind it (library-db/plays.ts lastAiredIndex/deepCutTracks).
//
// Pins the exploration half of the repeated-songs fix: the plays table records
// every airing durably, but no picking path ever read it, so a track unaired
// for two years and one aired yesterday had identical draw probability in
// every sampled source. The freshness signal must be a soft ranking BIAS
// (random-dominant, never a hard filter), and deep cuts must surface tracks
// that never aired or fell out of rotation.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR, so STATE_DIR is set
// before library-db is imported (dynamic import below), matching
// scripts/stem-backfill.test.ts.
// Run: `tsx scripts/airing.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-airing-'));
  process.env.STATE_DIR = stateDir;

  const airing = await import('../src/music/airing.js');
  const db = await import('../src/music/library-db.js');
  const now = Date.now();

  console.log('freshness ramp:');

  await test('never aired is fully fresh; just aired is fully stale', () => {
    assert.equal(airing.freshness(null, now), 1);
    assert.equal(airing.freshness(undefined, now), 1);
    assert.equal(airing.freshness(now, now), 0);
    // Clock skew: a play stamped in the future never yields a negative.
    assert.equal(airing.freshness(now + DAY, now), 0);
  });

  await test('the ramp is linear to the horizon, then saturates', () => {
    const half = airing.freshness(now - (airing.AIRING_FRESH_DAYS / 2) * DAY, now);
    assert.ok(Math.abs(half - 0.5) < 1e-9, `expected 0.5 at half-horizon, got ${half}`);
    assert.equal(airing.freshness(now - airing.AIRING_FRESH_DAYS * DAY, now), 1);
    assert.equal(airing.freshness(now - 10 * airing.AIRING_FRESH_DAYS * DAY, now), 1);
  });

  console.log('\nlastAiredMsOf:');

  await test('id hit wins; title|artist key catches duplicate copies; miss is null', () => {
    const index = {
      byId: new Map([['id-1', now - DAY]]),
      byKey: new Map([['song|artist', now - 2 * DAY]]),
    };
    assert.equal(airing.lastAiredMsOf({ id: 'id-1', title: 'Other', artist: 'X' }, index), now - DAY);
    // A different Subsonic id for the same tagged song resolves via the key.
    assert.equal(airing.lastAiredMsOf({ id: 'id-2', title: 'Song', artist: 'Artist' }, index), now - 2 * DAY);
    assert.equal(airing.lastAiredMsOf({ id: 'id-3', title: 'Unheard', artist: 'Y' }, index), null);
  });

  console.log('\nunaired flag (an unanswerable index must not answer):');

  await test('an empty index yields undefined, never "everything is unaired"', () => {
    // EMPTY_AIRED_INDEX is what library.lastAiredInfo() returns on BOTH of its
    // failure paths (unloaded library, a thrown DB read). Read as history, every
    // candidate carries `unaired: true` and PICKER_CRITERIA's VARIETY rule tells
    // the model to prefer all of them equally — a uniform lie rather than an
    // absent signal, with nothing distinguishing the two.
    assert.equal(airing.hasAiringHistory(airing.EMPTY_AIRED_INDEX), false);
    assert.equal(airing.unairedFlag({ id: 'anything', title: 'T', artist: 'A' }, airing.EMPTY_AIRED_INDEX), undefined);
  });

  await test('with real history the flag is true only for tracks with no airing', () => {
    const index = { byId: new Map([['aired', now - DAY]]), byKey: new Map<string, number>() };
    assert.equal(airing.hasAiringHistory(index), true);
    assert.equal(airing.unairedFlag({ id: 'aired', title: 'A', artist: 'a' }, index), undefined);
    assert.equal(airing.unairedFlag({ id: 'unheard', title: 'B', artist: 'b' }, index), true);
  });

  await test('a key-only index still counts as history', () => {
    // Backfilled plays carry no track id; the key half alone is real history.
    const index = { byId: new Map<string, number>(), byKey: new Map([['song|artist', now - DAY]]) };
    assert.equal(airing.hasAiringHistory(index), true);
    assert.equal(airing.unairedFlag({ id: 'x', title: 'Song', artist: 'Artist' }, index), undefined);
    assert.equal(airing.unairedFlag({ id: 'y', title: 'Other', artist: 'Artist' }, index), true);
  });

  console.log('\nfreshness-biased order:');

  await test('unaired tracks win the cap more often, but never deterministically', () => {
    const index = { byId: new Map([['aired', now]]), byKey: new Map<string, number>() };
    const list = [
      { id: 'aired', title: 'A', artist: 'a' },
      { id: 'unheard', title: 'B', artist: 'b' },
    ];
    let unheardFirst = 0;
    let airedFirst = 0;
    for (let i = 0; i < 2000; i++) {
      const first = airing.freshnessBiasedOrder(list, index, now)[0];
      if (first.id === 'unheard') unheardFirst++;
      else airedFirst++;
    }
    // Analytically P(unheard first) = 1 - (1 - w)^2 / 2 ≈ 0.82 at w = 0.4.
    assert.ok(unheardFirst / 2000 > 0.65, `bias too weak: ${unheardFirst}/2000`);
    assert.ok(airedFirst > 0, 'bias must stay soft — the aired track must still sometimes lead');
  });

  await test('with no play history the order is a plain shuffle', () => {
    const list = [
      { id: 'x', title: 'X', artist: 'x' },
      { id: 'y', title: 'Y', artist: 'y' },
    ];
    let xFirst = 0;
    for (let i = 0; i < 2000; i++) {
      if (airing.freshnessBiasedOrder(list, airing.EMPTY_AIRED_INDEX, now)[0].id === 'x') xFirst++;
    }
    assert.ok(xFirst / 2000 > 0.4 && xFirst / 2000 < 0.6, `not uniform: ${xFirst}/2000`);
  });

  console.log('\nplays-table queries (real DB):');

  await db.open({ embeddingDim: 768, adoptStoredDim: true });
  for (const id of ['t1', 't2', 't3']) {
    db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200 });
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  // t1 aired twice (yesterday wins), t2 aired long ago, t3 never; plus an
  // id-less backfilled play that must land in the key index only.
  db.recordPlay({ trackId: 't1', title: 'Song t1', artist: 'A', album: 'B', playedAt: iso(now - 40 * DAY), source: 'ai', requestedBy: null, showId: null, showName: null });
  db.recordPlay({ trackId: 't1', title: 'Song t1', artist: 'A', album: 'B', playedAt: iso(now - DAY), source: 'ai', requestedBy: null, showId: null, showName: null });
  db.recordPlay({ trackId: 't2', title: 'Song t2', artist: 'A', album: 'B', playedAt: iso(now - 60 * DAY), source: 'auto', requestedBy: null, showId: null, showName: null });
  db.recordPlay({ trackId: null, title: 'Ghost Play', artist: 'Nobody', album: null, playedAt: iso(now - 2 * DAY), source: 'auto', requestedBy: null, showId: null, showName: null });

  await test('lastAiredIndex keeps the NEWEST airing per id and per key', () => {
    const idx = db.lastAiredIndex();
    assert.equal(idx.byId.get('t1'), Date.parse(iso(now - DAY)));
    assert.equal(idx.byId.get('t2'), Date.parse(iso(now - 60 * DAY)));
    assert.equal(idx.byId.get('t3'), undefined);
    assert.equal(idx.byKey.get('song t1|a'), Date.parse(iso(now - DAY)));
    assert.equal(idx.byKey.get('ghost play|nobody'), Date.parse(iso(now - 2 * DAY)));
  });

  await test('deepCutTracks returns never-aired + long-unaired, not the recent airing', () => {
    const cutoff = iso(now - airing.DEEP_CUT_DAYS * DAY);
    const ids = db.deepCutTracks(cutoff, 10).map((t) => t.id).sort();
    // t1 aired yesterday (in rotation); t2's last airing predates the cutoff;
    // t3 never aired at all.
    assert.deepEqual(ids, ['t2', 't3']);
  });

  await test('deepCutTracks honours its limit', () => {
    const cutoff = iso(now + DAY); // everything qualifies
    assert.equal(db.deepCutTracks(cutoff, 2).length, 2);
  });

  await test('deepCutTracks still returns whole track records after the id/row split', () => {
    // The sampling runs as an id-only scan plus a row fetch (so a 50k library
    // isn't materialised in full, fat JSON columns and all, to keep 60 rows).
    // The caller still gets rowToTrack output, not bare ids.
    const cutoff = iso(now + DAY);
    const rows = db.deepCutTracks(cutoff, 10);
    const t3 = rows.find((r) => r.id === 't3');
    assert.ok(t3, 't3 missing from the sample');
    assert.equal(t3!.title, 'Song t3');
    assert.equal(t3!.artist, 'A');
  });


  console.log('\nrecency-aware KNN (excludeIds):');

  await test('excluded ids are skipped IN the walk, widening to the next neighbours out', () => {
    // Three vectors on a line: t1 (seed) closest to t2, then t3. Excluding t2
    // must yield t3 — the next neighbour out — not an empty result, which is
    // what a post-hoc filter over a k=1 fetch would produce.
    const vec = (x: number) => {
      const v = new Float32Array(768);
      v[0] = 1; v[1] = x;
      return v;
    };
    db.upsertTrackVector('t1', vec(0), db.resolvedEraYearForTrack('t1'));
    db.upsertTrackVector('t2', vec(0.1), db.resolvedEraYearForTrack('t2'));
    db.upsertTrackVector('t3', vec(0.3), db.resolvedEraYearForTrack('t3'));
    assert.deepEqual(db.knnById('t1', 1).map((h) => h.id), ['t2']);
    assert.deepEqual(
      db.knnById('t1', 1, { excludeIds: new Set(['t2']) }).map((h) => h.id),
      ['t3'],
    );
    // The seed itself stays excluded alongside the set.
    assert.ok(!db.knnById('t1', 5, { excludeIds: new Set(['t2']) }).some((h) => h.id === 't1'));
  });

  await test('a huge exclude set of NON-indexed ids still returns k', () => {
    // The picker passes its recency union, most of whose ids were never
    // embedded (auto.m3u plays, backfilled history) and so cannot displace a
    // hit. Widening LIMIT by the raw set SIZE read hundreds of rows to discard;
    // the bounded first pass must still find k.
    const ghosts = new Set(Array.from({ length: 800 }, (_, i) => `ghost-${i}`));
    assert.deepEqual(db.knnById('t1', 2, { excludeIds: ghosts }).map((h) => h.id), ['t2', 't3']);
  });

  await test('an exclude set that really covers the near neighbours falls through to the exact pass', () => {
    // k=1 bounds the first pass at seed + k + 3k rows. Excluding more near
    // neighbours than that must still reach the survivor rather than come back
    // short — that is the guarantee the raw-size widening gave, and the bounded
    // pass is only allowed to be cheaper, never wrong.
    for (let i = 0; i < 8; i++) {
      const v = new Float32Array(768);
      v[0] = 1; v[1] = 0.11 + i * 0.001;
      db.upsertTrackMeta(`n${i}`, { title: `Near ${i}`, artist: 'A', album: 'B', duration: 200 });
      db.upsertTrackVector(`n${i}`, v, db.resolvedEraYearForTrack(`n${i}`));
    }
    const near = new Set(['t2', ...Array.from({ length: 8 }, (_, i) => `n${i}`)]);
    assert.deepEqual(db.knnById('t1', 1, { excludeIds: near }).map((h) => h.id), ['t3']);
  });

  console.log('\naudio-vector coverage probe:');

  await test('hasAudioVector reports coverage without decoding the blob', () => {
    const v = new Float32Array(512);
    v[0] = 1;
    db.upsertTrackAudioVector('t2', v);
    assert.equal(db.hasAudioVector('t2'), true);
    assert.equal(db.hasAudioVector('t3'), false);
    assert.equal(db.hasAudioVector('nope'), false);
  });

  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
