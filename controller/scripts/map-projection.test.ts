// Sound-map projection on large libraries (#2314).
//
// umap-js's fit memory grows faster than the library, and a 232k library ran
// the projection child out of heap two minutes in, on every boot, silently.
// Pins: the seeded sample + neighbour placement (every track still gets a
// point, deterministically), the failure record that holds the boot retry
// until the library moves, and the SUBWAVE_MAP_HEAP_MB child env.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR, set before
// library-db is imported (same shape as analysis-failure.test.ts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-map-proj-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const placement = await import('../src/music/map-placement.js');
const policy = await import('../src/music/map-projection-policy.js');
const projection = await import('../src/music/map-projection.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });


const DIM = 512;

// Unit vectors in `clusters` well-separated blobs, deterministic.
function clustered(n: number, clusters: number, seed: number): { vecs: Float32Array[]; labels: number[] } {
  const rnd = placement.seededRandom(seed);
  const centres = Array.from({ length: clusters }, () => Float32Array.from({ length: DIM }, () => rnd() - 0.5));
  const vecs: Float32Array[] = [];
  const labels: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % clusters;
    const v = new Float32Array(DIM);
    let norm = 0;
    for (let j = 0; j < DIM; j++) {
      v[j] = centres[c]![j]! + (rnd() - 0.5) * 0.3;
      norm += v[j]! * v[j]!;
    }
    norm = Math.sqrt(norm);
    for (let j = 0; j < DIM; j++) v[j] = v[j]! / norm;
    vecs.push(v);
    labels.push(c);
  }
  return { vecs, labels };
}

// --- policy ----------------------------------------------------------------

await test('a failure holds the boot retry until the library passes the stale threshold', () => {
  const failed = { ok: false, code: 134, signal: null, at: 'x', vectors: 232_350, error: 'oom' };
  assert.equal(policy.holdBootRetry(232_350, failed), true);
  assert.equal(policy.holdBootRetry(232_350 + 1_000, failed), true, '0.4% growth is not enough');
  assert.equal(policy.holdBootRetry(232_350 + 20_000, failed), false, '8% growth retries');
  assert.equal(policy.holdBootRetry(232_350 - 20_000, failed), false, 'shrinking past it retries too');
  assert.equal(policy.holdBootRetry(232_350, { ...failed, ok: true, error: null }), false);
  assert.equal(policy.holdBootRetry(232_350, null), false);
  // Small libraries: the absolute floor still applies.
  const small = { ...failed, vectors: 200 };
  assert.equal(policy.holdBootRetry(240, small), true, '40 vectors is under STALE_ABS');
  assert.equal(policy.holdBootRetry(260, small), false);
});

await test('the stale rule is unchanged', () => {
  const meta = { algo: 'umap-1', space: 'audio', count: 1000, setAt: '' };
  assert.equal(policy.isStale(10, null, 'umap-1', 'audio'), false, 'under MIN_VECTORS never stale');
  assert.equal(policy.isStale(1000, null, 'umap-1', 'audio'), true);
  assert.equal(policy.isStale(1000, meta, 'umap-2', 'audio'), true);
  assert.equal(policy.isStale(1040, meta, 'umap-1', 'audio'), false);
  assert.equal(policy.isStale(1060, meta, 'umap-1', 'audio'), true);
});

await test('describeFailure names a heap OOM, a thrown error, or the exit', () => {
  const oom = [
    '[53:0x1ca61000]   110164 ms: Mark-Compact 4048.0 (4143.0) -> 4035.5 (4144.1) MB',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    ' 1: 0xb8c3e0 node::Abort() [node]',
  ];
  assert.match(policy.describeFailure(134, null, oom), /out of memory.*SUBWAVE_MAP_HEAP_MB/);
  assert.equal(policy.describeFailure(1, null, ['projection failed: only 3 audio vectors']), 'only 3 audio vectors');
  assert.equal(policy.describeFailure(null, 'SIGKILL', []), 'killed by SIGKILL');
  assert.equal(policy.describeFailure(2, null, ['something']), 'exited with code 2');
});

