// Tests for the facet planner (music/acoustics-plan.ts) and the facet mode of
// the analysis pass (runAnalysisPass({ plan })).
//
// The contracts pinned here:
//   - `--where needs` selects exactly what facetNeedsIds() selects, so the
//     planner and the status table agree on "has work";
//   - the other --where kinds select by stored state (missing, unmeasurable
//     with a reason filter, failed INCLUDING exhausted retries, outdated, all);
//   - a facet the analyzer definitively can't produce is skipped and counted,
//     never planned into a guaranteed no-op;
//   - each work item becomes the right flat-protocol flags: CLAP alone takes
//     the embedding-only fast path, and a track that didn't ask for CLAP or
//     vocals gets them explicitly OFF;
//   - with a plan, the pass analyses exactly the planned tracks with those
//     flags (checked against a fake sidecar), and the facet table records the
//     result;
//   - a plan that asks for no stems never walks the stem cache, even with the
//     stem cache on (a full walk took 12 min on a NAS); a plain pass still does;
//   - a stems plan checks the stems root like a plain pass: an unmounted
//     share gets no stems_dir.
//   - a facet the worker reports failed is 'failed' in the table even where
//     the columns alone read 'unmeasurable', so it is retried up to the
//     attempt limit and no longer re-planned by `--where unmeasurable`.
//
// Real better-sqlite3 DB in a temp STATE_DIR; the analyzer and Navidrome are a
// local HTTP stub. Run: `npm test -- acoustics-plan`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Facet } from '../src/music/library-db/facets.js';
import type { WhereKind } from '../src/music/acoustics-plan.js';

// ---- fake analyzer sidecar + Navidrome stream ------------------------------
const requests: Array<Record<string, unknown>> = [];
const clapCapable = true;
let vocalCapable = false;
// Facet protocol on the stub (off = an analyzer that predates it).
let facetsCapable = false;
// Per-facet answers the stub gives for a facet request (default: ok).
let facetAnswers: Record<string, Record<string, unknown>> = {};
let rejectSharedPath = false;
function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'],
      analyze_audio_capable: clapCapable, analyze_vocal_capable: vocalCapable,
      ...(facetsCapable ? { analyze_facets_capable: true } : {}),
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      res.setHeader('Content-Type', 'application/json');
      if (rejectSharedPath && r.path) {
        res.statusCode = 422;
        res.end(JSON.stringify({ detail: { code: 'path_unavailable', message: 'isolated remote analyzer' } }));
        return;
      }
      const vec = Array.from({ length: 512 }, () => 0.01);
      if (Array.isArray(r.facets)) {
        const ok: Record<string, unknown> = {
          head: { bpm: 99, key: 'Dm', intro_ms: 500, confidence: 0.8 },
          loudness: { loudness_lufs: -12, peak_db: -2 },
          tail: { tail_silence_ms: 2500, tail_start_ms: 211_500, outro: {
            startMs: 200_000, ending: 'fade',
            ...(r.tail_vocals ? { vocalRanges: [{ startMs: 201_000, endMs: 205_000 }] } : {}),
          } },
          clap: { audio_embedding: vec },
        };
        const facets: Record<string, unknown> = {};
        for (const f of r.facets) facets[f] = facetAnswers[f] ?? { status: 'ok', data: ok[f] };
        res.end(JSON.stringify({
          ok: true, facets,
          source: r.path
            ? { kind: 'path', duration_s: 214, complete: r.complete ?? null }
            : { kind: 'capped-download', duration_s: 214, complete: true },
        }));
        return;
      }
      if (r.embedding_only) {
        res.end(JSON.stringify({ ok: true, audio_embedding: vec }));
        return;
      }
      res.end(JSON.stringify({
        ok: true, bpm: 120, key: 'Am', intro_ms: 1000, confidence: 0.9,
        loudness_lufs: -10, peak_db: -1,
        tail_silence_ms: 1500, tail_start_ms: 200_000,
        outro: { startMs: 190_000, ending: 'fade' },
        ...(r.embed ? { audio_embedding: vec } : {}),
      }));
    });
    return;
  }
  // Navidrome stream / anything else: a few bytes of "audio".
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const stateDir = mkdtempSync(join(tmpdir(), 'subwave-plan-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;

const db = await import('../src/music/library-db.js');
const P = await import('../src/music/acoustics-plan.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const analyzer = await import('../src/music/analyzer.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const sql = () => db.requireDb();

// a: fully analysed with CLAP · b: capped (tail unmeasurable) · c: never
// analysed · d: failed 3× (exhausted) · e: analysed, no CLAP, old tail version
for (const id of ['a', 'b', 'c', 'd', 'e']) db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 220 });
const clap = new Float32Array(512).fill(0.2);
db.upsertTrackAnalysis('a', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, tailSilenceMs: 0, outro: { startMs: 1, ending: 'cold' } as never, source: 'full' });
db.upsertTrackAudioVector('a', clap);
db.upsertTrackAnalysis('b', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, source: 'capped' });
db.upsertTrackAudioVector('b', clap);
for (let i = 0; i < 3; i++) db.recordAnalysisFailure('d', 'not audio');
db.upsertTrackAnalysis('e', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, tailSilenceMs: 0, outro: { startMs: 1, ending: 'cold' } as never, source: 'full' });
sql().prepare(`UPDATE track_facet_status SET version = 0 WHERE track_id = 'e' AND facet = 'tail'`).run();

