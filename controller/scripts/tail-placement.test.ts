// Tests for the tail facet placed from the stored edges (tail v2).
//
// The tail window used to be the file's last ANALYZE_OUTRO_SECONDS, which on a
// track ending in dead air is partly or wholly silence: production showed the
// silence turning cold endings into fades (of the tracks with more than 3 s of
// trailing silence, 13,901 read 'fade' and 48 'cold'). The controller now
// sends where the music stops (decoded duration minus the trailing silence,
// both from the whole-file `edges` facet) and the analyzer ends the window
// there.
//
// The contracts pinned here:
//   - the tail facet is at v2; a tail's version is read off the columns:
//     `tail_version` (2 = a window the analyzer confirmed it placed), else 2
//     when the stored edges show at most TAIL_PLACEMENT_TOLERANCE_MS of
//     trailing silence (the old window then held the same music, so it is not
//     re-measured), else 1 — due again once edges exist;
//   - an unmeasurable tail without edges stays one version below, so it is
//     retried once edges can place it;
//   - measuring edges promotes an existing tail the tolerance covers, live
//     (not only on a whole-table re-derive), so the remaining edges backfill
//     does not plan every short-silence track for a tail re-read;
//   - a planned tail request carries `tail_window` (+ the stream URL for a
//     capped copy) when edges are stored, and only an answer marked
//     `tail_window: "edges"` stamps v2 (an older analyzer ignores the field);
//   - a flat analysis and a --re-analyze clear never overwrite a placed tail
//     with an end-of-file one (the loudness v2 rule);
//   - schema step 38 adds `tail_version`, safely re-run, and the derivation
//     stamp moved so production's table re-derives once.
//
// Real better-sqlite3 in a temp STATE_DIR; the analyzer and Navidrome are a
// local HTTP stub. Run: `npm test -- tail-placement`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const requests: Array<Record<string, unknown>> = [];
let placedAnswer = true;

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_audio_capable: false, analyze_vocal_capable: false,
      analyze_facets_capable: true, analyze_whole_file_capable: true,
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      const tw = r.tail_window as { end_ms: number; duration_ms: number } | undefined;
      if (!r.facets) {
        // A regular (flat) analysis: the whole flat answer.
        const end = tw && placedAnswer ? tw.end_ms : 214_000;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ok: true, bpm: 120, key: 'Am', intro_ms: 0, confidence: 0.9, loudness_lufs: -10, peak_db: -1,
          outro: { startMs: end - 5000, ending: 'cold', bpm: 120, beats: [end - 1000] },
          ...(tw && placedAnswer ? { tail_window: 'edges', tail_silence_ms: tw.duration_ms - tw.end_ms, tail_start_ms: tw.end_ms }
            : { tail_silence_ms: 300, tail_start_ms: 213_700 }),
        }));
        return;
      }
      const facets: Record<string, unknown> = {};
      if (r.facets.includes('tail')) {
        const end = tw && placedAnswer ? tw.end_ms : 214_000;
        facets.tail = {
          status: 'ok',
          data: {
            ...(tw && placedAnswer ? { tail_window: 'edges', tail_silence_ms: tw.duration_ms - tw.end_ms, tail_start_ms: tw.end_ms }
              : { tail_silence_ms: 400, tail_start_ms: 213_600 }),
            outro: { startMs: end - 6000, ending: 'cold', bpm: 120, beats: [end - 2000, end - 1500] },
          },
        };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, facets, source: { kind: 'path', duration_s: 214, complete: r.complete ?? null } }));
    });
    return;
  }
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const stateDir = createTempDir(join(tmpdir(), 'subwave-tail-placement-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;
delete process.env.ANALYZE_WHOLE_FILE;

const db = await import('../src/music/library-db.js');
const P = await import('../src/music/acoustics-plan.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const analyzer = await import('../src/music/analyzer.js');
const { checkFacets } = await import('../src/music/facet-check.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
await analyzer.isAvailable();

after(async () => {
  analyzer.shutdown();
  server.close();
  await removeTempDir(stateDir);
});

const sql = (q: string) => db.requireDb().prepare(q);
type Row = { status: string; version: number; reason: string | null };
const tailRow = (id: string) =>
  sql('SELECT status, version, reason FROM track_facet_status WHERE track_id = ? AND facet = ?').get(id, 'tail') as Row | undefined;
const tailVersionCol = (id: string) => (sql('SELECT tail_version AS v FROM tracks WHERE id = ?').get(id) as { v: number | null }).v;
const consistent = () => {
  const r = checkFacets();
  assert.ok(r.ok, JSON.stringify({ drift: r.drift, orphans: r.orphans }));
};
const OUTRO = { startMs: 200_000, ending: 'fade' as const, lufs: null, bpm: null, beats: null, bars: null };
const track = (id: string) => {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 214 });
  db.upsertTrackAnalysis(id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
};
const writeTail = (id: string, version?: number) =>
  db.writeFacetResults(id, { source: 'full', tail: { outro: OUTRO, tailSilenceMs: 500, tailStartMs: 213_500, ...(version ? { version } : {}) } });
const writeEdges = (id: string, tailMs: number) =>
  db.writeFacetResults(id, { source: 'url', edges: { leadMs: 0, tailMs, durationMs: 214_000 } });
const plan = (ids: string[]) => {
  const f = P.parseFacets('tail');
  return P.planAcoustics({
    ids, facets: f, where: { kind: 'needs' }, state: db.loadFacetState(f),
    capabilities: { clap: false, demucs: false, tailVocal: false, wholeFile: true },
  });
};

test('the tail facet is at v2, and step 38 adds tail_version', () => {
  assert.equal(db.FACET_VERSIONS.tail, 2);
  assert.ok((db.requireDb().pragma('user_version', { simple: true }) as number) >= 38);
  assert.ok((sql(`SELECT name FROM pragma_table_info('tracks') WHERE name = 'tail_version'`).all()).length === 1);
});

test('step 38 re-runs safely on a database that already has the column', async () => {
  db.requireDb().pragma('user_version = 37');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.ok((db.requireDb().pragma('user_version', { simple: true }) as number) >= 38);
});

test('a tail the analyzer placed is stamped v2 and settles', () => {
  track('placed');
  writeEdges('placed', 12_000);
  writeTail('placed', 2);
  assert.equal(tailVersionCol('placed'), 2);
  assert.deepEqual([tailRow('placed')?.status, tailRow('placed')?.version], ['ok', 2]);
  assert.ok(!db.facetNeedsIds('tail').includes('placed'));
  consistent();
});

test('an end-of-file tail is v1 unless the edges show the window held the same music', () => {
  for (const [id, silence, version] of [['short', 2_500, 2], ['edge', 3_000, 2], ['long', 3_001, 1]] as const) {
    track(id);
    writeEdges(id, silence);
    writeTail(id);
    assert.equal(tailVersionCol(id), null, id);
    assert.deepEqual([tailRow(id)?.status, tailRow(id)?.version], ['ok', version], id);
  }
  track('noedges');
  writeTail('noedges');
  assert.deepEqual([tailRow('noedges')?.status, tailRow('noedges')?.version], ['ok', 1]);
  const due = db.facetNeedsIds('tail');
  assert.ok(due.includes('long') && due.includes('noedges'), due.join(','));
  assert.ok(!due.includes('short') && !due.includes('edge'), due.join(','));
  consistent();
});

test('an end-of-file answer replaces a placed tail, and drops its stamp', () => {
  track('replaced');
  writeEdges('replaced', 9_000);
  writeTail('replaced', 2);
  writeTail('replaced');
  assert.equal(tailVersionCol('replaced'), null);
  assert.equal(tailRow('replaced')?.version, 1);
});

test('tail vocal ranges are carried only onto the same window', () => {
  track('tv');
  writeEdges('tv', 20_000);
  db.writeFacetResults('tv', { source: 'full', tail: {
    outro: { ...OUTRO, vocalRanges: [{ startMs: 205_000, endMs: 208_000 }] }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  // An end-of-file re-measure without vocals keeps them (same window)...
  writeTail('tv');
  assert.deepEqual(db.getTrack('tv')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 208_000 }]);
  // ...a newly placed window does not: they were measured on other audio.
  writeTail('tv', 2);
  assert.equal(db.getTrack('tv')!.outro?.vocalRanges ?? null, null);
  consistent();
});

test('measuring edges promotes a tail the tolerance covers, live', () => {
  track('later-short');
  writeTail('later-short');
  assert.equal(tailRow('later-short')?.version, 1);
  writeEdges('later-short', 800);
  assert.deepEqual([tailRow('later-short')?.status, tailRow('later-short')?.version], ['ok', 2]);
  track('later-long');
  writeTail('later-long');
  writeEdges('later-long', 15_000);
  assert.equal(tailRow('later-long')?.version, 1);
  consistent();
});

test('an unmeasurable tail without edges stays due until edges can place it', () => {
  track('capped');
  db.writeFacetResults('capped', { source: 'capped', tail: { unmeasurable: 'capped-download' } });
  assert.deepEqual([tailRow('capped')?.status, tailRow('capped')?.version], ['unmeasurable', 1]);
  assert.ok(db.facetNeedsIds('tail').includes('capped'));
  // Edges arriving do not settle it: the tail was never measured.
  writeEdges('capped', 500);
  assert.equal(tailRow('capped')?.version, 1);
  assert.ok(db.facetNeedsIds('tail').includes('capped'));
  // With edges, an unmeasurable answer is the placed attempt's: it settles.
  track('capped2');
  writeEdges('capped2', 500);
  db.writeFacetResults('capped2', { source: 'capped', tail: { unmeasurable: 'tail-not-reached' } });
  assert.deepEqual([tailRow('capped2')?.status, tailRow('capped2')?.version], ['unmeasurable', 2]);
  consistent();
});

test('a capped-download tail stays due even with edges: the window was not placed', () => {
  // The regular analysis pass reads the end-of-file window off the capped
  // download; with edges stored it must not settle the tail as if placed.
  track('cap-edged');
  writeEdges('cap-edged', 500);
  db.writeFacetResults('cap-edged', { source: 'capped', tail: { unmeasurable: 'capped-download' } });
  assert.deepEqual([tailRow('cap-edged')?.status, tailRow('cap-edged')?.version], ['unmeasurable', 1]);
  assert.ok(db.facetNeedsIds('tail').includes('cap-edged'));
  // Same through the flat path, which explains a missing tail the same way.
  track('cap-flat');
  writeEdges('cap-flat', 500);
  db.upsertTrackAnalysis('cap-flat', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'capped' });
  assert.deepEqual([tailRow('cap-flat')?.status, tailRow('cap-flat')?.version], ['unmeasurable', 1]);
  // A complete copy whose end-of-file window gave nothing: unplaced, so due.
  track('flat-none');
  writeEdges('flat-none', 500);
  db.upsertTrackAnalysis('flat-none', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
  assert.deepEqual([tailRow('flat-none')?.status, tailRow('flat-none')?.version], ['unmeasurable', 1]);
  // A stored row settled that way by an earlier controller is re-opened on the
  // next re-derive.
  sql(`UPDATE track_facet_status SET version = 2 WHERE track_id = 'cap-edged' AND facet = 'tail'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.equal(tailRow('cap-edged')?.version, 1);
  consistent();
});

test('an unplaced unmeasurable answer stays due; a placed one settles', () => {
  track('unpl');
  writeEdges('unpl', 500);
  db.writeFacetResults('unpl', { source: 'full', tailUnplaced: true, tail: { unmeasurable: 'silent-tail-window' } });
  assert.deepEqual([tailRow('unpl')?.status, tailRow('unpl')?.version], ['unmeasurable', 1]);
  db.writeFacetResults('unpl', { source: 'full', tail: { unmeasurable: 'silent-tail-window' } });
  assert.deepEqual([tailRow('unpl')?.status, tailRow('unpl')?.version], ['unmeasurable', 2]);
  // A later write that does not re-measure the tail keeps the settled version.
  db.upsertTrackAudioVector('unpl', Array.from({ length: db.AUDIO_EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0)));
  assert.equal(tailRow('unpl')?.version, 2);
  consistent();
});

test('a silent file settles its tail: there is no music end to place a window at', () => {
  const silent = (id: string) =>
    db.writeFacetResults(id, { source: 'url', unmeasurable: { edges: 'silent-file' } });
  // Edges first, then an end-of-file tail answer (ok, unplaced).
  track('sil-ok');
  silent('sil-ok');
  writeTail('sil-ok');
  assert.deepEqual([tailRow('sil-ok')?.status, tailRow('sil-ok')?.version], ['ok', 2]);
  // An unmeasurable answer from the unplaced window settles too.
  track('sil-um');
  silent('sil-um');
  db.writeFacetResults('sil-um', { source: 'full', tailUnplaced: true, tail: { unmeasurable: 'silent-tail-window' } });
  assert.deepEqual([tailRow('sil-um')?.status, tailRow('sil-um')?.version], ['unmeasurable', 2]);
  // Tail stored first, then the edges scan finds the file silent: promoted.
  track('sil-late');
  writeTail('sil-late');
  assert.equal(tailRow('sil-late')?.version, 1);
  silent('sil-late');
  assert.equal(tailRow('sil-late')?.version, 2);
  track('sil-late-um');
  db.writeFacetResults('sil-late-um', { source: 'full', tailUnplaced: true, tail: { unmeasurable: 'silent-tail-window' } });
  assert.equal(tailRow('sil-late-um')?.version, 1);
  silent('sil-late-um');
  assert.equal(tailRow('sil-late-um')?.version, 2);
  // None of them is planned again.
  const due = db.facetNeedsIds('tail');
  for (const id of ['sil-ok', 'sil-um', 'sil-late', 'sil-late-um']) assert.ok(!due.includes(id), id);
  // Rows an earlier derivation left at v1 are settled by the next re-derive.
  sql(`UPDATE track_facet_status SET version = 1 WHERE track_id IN ('sil-ok', 'sil-um') AND facet = 'tail'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.deepEqual([tailRow('sil-ok')?.version, tailRow('sil-um')?.version], [2, 2]);
  assert.equal(JSON.parse(db.facetDerivationStamp()).revision, 5);
  consistent();
  // A later edges scan that finds music brings the normal rule back.
  writeEdges('sil-ok', 9_000);
  assert.equal(tailRow('sil-ok')?.version, 1);
  consistent();
});

test('a whole-table re-derive applies the same rule to existing rows', () => {
  track('legacy');
  writeEdges('legacy', 1_000);
  writeTail('legacy');
  sql(`UPDATE track_facet_status SET version = 1 WHERE track_id = 'legacy' AND facet = 'tail'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.equal(tailRow('legacy')?.version, 2);
  assert.equal(JSON.parse(db.facetDerivationStamp()).revision, 5);
  consistent();
});

test('a flat analysis and a --re-analyze clear keep a placed tail', () => {
  track('kept');
  writeEdges('kept', 9_000);
  writeTail('kept', 2);
  db.upsertTrackAnalysis('kept', {
    bpm: 101, musicalKey: 'D', loudnessLufs: -9, peakDb: -1, source: 'full',
    outro: { ...OUTRO, startMs: 1 }, tailSilenceMs: 9_100, tailStartMs: 204_900,
  });
  let t = db.getTrack('kept')!;
  assert.equal(t.outro?.startMs, 200_000);
  assert.equal(t.tailStartMs, 213_500);
  assert.equal(tailVersionCol('kept'), 2);
  db.clearAnalysis();
  t = db.getTrack('kept')!;
  assert.equal(t.outro?.startMs, 200_000);
  assert.equal(tailVersionCol('kept'), 2);
  assert.equal(tailRow('kept')?.version, 2);
  // An end-of-file tail is the analysis being redone: cleared.
  assert.equal(db.getTrack('long')!.outro, null);
  consistent();
});

test('a planned tail sends the placement from the stored edges and stores v2', async () => {
  track('p1');
  writeEdges('p1', 20_000);
  requests.length = 0;
  await runAnalysisPass({ plan: plan(['p1']) });
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.deepEqual(r.tail_window, { end_ms: 194_000, duration_ms: 214_000 }, JSON.stringify(r));
  assert.ok(typeof r.stream_url === 'string' && String(r.stream_url).includes('/rest/'), JSON.stringify(r));
  const t = db.getTrack('p1')!;
  assert.equal(t.outro?.startMs, 188_000);
  assert.equal(t.tailStartMs, 194_000);
  assert.equal(t.tailSilenceMs, 20_000);
  assert.equal(tailVersionCol('p1'), 2);
  assert.deepEqual([tailRow('p1')?.status, tailRow('p1')?.version], ['ok', 2]);
});

test('without edges, or from an analyzer that ignores the placement, the tail stays v1', async () => {
  track('p2');
  requests.length = 0;
  await runAnalysisPass({ plan: plan(['p2']) });
  assert.ok(!('tail_window' in requests[0]), JSON.stringify(requests[0]));
  assert.equal(tailRow('p2')?.version, 1);
  track('p3');
  writeEdges('p3', 20_000);
  placedAnswer = false;
  try {
    await runAnalysisPass({ plan: plan(['p3']) });
  } finally {
    placedAnswer = true;
  }
  assert.equal(tailVersionCol('p3'), null);
  assert.equal(tailRow('p3')?.version, 1);
});

test('a flat analysis that placed its tail replaces the stored one and stamps v2', () => {
  track('flatv2');
  writeEdges('flatv2', 9_000);
  writeTail('flatv2', 2);
  db.upsertTrackAnalysis('flatv2', {
    bpm: 101, musicalKey: 'D', loudnessLufs: -9, peakDb: -1, source: 'full',
    outro: { ...OUTRO, startMs: 199_000 }, tailSilenceMs: 9_000, tailStartMs: 205_000, tailVersion: 2,
  });
  assert.equal(db.getTrack('flatv2')!.outro?.startMs, 199_000);
  assert.equal(db.getTrack('flatv2')!.tailStartMs, 205_000);
  assert.equal(tailVersionCol('flatv2'), 2);
  assert.equal(tailRow('flatv2')?.version, 2);
  consistent();
});

test('the regular analysis pass sends the placement too, and stores v2', async () => {
  db.upsertTrackMeta('flat1', { title: 'flat1', artist: 'A', album: 'B', duration: 214 });
  writeEdges('flat1', 20_000);
  requests.length = 0;
  await runAnalysisPass({ vocalBackfill: false, audioBackfill: false });
  const r = requests.find((q) => !q.facets && JSON.stringify(q).includes('flat1'));
  assert.ok(r, JSON.stringify(requests));
  assert.deepEqual(r.tail_window, { end_ms: 194_000, duration_ms: 214_000 }, JSON.stringify(r));
  assert.ok(typeof r.stream_url === 'string' || typeof r.url === 'string', JSON.stringify(r));
  const t = db.getTrack('flat1')!;
  assert.equal(t.outro?.startMs, 189_000);
  assert.equal(t.tailStartMs, 194_000);
  assert.equal(tailVersionCol('flat1'), 2);
  assert.deepEqual([tailRow('flat1')?.status, tailRow('flat1')?.version], ['ok', 2]);
});

test('the planner explains where the tail window comes from', () => {
  track('w1');
  const p = plan(['w1']);
  const note = p.warnings.find((w) => w.startsWith('tail:'));
  assert.ok(note && /edges/.test(note) && !/byte-capped/.test(note), p.warnings.join('\n'));
});