await test('SUBWAVE_MAP_HEAP_MB reaches the child as a heap flag, after any NODE_OPTIONS', () => {
  assert.deepEqual(policy.childEnv({ A: '1' }, 0), { A: '1' }, 'unset keeps the env as it is');
  assert.equal(policy.childEnv({}, 16384).NODE_OPTIONS, '--max-old-space-size=16384');
  assert.equal(
    policy.childEnv({ NODE_OPTIONS: '--max-old-space-size=4096 --enable-source-maps' }, 12000).NODE_OPTIONS,
    '--max-old-space-size=4096 --enable-source-maps --max-old-space-size=12000',
  );
});

// --- placement -------------------------------------------------------------

await test('the sample is seeded: same seed, same indices; sorted, distinct, in range', () => {
  const a = placement.sampleIndices(10_000, 500, placement.seededRandom(2314));
  const b = placement.sampleIndices(10_000, 500, placement.seededRandom(2314));
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 500);
  assert.ok(a.every((v, i) => v >= 0 && v < 10_000 && (i === 0 || v > a[i - 1]!)));
  assert.deepEqual(placement.sampleIndices(5, 10, placement.seededRandom(1)), [0, 1, 2, 3, 4]);
});

await test('the graph walk finds the right neighbourhood for an unseen point', () => {
  const { vecs, labels } = clustered(2_400, 40, 11);
  const sampleN = 2_000;
  const sample = vecs.slice(0, sampleN);
  // Exact kNN of the sample stands in for UMAP's knnIndices.
  const knn = sample.map((v) =>
    sample
      .map((w, i) => [placement.sqDist(v, w), i] as const)
      .sort((x, y) => x[0] - y[0])
      .slice(0, 15)
      .map(([, i]) => i),
  );
  const searcher = placement.makeSearcher(placement.buildSampleGraph(sample, knn));
  let sameCluster = 0;
  let total = 0;
  for (let q = sampleN; q < vecs.length; q++) {
    const { indices } = searcher.search(vecs[q]!, placement.PLACE_K);
    assert.equal(indices.length, placement.PLACE_K);
    for (const i of indices) {
      total++;
      if (labels[i] === labels[q]) sameCluster++;
    }
  }
  assert.ok(sameCluster / total > 0.95, `same-cluster neighbours ${sameCluster}/${total}`);
});

await test('a scene with no evenly spaced pivot is still reachable: every graph component gets one', () => {
  // 300 well-separated clusters, more than the 256 spread pivots, and a kNN
  // narrower than a cluster, so the graph is one component per cluster. Before
  // the per-component pivots ~40% of queries walked in the wrong cluster.
  const clusters = 300;
  const { vecs, labels } = clustered(clusters * 10, clusters, 5);
  const sampleIdx: number[] = [];
  const queryIdx: number[] = [];
  vecs.forEach((_, i) => (Math.floor(i / clusters) === 9 ? queryIdx : sampleIdx).push(i));
  const sample = sampleIdx.map((i) => vecs[i]!);
  const knn = sample.map((v) =>
    sample
      .map((w, i) => [placement.sqDist(v, w), i] as const)
      .sort((x, y) => x[0] - y[0])
      .slice(0, 8)
      .map(([, i]) => i),
  );
  const graph = placement.buildSampleGraph(sample, knn);
  assert.ok(placement.componentRoots(graph.adjacency).length >= 256, 'premise: more components than spread pivots');
  const searcher = placement.makeSearcher(graph);
  let right = 0;
  for (const q of queryIdx) {
    const { indices } = searcher.search(vecs[q]!, 5);
    if (indices.every((i) => labels[sampleIdx[i]!] === labels[q])) right++;
  }
  assert.equal(right, queryIdx.length, `${right}/${queryIdx.length} queries found their own cluster`);
});