const ids = db.allTrackIdsOrdered();
const plan = (facets: string, where?: string, caps = { clap: true as boolean | null, demucs: false as boolean | null, tailVocal: true as boolean | null }, limit?: number) => {
  const f = P.parseFacets(facets);
  return P.planAcoustics({ ids, facets: f, where: P.parseWhere(where), state: db.loadFacetState(f), capabilities: caps, limit });
};
const planned = (p: ReturnType<typeof plan>) => p.items.map((i) => i.id);

after(async () => {
  analyzer.shutdown();
  db.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  rmSync(stateDir, { recursive: true, force: true });
});

test('--where needs agrees with facetNeedsIds for every facet', () => {
  for (const f of db.FACETS) {
    const p = plan(f, undefined, { clap: true, demucs: true, tailVocal: true });
    assert.deepEqual(planned(p), db.facetNeedsIds(f), f);
  }
});

test('unmeasurable:<reason> picks the capped tail only', () => {
  assert.deepEqual(planned(plan('tail', 'unmeasurable:capped')), ['b']);
  assert.deepEqual(planned(plan('tail', 'unmeasurable:nothing-like-this')), []);
});

test('failed includes tracks past the retry limit (explicit retry)', () => {
  assert.deepEqual(planned(plan('head', 'failed')), ['d']);
  assert.ok(!planned(plan('head')).includes('d'), 'needs must still exclude the exhausted track');
});

test('missing / outdated / all', () => {
  assert.deepEqual(planned(plan('clap', 'missing')), ['c', 'e']);
  assert.deepEqual(planned(plan('tail', 'outdated')), ['e']);
  assert.deepEqual(planned(plan('head', 'all')), ['a', 'b', 'c', 'd', 'e']);
});

test('a facet the analyzer cannot produce is skipped and counted', () => {
  const p = plan('vocal', 'missing', { clap: true, demucs: false, tailVocal: true });
  assert.equal(p.items.length, 0);
  // d already has a (failed) vocal row, so 4 tracks are missing it.
  assert.equal(p.byFacet[0].skipped['no-demucs'], 4);
  const unknown = plan('vocal', 'missing', { clap: true, demucs: null, tailVocal: null });
  assert.equal(unknown.items.length, 4, 'unknown capability still plans');
  assert.ok(unknown.warnings.some((w) => w.includes('Demucs capability unknown')));
});

test('--limit caps tracks and reports what it left out', () => {
  const p = plan('head', 'all', undefined, 2);
  assert.deepEqual(planned(p), ['a', 'b']);
  assert.equal(p.byFacet[0].skipped.limit, 3);
});

