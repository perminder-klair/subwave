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
  assert.ok(lines.some((l) => /fitting a sample of 120, placing the rest/.test(l)), lines.join('\n'));
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

await test('a recorded failure surfaces in the status and holds the boot retry', () => {
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
  const s = projection.projectionStatus();
  assert.equal(s.lastExit?.code, 134);
  assert.match(s.lastError ?? '', /out of memory/);
  assert.equal(s.bootRetryHeld, true);
  // A success clears the error and the hold.
  projection.recordExit({ ok: true, code: 0, signal: null, at: 'y', vectors: N, error: null });
  const ok = projection.projectionStatus();
  assert.equal(ok.lastError, null);
  assert.equal(ok.bootRetryHeld, false);
  projection.clearLastExit();
});

// Cleanup runs here, not in after(): the root can look finished between two
// top-level awaits and close the DB under the end-to-end tests.
db.close();
await removeTempDir(stateDir);