await test('componentRoots: one root per component, the lowest index', () => {
  const adj = [[1], [0], [], [4], [3]].map((a) => Int32Array.from(a));
  assert.deepEqual(placement.componentRoots(adj), [0, 2, 3]);
});

await test('weightedPlace: an exact duplicate lands on its twin; otherwise a 1/d mean', () => {
  const emb = [
    [0, 0],
    [10, 0],
  ];
  assert.deepEqual(placement.weightedPlace([1, 0], [0, 4], emb), [10, 0]);
  // d = 1 and 3: weights 1 and 1/3 → x = (0*1 + 10/3) / (4/3) = 2.5
  const [x, y] = placement.weightedPlace([0, 1], [1, 9], emb);
  assert.ok(Math.abs(x - 2.5) < 1e-9);
  assert.equal(y, 0);
});

// --- sample cap from the heap ---------------------------------------------

await test('the fit cap follows the old-generation heap: every measured point stays on the safe side', () => {
  // heap_size_limit as Node 24 reports it: --max-old-space-size plus 192 MB of young generation.
  const MB = 1024 * 1024;
  assert.equal(policy.fitSampleCap(4288 * MB), 40_000, 'the default ~4 GB heap keeps the 40k ceiling');
  assert.equal(policy.fitSampleCap(2240 * MB), 40_000, '2,048 MB old: 40k fitted');
  const at1536 = policy.fitSampleCap(1728 * MB);
  assert.ok(at1536 <= 40_000 && at1536 >= 28_000, `1,536 MB old (40k fitted there) → ${at1536}`);
  assert.ok(policy.fitSampleCap(1216 * MB) <= 24_000, '1,024 MB old fitted 24k and failed at 28.3k');
  // The young reserve is not fit space: --max-old-space-size=256 must not be
  // sized as if 448 MB were usable (that ran out of heap, #2331 delta check).
  assert.ok(policy.fitSampleCap(448 * MB) <= 5_100, '256 MB old');
  assert.ok(policy.fitSampleCap(704 * MB) <= 10_100, '512 MB old');
  assert.equal(policy.fitSampleCap(100 * MB), policy.MIN_SAMPLE);
  assert.equal(policy.fitSampleCap(Number.NaN), policy.MIN_SAMPLE);
});

await test('SUBWAVE_MAP_HEAP_MB is floored at MIN_HEAP_MB; unset keeps the default', () => {
  assert.equal(policy.childHeapMb(0), 0);
  assert.equal(policy.childHeapMb(256), policy.MIN_HEAP_MB);
  assert.equal(policy.childHeapMb(1), policy.MIN_HEAP_MB);
  assert.equal(policy.childHeapMb(4096), 4096);
  assert.equal(policy.childEnv({}, policy.childHeapMb(256)).NODE_OPTIONS, '--max-old-space-size=512');
});

// --- the child's run end -----------------------------------------------------

function tracker(closeGraceMs = 10_000) {
  const records: import('../src/music/map-projection-policy.js').ProjectionExit[] = [];
  let settled = 0;
  const log: string[] = [];
  const run = projection.createRunTracker({
    vectors: 232_350,
    log,
    record: (e) => records.push(e),
    settled: () => settled++,
    closeGraceMs,
  });
  return { run, records, log, settled: () => settled };
}

const OOM_TAIL = [
  '<--- Last few GCs --->\n',
  '[53:0x1ca61000]   110164 ms: Mark-Compact 4048.0 (4143.0) -> 4035.5 (4144.1) MB\n',
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
];