test('parsers reject unknown names', () => {
  assert.throws(() => P.parseFacets('tail,bogus'), /unknown facet "bogus"/);
  assert.throws(() => P.parseWhere('sometimes'), /unknown --where/);
  assert.throws(() => P.parseWhere('failed:capped'), /only applies to --where unmeasurable/);
  assert.deepEqual(P.parseFacets('CLAP, tail'), ['tail', 'clap']);
});

test('clap alone takes the embedding-only fast path', () => {
  assert.deepEqual(P.requestFor(['clap']), { embeddingOnly: true, clap: true, vocal: false, stems: false });
});

test('tail alone is a full analysis with CLAP and vocals off', () => {
  assert.deepEqual(P.requestFor(['tail']), { embeddingOnly: false, clap: false, vocal: false, stems: false });
});

test('the dry-run summary names ride-along facets', () => {
  const lines = P.formatPlan(plan('tail', 'unmeasurable'));
  assert.ok(lines.some((l) => l.includes('also recomputes head, loudness')), lines.join('\n'));
});

test('analyses exactly the planned tracks, with per-track flags', async () => {
  analyzer._resetBackendCacheForTests();
  requests.length = 0;
  const p = P.planAcoustics({
    ids, facets: ['clap'], where: { kind: 'missing' }, state: db.loadFacetState(['clap']),
    capabilities: { clap: true, demucs: false, tailVocal: true },
  });
  const stats = await runAnalysisPass({ plan: p });
  assert.equal(stats.scope, 2);
  assert.equal(stats.analyzed, 2);
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.embedding_only, true, JSON.stringify(r));
    assert.equal(r.embed, true);
  }
  // c and e now have a vector; d is past its retry limit, so nothing is due.
  assert.deepEqual(db.facetNeedsIds('clap'), []);
  for (const id of ['c', 'e']) {
    const r = sql().prepare(`SELECT status, source FROM track_facet_status WHERE track_id = ? AND facet = 'clap'`).get(id) as { status: string; source: string };
    assert.deepEqual(r, { status: 'ok', source: 'analyzer' }, id);
  }
});

test('a tail redo turns CLAP and vocals explicitly off and fixes the tail facet', async () => {
  requests.length = 0;
  const p = plan('tail', 'unmeasurable:capped');
  const stats = await runAnalysisPass({ plan: p });
  assert.equal(stats.analyzed, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].embed, false);
  assert.equal(requests[0].vocal, false);
  assert.ok(!requests[0].embedding_only);
  const tail = sql().prepare(`SELECT status FROM track_facet_status WHERE track_id = 'b' AND facet = 'tail'`).get() as { status: string };
  assert.equal(tail.status, 'ok');
});

test('an empty plan analyses nothing', async () => {
  requests.length = 0;
  const stats = await runAnalysisPass({ plan: plan('tail', 'unmeasurable:capped') });
  assert.equal(stats.scope, 0);
  assert.equal(requests.length, 0);
});

test('a plan that asks for no stems never walks the stem cache, even with the cache on', async () => {
  const settings = await import('../src/settings.js');
  const stemCacheStore = await import('../src/music/stem-cache.js');
  vocalCapable = true;
  analyzer._resetBackendCacheForTests();
  await settings.update({ audio: { stemCache: true } });
  try {
    db.upsertTrackMeta('t7', { title: 't7', artist: 'A', album: 'B', duration: 214 });
    db.upsertTrackAnalysis('t7', { bpm: 128, musicalKey: 'G', loudnessLufs: -8, source: 'capped' });
    const p = P.planAcoustics({ ids: ['t7'], facets: ['tail'], where: { kind: 'unmeasurable' },
      state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: true, tailVocal: true } });
    assert.equal(p.items.length, 1);
    assert.ok(!p.items[0].request.stems, 'a tail plan asks for no stems');
    const before = stemCacheStore._cacheWalksForTests();
    const stats = await runAnalysisPass({ plan: p });
    assert.equal(stats.analyzed, 1);
    assert.equal(stemCacheStore._cacheWalksForTests(), before, 'the plan walked the stem cache');
    // The control: a plain pass with the cache on still sizes the budget.
    db.upsertTrackMeta('t8', { title: 't8', artist: 'A', album: 'B', duration: 214 });
    await runAnalysisPass({ limit: 1 });
    assert.ok(stemCacheStore._cacheWalksForTests() > before, 'a plain pass no longer walks the cache');
  } finally {
    await settings.update({ audio: { stemCache: false } });
    vocalCapable = false;
    analyzer._resetBackendCacheForTests();
  }
});

