// Tests for the whole-file facets in the analysis pass: how `loudness` v2 and
// `edges` are planned, requested and stored, and the opt-in backfill that
// queues them on a regular analysis run.
//
// The contracts pinned here:
//   - an analyzer known to lack the whole-file facets (no ffmpeg, or an image
//     that predates them) gets none planned: they are skipped and counted, not
//     planned into a pass that can only write window figures;
//   - a track planned for whole-file facets alone is never staged: no capped
//     download, one URL request the analyzer's ffmpeg streams;
//   - a track planned for window facets too sends its staged path AND the
//     stream URL, so the whole-file facets still read the whole file;
//   - the answers land as loudness v2 + edges and the pass settles them;
//   - the backfill is off unless ANALYZE_WHOLE_FILE is set, and when on it is
//     an ordinary facet plan over the tracks that need either facet.
//
// Real better-sqlite3 DB in a temp STATE_DIR; the analyzer and Navidrome are
// a local HTTP stub. Run: `npm test -- whole-file-pass`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const requests: Array<Record<string, unknown>> = [];
let streamReads = 0;
let inflight = 0;
let maxInflight = 0;
let wholeFileCapable: boolean | null = true;

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_audio_capable: false, analyze_vocal_capable: false,
      analyze_facets_capable: true, analyze_whole_file_concurrency: 8,
      ...(wholeFileCapable == null ? {} : { analyze_whole_file_capable: wholeFileCapable }),
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const ok: Record<string, unknown> = {
        head: { bpm: 99, key: 'Dm', intro_ms: 500, confidence: 0.8 },
        loudness: { loudness_lufs: -13.5, peak_db: 0.2, sample_peak_db: -0.3, lra_lu: 8.1, loudness_version: 2 },
        edges: { edge_lead_ms: 800, edge_tail_ms: 3100, decoded_duration_ms: 213_407 },
      };
      const facets: Record<string, unknown> = {};
      for (const f of r.facets) facets[f] = { status: 'ok', data: ok[f] };
      res.setHeader('Content-Type', 'application/json');
      setTimeout(() => {
      inflight -= 1;
      res.end(JSON.stringify({
        ok: true, facets,
        source: r.path ? { kind: 'path', duration_s: 214, complete: r.complete ?? null }
          : { kind: 'whole-file', duration_s: 213.407, complete: true },
      }));
      }, 40);
    });
    return;
  }
  // Navidrome stream: the controller's capped staging download.
  streamReads += 1;
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const stateDir = mkdtempSync(join(tmpdir(), 'subwave-whole-pass-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;
delete process.env.ANALYZE_WHOLE_FILE;
delete process.env.ANALYZE_CONCURRENCY;
process.env.ANALYZE_WHOLE_FILE_CONCURRENCY = '3';

const db = await import('../src/music/library-db.js');
const P = await import('../src/music/acoustics-plan.js');
const { runAnalysisPass, wholeFileBackfillPlan } = await import('../src/music/analyze.js');
const analyzer = await import('../src/music/analyzer.js');
const { config } = await import('../src/config.js');
const setWholeFile = (on: boolean) => { (config.analyzer as { wholeFile: boolean }).wholeFile = on; };
await db.open({ embeddingDim: 8, adoptStoredDim: true });

after(() => {
  analyzer.shutdown();
  server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

for (const id of ['w1', 'w2', 'w3', 'w4']) {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 214 });
  db.upsertTrackAnalysis(id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
}
for (const id of ['a', 'b', 'c']) db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 214 });
for (const id of ['a', 'b', 'c']) db.upsertTrackAnalysis(id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
await analyzer.isAvailable();

const plan = (facets: string, ids = db.allTrackIdsOrdered(), wholeFile: boolean | null = true) => {
  const f = P.parseFacets(facets);
  return P.planAcoustics({
    ids, facets: f, where: { kind: 'needs' }, state: db.loadFacetState(f),
    capabilities: { clap: false, demucs: false, tailVocal: false, wholeFile },
  });
};

test('an analyzer without the whole-file facets gets none planned', () => {
  const p = plan('loudness,edges', ['a'], false);
  assert.equal(p.items.length, 0);
  assert.deepEqual(p.byFacet.map((c) => [c.facet, c.skipped]), [
    ['loudness', { 'no-whole-file': 1 }], ['edges', { 'no-whole-file': 1 }],
  ]);
  // Unknown is planned, with a note, like the other capabilities.
  const unknown = plan('edges', ['a'], null);
  assert.equal(unknown.items.length, 1);
  assert.ok(unknown.warnings.some((w) => w.includes('whole-file')), unknown.warnings.join('\n'));
});

test('whole-file facets alone: no staging download, one URL request', async () => {
  requests.length = 0;
  streamReads = 0;
  const stats = await runAnalysisPass({ plan: plan('loudness,edges', ['a']) });
  assert.equal(stats.analyzed, 1);
  assert.equal(streamReads, 0, 'the capped staging download was fetched');
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.deepEqual(r.facets, ['loudness', 'edges']);
  assert.ok(typeof r.url === 'string' && !('path' in r), JSON.stringify(r));
  const t = db.getTrack('a')!;
  assert.equal(t.loudnessLufs, -13.5);
  assert.equal(t.peakDb, 0.2);
  assert.equal(t.edgeLeadMs, 800);
  assert.equal(t.edgeTailMs, 3100);
  assert.equal(t.decodedDurationMs, 213_407);
  const rows = db.loadFacetState(['loudness', 'edges']).get('a')!;
  assert.deepEqual([rows.get('loudness')?.status, rows.get('loudness')?.version], ['ok', 2]);
  assert.deepEqual([rows.get('edges')?.status, rows.get('edges')?.version], ['ok', 1]);
  assert.ok(!db.facetNeedsIds('edges').includes('a'));
});

test('with a window facet too, the staged path travels with the stream URL', async () => {
  requests.length = 0;
  db.requireDb().prepare(`UPDATE track_facet_status SET version = 0 WHERE track_id = 'b' AND facet = 'head'`).run();
  await runAnalysisPass({ plan: plan('head,edges', ['b']) });
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.deepEqual(r.facets, ['head', 'edges']);
  assert.ok(typeof r.path === 'string', JSON.stringify(r));
  assert.ok(typeof r.stream_url === 'string' && String(r.stream_url).includes('/rest/'), JSON.stringify(r));
  assert.equal(db.getTrack('b')!.edgeTailMs, 3100);
});

test('whole-file-only plans take their own, wider lane', async () => {
  maxInflight = 0;
  await runAnalysisPass({ plan: plan('edges', ['w1', 'w2', 'w3', 'w4']) });
  // ANALYZE_WHOLE_FILE_CONCURRENCY (3), under the sidecar's own cap (8);
  // ANALYZE_CONCURRENCY is 1.
  assert.equal(maxInflight, 3);
  db.requireDb().prepare(`UPDATE track_facet_status SET version = 0 WHERE facet = 'head' AND track_id IN ('w1','w2')`).run();
  maxInflight = 0;
  await runAnalysisPass({ plan: plan('head,edges', ['w1', 'w2']) });
  assert.equal(maxInflight, 1, 'a window facet keeps the analyze pool width');
});

test('the backfill is off unless ANALYZE_WHOLE_FILE is set', async () => {
  assert.equal(config.analyzer.wholeFile, false, 'on by default');
  assert.equal(await wholeFileBackfillPlan(), null);
  setWholeFile(true);
  try {
    const p = await wholeFileBackfillPlan();
    assert.ok(p);
    assert.deepEqual(p.facets, ['loudness', 'edges']);
    // a is done; b still needs loudness v2; c needs both.
    assert.deepEqual(
      p.items.filter((i) => ['a', 'b', 'c'].includes(i.id)).map((i) => [i.id, i.facets]),
      [['b', ['loudness']], ['c', ['loudness', 'edges']]],
    );
    const capped = await wholeFileBackfillPlan(1);
    assert.equal(capped?.items.length, 1);
    wholeFileCapable = false;
    await analyzer.refreshCapabilities();
    assert.equal((await wholeFileBackfillPlan())?.items.length ?? 0, 0);
    // An analyzer that predates the facets says nothing: not enough to widen.
    wholeFileCapable = null;
    await analyzer.refreshCapabilities();
    assert.equal((await wholeFileBackfillPlan())?.items.length ?? 0, 0);
  } finally {
    setWholeFile(false);
    wholeFileCapable = true;
    await analyzer.refreshCapabilities();
  }
});