await test("the outcome is recorded on 'close', after output that drained past 'exit'", () => {
  const t = tracker();
  t.run.stdout('[map] projecting 232350 audio vectors (dim=512)…\n');
  t.run.exited(134, null);
  // The V8 report lands after 'exit' fired.
  for (const chunk of OOM_TAIL) t.run.stderr(chunk);
  assert.equal(t.records.length, 0, 'nothing recorded before close');
  assert.equal(t.settled(), 0, 'the slot stays taken until the outcome is on disk');
  t.run.closed();
  assert.equal(t.records.length, 1);
  assert.match(t.records[0]!.error ?? '', /out of memory/);
  assert.equal(t.records[0]!.code, 134);
  assert.equal(t.records[0]!.vectors, 232_350);
  assert.equal(t.settled(), 1);
  t.run.closed();
  t.run.exited(0, null);
  assert.equal(t.records.length, 1, 'recorded once');
});

await test('a line split across chunks is matched whole, and an unterminated last line is kept', () => {
  const t = tracker();
  t.run.stderr('FATAL ERROR: Reached heap limit Allocation failed - JavaScript he');
  t.run.stderr('ap out of memory\n[53] trailing');
  t.run.exited(134, null);
  t.run.closed();
  assert.ok(t.log.includes('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'));
  assert.ok(t.log.includes('[53] trailing'));
  assert.match(t.records[0]!.error ?? '', /out of memory/);
});

await test("an exit with no 'close' is recorded after the grace; a spawn failure at once; success has no error", async () => {
  const late = tracker(20);
  late.run.exited(1, null);
  assert.equal(late.records.length, 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(late.records.length, 1);
  assert.equal(late.records[0]!.error, 'exited with code 1');

  const spawnFail = tracker();
  spawnFail.run.failed('spawn npx ENOENT');
  assert.equal(spawnFail.records[0]!.error, 'spawn failed: spawn npx ENOENT');
  assert.equal(spawnFail.settled(), 1);

  const ok = tracker();
  ok.run.exited(0, null);
  ok.run.closed();
  assert.equal(ok.records[0]!.ok, true);
  assert.equal(ok.records[0]!.error, null);
});

// --- end to end ------------------------------------------------------------

const N = 300;
const { vecs: libVecs } = clustered(N, 6, 23);
for (let i = 0; i < N; i++) {
  const id = `t${String(i).padStart(4, '0')}`;
  db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200 });
  db.upsertTrackAudioVector(id, libVecs[i]!);
}

function coords(): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (let i = 0; i < N; i++) {
    const id = `t${String(i).padStart(4, '0')}`;
    const t = db.getTrack(id)!;
    out.set(id, [t.mapX as number, t.mapY as number]);
  }
  return out;
}

await test('above the cap, a sample is fitted and every other track is placed', async () => {
  const lines: string[] = [];
  const res = await projection.runProjection((l) => lines.push(l), { sampleCap: 120 });
  assert.equal(res.count, N);
  assert.ok(lines.some((l) => /sample cap 120 for a \d+ MB heap · fitting 120, placing the rest/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /placed 180 tracks/.test(l)), lines.join('\n'));
  const first = coords();
  for (const [id, [x, y]] of first) {
    assert.ok(Number.isFinite(x) && x >= 0 && x <= 1, `${id} x=${x}`);
    assert.ok(Number.isFinite(y) && y >= 0 && y <= 1, `${id} y=${y}`);
  }
  // Seeded end to end: a second run gives the same map.
  await projection.runProjection(() => {}, { sampleCap: 120 });
  assert.deepEqual(coords(), first);
});

await test('at or under the cap, every track is fitted', async () => {
  const lines: string[] = [];
  await projection.runProjection((l) => lines.push(l), { sampleCap: N });
  assert.ok(!lines.some((l) => /placing the rest|placed \d+ tracks/.test(l)), lines.join('\n'));
  assert.equal(db.getMapProjectionMeta()?.count, N);
});