test('a stems plan on an unmounted stems share sends no stems_dir', async () => {
  const stemCacheStore = await import('../src/music/stem-cache.js');
  const { readdirSync } = await import('node:fs');
  vocalCapable = true;
  analyzer._resetBackendCacheForTests();
  try {
    // The share is gone: the root has no marker and no stem dirs, yet the
    // library says stems were cached, so the root reads offline.
    const root = stemCacheStore.stemsRoot();
    rmSync(root, { recursive: true, force: true });
    sql().prepare(`UPDATE tracks SET stems_at = 1 WHERE id = 'a'`).run();
    db.upsertTrackMeta('t9', { title: 't9', artist: 'A', album: 'B', duration: 214 });
    const p = P.planAcoustics({ ids: ['t9'], facets: ['stems'], where: { kind: 'all' },
      state: db.loadFacetState(['stems']), capabilities: { clap: true, demucs: true, tailVocal: true } });
    assert.equal(p.items.length, 1);
    assert.ok(p.items[0].request.stems, 'a stems plan asks for stems');
    requests.length = 0;
    await runAnalysisPass({ plan: p });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].stems_dir, undefined, JSON.stringify(requests[0]));
    let left: string[] = [];
    try { left = readdirSync(root); } catch { /* not recreated: fine */ }
    assert.deepEqual(left, [], 'the plan wrote into the unmounted share');
  } finally {
    sql().prepare(`UPDATE tracks SET stems_at = NULL WHERE id = 'a'`).run();
    vocalCapable = false;
    analyzer._resetBackendCacheForTests();
  }
});

// Facet protocol: from here on the stub advertises analyze_facets_capable.
test('facet protocol: the stub now advertises facets', () => {
  facetsCapable = true;
  analyzer._resetBackendCacheForTests();
});

const facetRow = (id: string, f: string) =>
  sql().prepare('SELECT status, reason, source, version FROM track_facet_status WHERE track_id = ? AND facet = ?').get(id, f) as
    { status: string; reason: string | null; source: string; version: number } | undefined;

test('a tail-only plan asks for exactly the tail and writes only the tail', async () => {
  db.upsertTrackMeta('t1', { title: 't1', artist: 'A', album: 'B', duration: 214 });
  db.upsertTrackAnalysis('t1', { bpm: 128, musicalKey: 'G', loudnessLufs: -8, source: 'capped' });
  requests.length = 0;
  const p = P.planAcoustics({ ids: ['t1'], facets: ['tail'], where: { kind: 'unmeasurable' },
    state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: false, tailVocal: false } });
  const stats = await runAnalysisPass({ plan: p });
  assert.equal(stats.analyzed, 1);
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.deepEqual(r.facets, ['tail']);
  assert.ok(typeof r.path === 'string', 'the staged copy is handed over, as on the flat path');
  assert.equal(r.embed, undefined, 'a facet request carries no flat-path flags');
  const t = db.getTrack('t1')!;
  assert.equal(t.tailStartMs, 211_500);
  assert.equal(t.bpm, 128, 'a tail-only answer must not rewrite BPM');
  assert.equal(t.loudnessLufs, -8, 'a tail-only answer must not rewrite loudness');
  const row = facetRow('t1', 'tail')!;
  assert.equal(row.status, 'ok');
  assert.equal(row.version, db.FACET_VERSIONS.tail);
});

