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
//
// Real better-sqlite3 DB in a temp STATE_DIR; the analyzer and Navidrome are a
// local HTTP stub. Run: `tsx scripts/acoustics-plan.test.ts` (npm test).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.stack || err}`); });
}

// ---- fake analyzer sidecar + Navidrome stream ------------------------------
const requests: Array<Record<string, unknown>> = [];
const clapCapable = true;
let vocalCapable = false;
function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'],
      analyze_audio_capable: clapCapable, analyze_vocal_capable: vocalCapable,
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
      const vec = Array.from({ length: 512 }, () => 0.01);
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

async function main() {
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

  console.log('selection:');

  await test('--where needs agrees with facetNeedsIds for every facet', () => {
    for (const f of db.FACETS) {
      const p = plan(f, undefined, { clap: true, demucs: true, tailVocal: true });
      assert.deepEqual(planned(p), db.facetNeedsIds(f), f);
    }
  });

  await test('unmeasurable:<reason> picks the capped tail only', () => {
    assert.deepEqual(planned(plan('tail', 'unmeasurable:capped')), ['b']);
    assert.deepEqual(planned(plan('tail', 'unmeasurable:nothing-like-this')), []);
  });

  await test('failed includes tracks past the retry limit (explicit retry)', () => {
    assert.deepEqual(planned(plan('head', 'failed')), ['d']);
    assert.ok(!planned(plan('head')).includes('d'), 'needs must still exclude the exhausted track');
  });

  await test('missing / outdated / all', () => {
    assert.deepEqual(planned(plan('clap', 'missing')), ['c', 'e']);
    assert.deepEqual(planned(plan('tail', 'outdated')), ['e']);
    assert.deepEqual(planned(plan('head', 'all')), ['a', 'b', 'c', 'd', 'e']);
  });

  await test('a facet the analyzer cannot produce is skipped and counted', () => {
    const p = plan('vocal', 'missing', { clap: true, demucs: false, tailVocal: true });
    assert.equal(p.items.length, 0);
    // d already has a (failed) vocal row, so 4 tracks are missing it.
    assert.equal(p.byFacet[0].skipped['no-demucs'], 4);
    const unknown = plan('vocal', 'missing', { clap: true, demucs: null, tailVocal: null });
    assert.equal(unknown.items.length, 4, 'unknown capability still plans');
    assert.ok(unknown.warnings.some((w) => w.includes('Demucs capability unknown')));
  });

  await test('--limit caps tracks and reports what it left out', () => {
    const p = plan('head', 'all', undefined, 2);
    assert.deepEqual(planned(p), ['a', 'b']);
    assert.equal(p.byFacet[0].skipped.limit, 3);
  });

  await test('parsers reject unknown names', () => {
    assert.throws(() => P.parseFacets('tail,bogus'), /unknown facet "bogus"/);
    assert.throws(() => P.parseWhere('sometimes'), /unknown --where/);
    assert.throws(() => P.parseWhere('failed:capped'), /only applies to --where unmeasurable/);
    assert.deepEqual(P.parseFacets('CLAP, tail'), ['tail', 'clap']);
  });

  console.log('request flags:');

  await test('clap alone takes the embedding-only fast path', () => {
    assert.deepEqual(P.requestFor(['clap']), { embeddingOnly: true, clap: true, vocal: false, stems: false });
  });

  await test('tail alone is a full analysis with CLAP and vocals off', () => {
    assert.deepEqual(P.requestFor(['tail']), { embeddingOnly: false, clap: false, vocal: false, stems: false });
  });

  await test('the dry-run summary names ride-along facets', () => {
    const lines = P.formatPlan(plan('tail', 'unmeasurable'));
    assert.ok(lines.some((l) => l.includes('also recomputes head, loudness')), lines.join('\n'));
  });

  console.log('runAnalysisPass with a plan:');

  await test('analyses exactly the planned tracks, with per-track flags', async () => {
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

  await test('a tail redo turns CLAP and vocals explicitly off and fixes the tail facet', async () => {
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

  await test('an empty plan analyses nothing', async () => {
    requests.length = 0;
    const stats = await runAnalysisPass({ plan: plan('tail', 'unmeasurable:capped') });
    assert.equal(stats.scope, 0);
    assert.equal(requests.length, 0);
  });

  await test('a plan that asks for no stems never walks the stem cache, even with the cache on', async () => {
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

  await test('a stems plan on an unmounted stems share sends no stems_dir', async () => {
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

  analyzer.shutdown();
  db.close();
  server.close();
  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`✗ acoustics-plan.test.ts: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('✓ acoustics-plan.test.ts passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