await test("runProjection, given no cap, sizes it from its own process's heap", async () => {
  // A real child with a small old generation, as a small host's default would
  // give the projection: the cap it actually used must come from that heap,
  // not the 40k ceiling.
  const { spawnSync } = await import('node:child_process');
  const dbMod = new URL('../src/music/library-db.ts', import.meta.url).href;
  const projMod = new URL('../src/music/map-projection.ts', import.meta.url).href;
  const code = [
    "const v8 = await import('node:v8');",
    `const db = await import(${JSON.stringify(dbMod)});`,
    `const p = await import(${JSON.stringify(projMod)});`,
    'await db.open({ embeddingDim: 768, adoptStoredDim: true });',
    'await p.runProjection((l) => console.log(l));',
    "console.log('LIMIT', v8.getHeapStatistics().heap_size_limit);",
    'db.close();',
  ].join(' ');
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, STATE_DIR: stateDir, NODE_OPTIONS: '--max-old-space-size=256' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const limit = Number(/LIMIT (\d+)/.exec(r.stdout)?.[1]);
  const cap = Number(/sample cap (\d+)/.exec(r.stdout)?.[1]);
  assert.ok(limit > 0 && cap > 0, r.stdout);
  assert.equal(cap, policy.fitSampleCap(limit));
  assert.ok(cap < 6_000, `a 256 MB old generation must not be sized as 448 MB or 40k (got ${cap})`);
});

await test('a recorded failure surfaces in the status; the boot hold shows only on a stale map', () => {
  projection.clearLastExit();
  assert.equal(projection.projectionStatus().lastExit, null);
  assert.equal(projection.projectionStatus().lastError, null);
  projection.recordExit({
    ok: false,
    code: 134,
    signal: null,
    at: '2026-11-12T00:00:00.000Z',
    vectors: N,
    error: 'ran out of memory (JavaScript heap); raise SUBWAVE_MAP_HEAP_MB',
  });
  // The map from the runs above is current: a failed manual re-project has no
  // boot run to hold, so the rail must not claim one.
  const fresh = projection.projectionStatus();
  assert.equal(fresh.stale, false);
  assert.equal(fresh.lastExit?.code, 134);
  assert.match(fresh.lastError ?? '', /out of memory/);
  assert.equal(fresh.bootRetryHeld, false);
  // A stale map (an older algo stored) is what the boot run would retry.
  db.setMapProjectionMeta('umap-0', 'audio', N);
  const stale = projection.projectionStatus();
  assert.equal(stale.stale, true);
  assert.equal(stale.bootRetryHeld, true);
  // A success clears the error and the hold.
  projection.recordExit({ ok: true, code: 0, signal: null, at: 'y', vectors: N, error: null });
  const ok = projection.projectionStatus();
  assert.equal(ok.lastError, null);
  assert.equal(ok.bootRetryHeld, false);
  db.setMapProjectionMeta('umap-1', 'audio', N);
  projection.clearLastExit();
});

await test('a failed run that wrote nothing to library.db still changes the Observatory ETag', async () => {
  const express = (await import('express')).default;
  const { createServer } = await import('node:http');
  const { router } = await import('../src/routes/library.js');
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${port}/library/observatory`;
  try {
    projection.clearLastExit();
    const before = await fetch(url);
    assert.equal(before.status, 200);
    const etag = before.headers.get('etag')!;
    await before.arrayBuffer();
    // Unchanged state: the browser's revalidation is a 304.
    const same = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(same.status, 304);
    // The child failed: only the state file moved, never library.db.
    projection.recordExit({
      ok: false,
      code: 134,
      signal: null,
      at: '2026-11-12T01:00:00.000Z',
      vectors: N,
      error: 'ran out of memory (JavaScript heap); raise SUBWAVE_MAP_HEAP_MB',
    });
    const after = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(after.status, 200, 'a 304 here puts the pre-run status back and erases the error');
    const body = (await after.json()) as { mapProjection: { lastError: string | null } };
    assert.match(body.mapProjection.lastError ?? '', /out of memory/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    projection.clearLastExit();
  }
});

// Cleanup runs here, not in after(): the root can look finished between two
// top-level awaits and close the DB under the end-to-end tests.
db.close();
await removeTempDir(stateDir);