test('with vocal activity on, a tail-only request asks for the tail vocals and stores them', async () => {
  vocalCapable = true;
  analyzer._resetBackendCacheForTests();
  try {
    db.upsertTrackMeta('t11', { title: 't11', artist: 'A', album: 'B', duration: 214 });
    db.upsertTrackAnalysis('t11', { bpm: 128, musicalKey: 'G', loudnessLufs: -8, source: 'capped' });
    const p = P.planAcoustics({ ids: ['t11'], facets: ['tail'], where: { kind: 'unmeasurable' },
      state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: true, tailVocal: true } });
    requests.length = 0;
    await runAnalysisPass({ plan: p, vocalBackfill: true });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].facets, ['tail']);
    assert.equal(requests[0].tail_vocals, true);
    assert.deepEqual(db.getTrack('t11')!.outro?.vocalRanges, [{ startMs: 201_000, endMs: 205_000 }]);
    // Without vocal activity the request stays tail-only and Demucs-free.
    db.upsertTrackMeta('t12', { title: 't12', artist: 'A', album: 'B', duration: 214 });
    db.upsertTrackAnalysis('t12', { bpm: 128, musicalKey: 'G', loudnessLufs: -8, source: 'capped' });
    const q = P.planAcoustics({ ids: ['t12'], facets: ['tail'], where: { kind: 'unmeasurable' },
      state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: true, tailVocal: true } });
    requests.length = 0;
    await runAnalysisPass({ plan: q, vocalBackfill: false });
    assert.equal(requests[0].tail_vocals, undefined);
  } finally {
    vocalCapable = false;
    analyzer._resetBackendCacheForTests();
  }
});

test('a stems facet request carries stems_require_marker with its stems_dir', async () => {
  const stemCacheStore = await import('../src/music/stem-cache.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  const root = stemCacheStore.stemsRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, stemCacheStore.STEMS_MARKER), '');
  vocalCapable = true;
  analyzer._resetBackendCacheForTests();
  try {
    db.upsertTrackMeta('t10', { title: 't10', artist: 'A', album: 'B', duration: 214 });
    const p = P.planAcoustics({ ids: ['t10'], facets: ['stems'], where: { kind: 'all' },
      state: db.loadFacetState(['stems']), capabilities: { clap: true, demucs: true, tailVocal: true } });
    assert.equal(p.items.length, 1);
    requests.length = 0;
    await runAnalysisPass({ plan: p });
    assert.equal(requests.length, 1);
    const r = requests[0];
    assert.deepEqual(r.facets, ['stems']);
    assert.ok(typeof r.stems_dir === 'string', JSON.stringify(r));
    assert.equal(r.stems_require_marker, true, 'a remote analyzer must check the share before writing');
  } finally {
    // Leave no stems stamp behind: with the root gone it would read offline.
    sql().prepare(`UPDATE tracks SET stems_at = NULL WHERE id = 't10'`).run();
    (await import('../src/music/library-db/facets.js')).syncTrackFacets('t10');
    rmSync(root, { recursive: true, force: true });
    vocalCapable = false;
    analyzer._resetBackendCacheForTests();
  }
});

test('an unmeasurable tail keeps the columns and records the worker\'s reason', async () => {
  db.upsertTrackMeta('t2', { title: 't2', artist: 'A', album: 'B', duration: 214 });
  db.upsertTrackAnalysis('t2', { bpm: 128, musicalKey: 'G', loudnessLufs: -8, source: 'capped' });
  facetAnswers = { tail: { status: 'unmeasurable', reason: 'silent-tail-window' } };
  const p = P.planAcoustics({ ids: ['t2'], facets: ['tail'], where: { kind: 'unmeasurable' },
    state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: false, tailVocal: false } });
  await runAnalysisPass({ plan: p });
  facetAnswers = {};
  assert.equal(db.getTrack('t2')!.tailStartMs ?? null, null);
  const row = facetRow('t2', 'tail')!;
  assert.equal(row.status, 'unmeasurable');
  assert.equal(row.reason, 'silent-tail-window');
});

test('a facet that fails counts one attempt; the others are written', async () => {
  db.upsertTrackMeta('t3', { title: 't3', artist: 'A', album: 'B', duration: 214 });
  facetAnswers = { clap: { status: 'failed', reason: 'decode error' } };
  requests.length = 0;
  const p = P.planAcoustics({ ids: ['t3'], facets: ['head', 'clap'], where: { kind: 'all' },
    state: db.loadFacetState(['head', 'clap']), capabilities: { clap: true, demucs: false, tailVocal: false } });
  const stats = await runAnalysisPass({ plan: p });
  facetAnswers = {};
  assert.equal(stats.analyzed, 1);
  assert.deepEqual(requests[0].facets, ['head', 'clap']);
  assert.equal(db.getTrack('t3')!.bpm, 99);
  assert.equal(facetRow('t3', 'head')!.status, 'ok');
  assert.equal(facetRow('t3', 'clap')!.status, 'failed');
  assert.equal(db.analysisFailures().find((f) => f.id === 't3')?.attempts, 1);
});

test('when every facet fails, the track fails like a flat analysis', async () => {
  db.upsertTrackMeta('t4', { title: 't4', artist: 'A', album: 'B', duration: 214 });
  facetAnswers = { head: { status: 'failed', reason: 'boom' } };
  const p = P.planAcoustics({ ids: ['t4'], facets: ['head'], where: { kind: 'all' },
    state: db.loadFacetState(['head']), capabilities: { clap: true, demucs: false, tailVocal: false } });
  const stats = await runAnalysisPass({ plan: p });
  facetAnswers = {};
  assert.equal(stats.failed, 1);
  assert.equal(stats.analyzed, 0);
});

test('a tail that fails is recorded as failed, so an unmeasurable re-run stops planning it', async () => {
  // Production, 3 Oct: a planned tail failed ("window starts before the
  // fetched tail") on an analysed track. The row stayed 'unmeasurable /
  // tail-not-measured', so facets-cli showed no failure and every
  // `--where unmeasurable:tail-not-measured` run planned it again.
  db.upsertTrackMeta('t5', { title: 't5', artist: 'A', album: 'B', duration: 106 });
  db.upsertTrackAnalysis('t5', { bpm: 90, musicalKey: 'F', loudnessLufs: -30 });
  const where = { kind: 'unmeasurable' as const, reason: 'tail-not-measured' };
  const tailPlan = () => P.planAcoustics({ ids: ['t5'], facets: ['tail'], where,
    state: db.loadFacetState(['tail']), capabilities: { clap: true, demucs: false, tailVocal: false } });
  assert.equal(facetRow('t5', 'tail')!.reason, 'tail-not-measured');
  assert.equal(tailPlan().items.length, 1);
  facetAnswers = { tail: { status: 'failed', reason: 'window starts before the fetched tail' } };
  const stats = await runAnalysisPass({ plan: tailPlan() });
  facetAnswers = {};
  assert.equal(stats.failed, 1);
  const row = facetRow('t5', 'tail')!;
  assert.equal(row.status, 'failed');
  assert.match(row.reason ?? '', /^tail: window starts before the fetched tail/);
  assert.equal(facetRow('t5', 'head')!.status, 'ok', 'the head stays measured');
  assert.equal(tailPlan().items.length, 0, 'unmeasurable:<reason> no longer matches a failed tail');
  assert.ok(db.facetNeedsIds('tail').includes('t5'), 'needs retries it while under the attempt limit');
  for (let i = 1; i < db.FACET_MAX_ATTEMPTS; i++) db.recordAnalysisFailure('t5', 'tail: window starts before the fetched tail');
  assert.ok(!db.facetNeedsIds('tail').includes('t5'), 'and stops at the limit');
  // The admin "clear failures" puts the track back where it was.
  db.clearAnalysisFailures('t5');
  assert.deepEqual(
    { status: facetRow('t5', 'tail')!.status, reason: facetRow('t5', 'tail')!.reason },
    { status: 'unmeasurable', reason: 'tail-not-measured' },
  );
  assert.equal(tailPlan().items.length, 1);
});

test('a flat failure on an analysed track leaves its unmeasured tail unmeasurable', async () => {
  db.upsertTrackMeta('t6', { title: 't6', artist: 'A', album: 'B', duration: 214 });
  db.upsertTrackAnalysis('t6', { bpm: 90, musicalKey: 'F', loudnessLufs: -9, source: 'capped' });
  db.recordAnalysisFailure('t6', 'read ECONNRESET');
  assert.equal(facetRow('t6', 'tail')!.status, 'unmeasurable');
  assert.equal(facetRow('t6', 'clap')!.status, 'failed');
});

test('the facet table stays consistent with the columns through facet writes', async () => {
  const { checkFacets } = await import('../src/music/facet-check.js');
  const r = checkFacets();
  assert.equal(r.driftCount, 0, JSON.stringify(r.drift));
  assert.equal(r.orphans, 0);
});

function facetPlan(ids: string[], facets: Facet[], kind: WhereKind = 'all') {
  return P.planAcoustics({ ids, facets, where: { kind }, state: db.loadFacetState(facets),
    capabilities: { clap: true, demucs: true, tailVocal: true } });
}

test('an unmeasurable CLAP answer settles needs and survives reopening', async () => {
  const id = 'terminal-clap';
  db.upsertTrackMeta(id, { title: id, duration: 214 });
  facetAnswers = { clap: { status: 'unmeasurable', reason: 'no-decodable-window' } };
  try {
    await runAnalysisPass({ plan: facetPlan([id], ['clap'], 'needs') });
    assert.equal(facetRow(id, 'clap')?.status, 'unmeasurable');
    assert.equal(facetRow(id, 'clap')?.reason, 'no-decodable-window');
    assert.equal(facetPlan([id], ['clap'], 'needs').items.length, 0);
    const { checkFacets } = await import('../src/music/facet-check.js');
    assert.equal(checkFacets().ok, true, 'explicit terminal answers are valid scope differences');
    db.close();
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    assert.equal(facetRow(id, 'clap')?.reason, 'no-decodable-window');
    assert.equal(facetPlan([id], ['clap'], 'needs').items.length, 0);
    sql().prepare("UPDATE track_facet_status SET version = 0 WHERE track_id = ? AND facet = 'clap'").run(id);
    assert.equal(facetPlan([id], ['clap'], 'needs').items.length, 1);
    assert.equal(checkFacets().ok, true, 'older terminal answers still need work in both scopes');
  } finally { facetAnswers = {}; }
});

test('an unavailable-only answer preserves failures and reports no analyzed work', async () => {
  const id = 'unavailable-clap';
  db.upsertTrackMeta(id, { title: id, duration: 214 });
  db.recordAnalysisFailure(id, 'tail: decode failed');
  db.recordAnalysisFailure(id, 'tail: decode failed');
  facetAnswers = { clap: { status: 'unavailable', reason: 'CLAP load failed' } };
  try {
    const stats = await runAnalysisPass({ plan: facetPlan([id], ['clap']) });
    assert.equal(db.analysisFailures().find(f => f.id === id)?.attempts, 2);
    assert.equal(stats.analyzed, 0);
    assert.equal(stats.failed, 0);
  } finally { facetAnswers = {}; }
});

test('an unavailable-only job does not interrupt the systemic failure guard', async () => {
  const ids = ['outage-1', 'outage-2', 'outage-3', 'outage-noop', 'outage-4', 'outage-5', 'outage-6'];
  for (const id of ids) db.upsertTrackMeta(id, { title: id, duration: 214 });
  const plan = facetPlan(ids, ['head']);
  const noop = plan.items.find(i => i.id === 'outage-noop');
  assert.ok(noop);
  noop.facets = ['clap'];
  noop.request = P.requestFor(['clap']);
  facetAnswers = { head: { status: 'failed', reason: 'decoder service unavailable' },
    clap: { status: 'unavailable', reason: 'CLAP load failed' } };
  try {
    const stats = await runAnalysisPass({ plan });
    assert.deepEqual(db.analysisFailures().filter(f => ids.includes(f.id)), []);
    assert.equal(stats.analyzed, 0);
    assert.equal(stats.failed, 6);
  } finally { facetAnswers = {}; }
});

test('a facet stems plan skips separation while the share is offline', async () => {
  const stemCacheStore = await import('../src/music/stem-cache.js');
  const id = 'offline-stems';
  db.upsertTrackMeta(id, { title: id, duration: 214 });
  rmSync(stemCacheStore.stemsRoot(), { recursive: true, force: true });
  sql().prepare("UPDATE tracks SET stems_at = 1 WHERE id = 'a'").run();
  try {
    requests.length = 0;
    const stats = await runAnalysisPass({ plan: facetPlan([id], ['stems']) });
    assert.equal(requests.length, 0, 'no facet work can run without a stems target');
    assert.equal(stats.analyzed, 0);
    assert.equal(sql().prepare('SELECT stems_at FROM tracks WHERE id = ?').pluck().get(id), null);
    assert.equal(facetPlan([id], ['stems'], 'needs').items.length, 1);
    requests.length = 0;
    await runAnalysisPass({ plan: facetPlan([id], ['head', 'stems']) });
    assert.deepEqual(requests[0]?.facets, ['head'], 'other requested work still runs');
  } finally { sql().prepare("UPDATE tracks SET stems_at = NULL WHERE id = 'a'").run(); }
});

test('URL fallback omits stems and leaves a stems-only job retryable', async () => {
  const stemCacheStore = await import('../src/music/stem-cache.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const root = stemCacheStore.stemsRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCacheStore.STEMS_MARKER), '');
  const id = 'remote-stems';
  db.upsertTrackMeta(id, { title: id, duration: 214 });
  rejectSharedPath = true;
  try {
    requests.length = 0;
    const stats = await runAnalysisPass({ plan: facetPlan([id], ['stems']) });
    assert.equal(requests.length, 1, 'no URL retry may force stems without a shared output dir');
    assert.equal(stats.analyzed, 0);
    assert.equal(sql().prepare('SELECT stems_at FROM tracks WHERE id = ?').pluck().get(id), null);
    assert.equal(facetPlan([id], ['stems'], 'needs').items.length, 1);
    requests.length = 0;
    await runAnalysisPass({ plan: facetPlan([id], ['head', 'stems']) });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]?.facets, ['head']);
    assert.equal(requests[1]?.stems_dir, undefined);
  } finally {
    rejectSharedPath = false;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh tail vocals complete a current head-only vocal measurement', async () => {
  const id = 'fresh-tail-vocals';
  db.upsertTrackMeta(id, { title: id, duration: 214 });
  db.upsertTrackAnalysis(id, { bpm: 120, vocalRanges: [],
    outro: { startMs: 200_000, ending: 'cold', lufs: null, bpm: null, beats: null, bars: null } });
  assert.equal(facetRow(id, 'vocal')?.reason, 'head-only');
  vocalCapable = true;
  analyzer._resetBackendCacheForTests();
  try {
    await runAnalysisPass({ plan: facetPlan([id], ['tail']), vocalBackfill: true });
    assert.equal(facetRow(id, 'vocal')?.reason, null);
    assert.equal(facetRow(id, 'vocal')?.version, db.FACET_VERSIONS.vocal);
    assert.equal(facetPlan([id], ['vocal'], 'needs').items.length, 0);
  } finally {
    vocalCapable = false;
    analyzer._resetBackendCacheForTests();
  }
});

test('fresh tail vocals do not promote an older complete head vocal measurement', async () => {
  const id = 'older-head-vocals';
  db.upsertTrackMeta(id, { title: id, duration: 214 });
  db.upsertTrackAnalysis(id, { bpm: 120, vocalRanges: [],
    outro: { startMs: 200_000, ending: 'cold', lufs: null, bpm: null,
      beats: null, bars: null, vocalRanges: [] } });
  sql().prepare("UPDATE track_facet_status SET version = 0 WHERE track_id = ? AND facet = 'vocal'").run(id);
  vocalCapable = true;
  analyzer._resetBackendCacheForTests();
  try {
    await runAnalysisPass({ plan: facetPlan([id], ['tail']), vocalBackfill: true });
    assert.equal(facetRow(id, 'vocal')?.version, 0);
    assert.equal(facetPlan([id], ['vocal'], 'needs').items.length, 1);
  } finally {
    vocalCapable = false;
    analyzer._resetBackendCacheForTests();
  }
});
