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
//   - `tail_version` is added by name (schema.ts ensureNamedColumns, no
//     migration step), and the derivation stamp moved so production's table
//     re-derives once;
//   - a replaced file drops the stamp; a placement whose tail could not be
//     measured never stamps v2; a vocal answer merges only into an outro on
//     its window (an end-of-file one the tolerance covers counts as placed);
//     a tail written without its vocals keeps the stored ones (singing on any
//     window, [] only on its own), so the instrumental verdict never moves
//     toward instrumental unmeasured; re-measured edges that move the end
//     re-plan a placed tail.
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
// The placed window cannot be read (a damaged file even ffmpeg gives up on).
let placedMiss = false;

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
      // Vocal activity: the Demucs tail pass needs the tail window; the stub
      // answers tail vocal ranges only when it was sent the placement.
      if (r.facets.includes('vocal')) {
        // Like the worker, it says which window the tail vocals describe.
        facets.vocal = { status: 'ok', data: { vocal_ranges: [], ...(tw ? {
          tail_vocal_ranges: [{ startMs: tw.end_ms - 8000, endMs: tw.end_ms - 6000 }], tail_window: 'edges' } : {}) } };
      }
      // The whole-file lane (a regular run's backfill): edges place the tail.
      if (r.facets.includes('edges')) facets.edges = { status: 'ok', data: { edge_lead_ms: 0, edge_tail_ms: 20_000, decoded_duration_ms: 214_000 } };
      if (r.facets.includes('loudness')) facets.loudness = { status: 'ok', data: { loudness_lufs: -12, peak_db: -1, sample_peak_db: -1.2, lra_lu: 6, loudness_version: 2 } };
      if (r.facets.includes('tail') && tw && placedMiss) {
        facets.tail = { status: 'unmeasurable', reason: 'tail-not-reached' };
      } else if (r.facets.includes('tail')) {
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
const { config } = await import('../src/config.js');
const analyzer = await import('../src/music/analyzer.js');
const { checkFacets } = await import('../src/music/facet-check.js');
const { MAX_ANALYSIS_FAILURES } = await import('../src/music/analyze-capability.js');
const LV = await import('../src/music/lyric-vocal.js');
const mix = await import('../src/music/mix.js');
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
const vocalRowOf = (id: string) =>
  sql(`SELECT status, version, reason FROM track_facet_status WHERE track_id = ? AND facet = 'vocal'`).get(id) as Row | undefined;
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

const hasTailVersionCol = () => (sql(`SELECT name FROM pragma_table_info('tracks') WHERE name = 'tail_version'`).all()).length === 1;

test('the tail facet is at v2, and tail_version is added by name, with no migration step', () => {
  assert.equal(db.FACET_VERSIONS.tail, 2);
  assert.ok(hasTailVersionCol());
  // No user_version of its own to collide with another change's step.
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), 37);
});

test('an older database gets the column on open, and one that has it keeps it', async () => {
  db.requireDb().exec('ALTER TABLE tracks DROP COLUMN tail_version');
  assert.ok(!hasTailVersionCol());
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.ok(hasTailVersionCol());
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), 37, 'no step claimed');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.ok(hasTailVersionCol());
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

test('a tail re-measured without its vocals keeps the stored ones: singing on any window, [] only on its own', () => {
  // Spans are absolute file times, so singing an end-of-file window heard is
  // still true of the file once the tail is placed. Dropping it moved the
  // instrumental verdict toward instrumental with nothing re-measured.
  track('tv');
  writeEdges('tv', 20_000);
  db.writeFacetResults('tv', { source: 'full', tail: {
    outro: { ...OUTRO, vocalRanges: [{ startMs: 205_000, endMs: 208_000 }] }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  // An end-of-file re-measure without vocals keeps them (same window)...
  writeTail('tv');
  assert.deepEqual(db.getTrack('tv')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 208_000 }]);
  // ...and so does a newly placed window: singing is carried across windows.
  writeTail('tv', 2);
  assert.equal(tailVersionCol('tv'), 2);
  assert.deepEqual(db.getTrack('tv')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 208_000 }]);
  // An instrumental reading is carried on its own window only: from another
  // it says nothing about this one, and absent reads the same in the verdict.
  track('tv-inst');
  writeEdges('tv-inst', 20_000);
  db.writeFacetResults('tv-inst', { source: 'full', vocal: { vocalRanges: [], tailVocalRanges: null } });
  db.writeFacetResults('tv-inst', { source: 'full', tail: { outro: { ...OUTRO, vocalRanges: [] }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  writeTail('tv-inst');
  assert.deepEqual(db.getTrack('tv-inst')!.outro?.vocalRanges, []);
  const before = LV.isInstrumental(db.getTrack('tv-inst') as never);
  writeTail('tv-inst', 2);
  assert.equal(db.getTrack('tv-inst')!.outro?.vocalRanges ?? null, null);
  assert.equal(LV.isInstrumental(db.getTrack('tv-inst') as never), before, 'the verdict does not move');
  assert.equal(vocalRowOf('tv-inst')?.reason, 'head-only', 'measured again by the vocal backfill');
  consistent();
});

test('a flat analysis keeps tail vocal ranges it did not measure: singing on any window, [] only on its own', () => {
  // The flat write of a pass not measuring vocals (preserveTailVocal), placed
  // over an end-of-file tail: a vocal-off --re-analyze must keep the tail half
  // of the instrumental verdict (#2255).
  track('flat-tv');
  writeEdges('flat-tv', 20_000);
  db.writeFacetResults('flat-tv', { source: 'full', tail: {
    outro: { ...OUTRO, vocalRanges: [{ startMs: 205_000, endMs: 208_000 }] }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  assert.equal(tailVersionCol('flat-tv'), null, 'fixture: an end-of-file tail with vocals');
  db.upsertTrackAnalysis('flat-tv', {
    bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full', preserveTailVocal: true,
    outro: { ...OUTRO, startMs: 188_000 }, tailSilenceMs: 20_000, tailStartMs: 194_000, tailVersion: 2,
  });
  assert.equal(tailVersionCol('flat-tv'), 2);
  assert.deepEqual(db.getTrack('flat-tv')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 208_000 }], 'singing is carried');
  // Same window (placed over placed): carried, whatever it holds.
  db.writeFacetResults('flat-tv', { source: 'full', vocal: { vocalRanges: [], tailVocalRanges: [{ startMs: 189_000, endMs: 190_000 }], tailWindow: 'placed' } });
  db.upsertTrackAnalysis('flat-tv', {
    bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full', preserveTailVocal: true,
    outro: { ...OUTRO, startMs: 188_500 }, tailSilenceMs: 20_000, tailStartMs: 194_000, tailVersion: 2,
  });
  assert.deepEqual(db.getTrack('flat-tv')!.outro?.vocalRanges, [{ startMs: 189_000, endMs: 190_000 }]);
  // An instrumental end-of-file reading is not carried onto a placed tail.
  track('flat-inst');
  writeEdges('flat-inst', 20_000);
  db.writeFacetResults('flat-inst', { source: 'full', tail: { outro: { ...OUTRO, vocalRanges: [] }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  db.upsertTrackAnalysis('flat-inst', {
    bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full', preserveTailVocal: true,
    outro: { ...OUTRO, startMs: 188_000 }, tailSilenceMs: 20_000, tailStartMs: 194_000, tailVersion: 2,
  });
  assert.equal(db.getTrack('flat-inst')!.outro?.vocalRanges ?? null, null);
  consistent();
});

test('a vocal answer is merged only into an outro on the window it was measured on', () => {
  // A `--facets vocal` run merged its tail vocals into whatever outro was
  // stored, which could still be the end-of-file one.
  track('merge-eof');
  writeEdges('merge-eof', 20_000);
  writeTail('merge-eof');
  db.writeFacetResults('merge-eof', { source: 'full', vocal: {
    vocalRanges: [], tailVocalRanges: [{ startMs: 186_000, endMs: 188_000 }], tailWindow: 'placed' } });
  assert.equal(db.getTrack('merge-eof')!.outro?.vocalRanges ?? null, null, 'placed vocals stay out of an end-of-file outro');
  const vocal = sql(`SELECT reason FROM track_facet_status WHERE track_id = 'merge-eof' AND facet = 'vocal'`).get() as { reason: string | null };
  assert.equal(vocal.reason, 'head-only', 'still owed its tail vocals');
  // The end-of-file answer (an analyzer that did not place) does merge.
  db.writeFacetResults('merge-eof', { source: 'full', vocal: {
    vocalRanges: [], tailVocalRanges: [{ startMs: 205_000, endMs: 206_000 }], tailWindow: 'end' } });
  assert.deepEqual(db.getTrack('merge-eof')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 206_000 }]);
  // And a placed answer into a placed outro.
  writeTail('merge-eof', 2);
  db.writeFacetResults('merge-eof', { source: 'full', vocal: {
    vocalRanges: [], tailVocalRanges: [{ startMs: 186_000, endMs: 188_000 }], tailWindow: 'placed' } });
  assert.deepEqual(db.getTrack('merge-eof')!.outro?.vocalRanges, [{ startMs: 186_000, endMs: 188_000 }]);
  consistent();
});

test('a placement whose tail was not measured never stamps v2', () => {
  // A v2 stamp over the stored end-of-file columns (kept by COALESCE) called
  // them placed, and the tail was never planned again.
  track('no-tail');
  writeEdges('no-tail', 20_000);
  writeTail('no-tail');
  db.upsertTrackAnalysis('no-tail', { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full', tailVersion: 2 });
  assert.equal(tailVersionCol('no-tail'), null);
  assert.equal(tailRow('no-tail')?.version, 1, 'still due');
  consistent();
});

test('a replaced file drops the tail stamp with the tail', () => {
  track('swapped');
  writeEdges('swapped', 9_000);
  writeTail('swapped', 2);
  db.clearTrackAudio('swapped');
  assert.equal(tailVersionCol('swapped'), null);
  // Its first tail on the new file is read on the end-of-file window: not placed.
  writeTail('swapped');
  assert.equal(tailVersionCol('swapped'), null);
  assert.equal(tailRow('swapped')?.version, 1);
  consistent();
});

test('re-measured edges that move the end re-plan a placed tail', () => {
  track('moved');
  writeEdges('moved', 20_000);
  writeTail('moved', 2);
  // Within the tolerance: the placed window still ends at the music.
  writeEdges('moved', 21_000);
  assert.equal(tailVersionCol('moved'), 2);
  assert.ok(!db.facetNeedsIds('tail').includes('moved'));
  // Past it: the stored window no longer ends where the music stops.
  writeEdges('moved', 30_000);
  assert.equal(tailVersionCol('moved'), 1);
  assert.equal(tailRow('moved')?.version, 1);
  assert.ok(db.facetNeedsIds('tail').includes('moved'));
  // Even with short trailing silence now, it is not read as end-of-file.
  writeEdges('moved', 500);
  assert.equal(tailRow('moved')?.version, 1);
  // Placing it again settles it.
  writeTail('moved', 2);
  assert.equal(tailVersionCol('moved'), 2);
  assert.ok(!db.facetNeedsIds('tail').includes('moved'));
  // A tail placed in the same answer as the edges is not re-planned by them.
  db.writeFacetResults('moved', { source: 'url', edges: { leadMs: 0, tailMs: 9_000, durationMs: 214_000 },
    tail: { outro: OUTRO, tailSilenceMs: 9_000, tailStartMs: 205_000, version: 2 } });
  assert.equal(tailVersionCol('moved'), 2);
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

test('a placed window that cannot be read over a measured tail is a failure, not a silent ok', async () => {
  track('miss');
  writeTail('miss');
  writeEdges('miss', 9_000);
  const before = db.getTrack('miss')!;
  assert.equal(tailRow('miss')?.version, 1);
  placedMiss = true;
  try {
    for (let i = 1; i <= MAX_ANALYSIS_FAILURES; i++) {
      assert.ok(db.facetNeedsIds('tail').includes('miss'), `planned on attempt ${i}`);
      const stats = await runAnalysisPass({ plan: plan(['miss']) });
      assert.deepEqual([stats.analyzed, stats.failed], [0, 1], JSON.stringify(stats));
      const row = sql('SELECT analyze_fail_count AS n, analyze_error AS e FROM tracks WHERE id = ?').get('miss') as
        { n: number; e: string };
      assert.equal(row.n, i);
      assert.match(row.e, /tail: .*tail-not-reached/);
    }
  } finally {
    placedMiss = false;
  }
  // The stored tail is kept as it was, and the planner stops asking.
  const after_ = db.getTrack('miss')!;
  assert.deepEqual([after_.outro, after_.tailSilenceMs], [before.outro, before.tailSilenceMs]);
  assert.equal(tailRow('miss')?.status, 'ok');
  assert.ok(!db.facetNeedsIds('tail').includes('miss'));
  consistent();
});

test('a placed window that cannot be read with no tail stored is recorded as unmeasurable', async () => {
  track('miss2');
  writeEdges('miss2', 9_000);
  placedMiss = true;
  try {
    const stats = await runAnalysisPass({ plan: plan(['miss2']) });
    assert.deepEqual([stats.analyzed, stats.failed], [1, 0], JSON.stringify(stats));
  } finally {
    placedMiss = false;
  }
  assert.deepEqual([tailRow('miss2')?.status, tailRow('miss2')?.reason, tailRow('miss2')?.version],
    ['unmeasurable', 'tail-not-reached', 2]);
  consistent();
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

test('a vocal-only request sends the tail window too, so the tail vocals come back and the row settles', async () => {
  // An analysed track with a placed tail whose vocal row is head-only, planned
  // for vocal alone (`--facets vocal`). Without the placement the worker looked
  // for the end on its own copy; on a capped download it never reached it, sent
  // no tail vocals, and the row stayed head-only, planned again on every run.
  track('voc1');
  writeEdges('voc1', 20_000);
  writeTail('voc1', 2);
  db.writeFacetResults('voc1', { source: 'full', vocal: { vocalRanges: [], tailVocalRanges: null } });
  const vocalRow = () => sql(`SELECT status, version, reason FROM track_facet_status WHERE track_id = 'voc1' AND facet = 'vocal'`).get() as Row;
  assert.equal(vocalRow().reason, 'head-only', 'fixture: the stuck row');
  const vocalPlan = P.planAcoustics({
    ids: ['voc1'], facets: P.parseFacets('vocal'), where: { kind: 'needs' }, state: db.loadFacetState(P.parseFacets('vocal')),
    capabilities: { clap: false, demucs: true, tailVocal: true, wholeFile: true },
  });
  assert.deepEqual(vocalPlan.items.map(i => i.facets), [['vocal']]);
  requests.length = 0;
  await runAnalysisPass({ plan: vocalPlan });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tail_window, { end_ms: 194_000, duration_ms: 214_000 }, JSON.stringify(requests[0]));
  assert.deepEqual(db.getTrack('voc1')!.outro?.vocalRanges, [{ startMs: 186_000, endMs: 188_000 }]);
  assert.deepEqual([vocalRow().status, vocalRow().version, vocalRow().reason], ['ok', db.FACET_VERSIONS.vocal, null]);
  consistent();
});

test('placed tail vocals merge into an end-of-file outro the tolerance counts as placed, and settle on the first answer', () => {
  // An unstamped end-of-file tail whose edges show 1 s of trailing silence is
  // v2 (tailVersionOf): no tail is ever planned for it. The placed vocal
  // answer used to be refused against it (the raw stamp said end-of-file), so
  // the vocal row stayed head-only and every `--facets vocal` run separated
  // the track again.
  track('tol-voc');
  writeEdges('tol-voc', 1_000);
  writeTail('tol-voc');
  assert.equal(tailVersionCol('tol-voc'), null);
  assert.deepEqual([tailRow('tol-voc')?.status, tailRow('tol-voc')?.version], ['ok', 2], 'fixture: the tail is not due');
  for (let i = 0; i < 3; i++) {
    db.writeFacetResults('tol-voc', { source: 'full', vocal: {
      vocalRanges: [], tailVocalRanges: [{ startMs: 205_000, endMs: 207_000 }], tailWindow: 'placed' } });
    assert.deepEqual(db.getTrack('tol-voc')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 207_000 }], `answer ${i}`);
    const v = vocalRowOf('tol-voc');
    assert.deepEqual([v?.status, v?.version, v?.reason], ['ok', db.FACET_VERSIONS.vocal, null], `answer ${i}`);
    assert.ok(!db.facetNeedsIds('vocal').includes('tol-voc'), `vocal due after answer ${i}`);
    assert.ok(!db.facetNeedsIds('tail').includes('tol-voc'), `tail due after answer ${i}`);
  }
  consistent();
});

test('past the tolerance, placed tail vocals still stay out of an end-of-file outro', () => {
  // The other half of the rule: 3.001 s of silence is a different window.
  track('far-voc');
  writeEdges('far-voc', 3_001);
  writeTail('far-voc');
  db.writeFacetResults('far-voc', { source: 'full', vocal: {
    vocalRanges: [], tailVocalRanges: [{ startMs: 203_000, endMs: 205_000 }], tailWindow: 'placed' } });
  assert.equal(db.getTrack('far-voc')!.outro?.vocalRanges ?? null, null);
  assert.equal(vocalRowOf('far-voc')?.reason, 'head-only');
  assert.ok(db.facetNeedsIds('tail').includes('far-voc'), 'the tail is due, so placing it measures them');
  consistent();
});

test('a --facets vocal run settles a tolerance-covered track, and the next run plans no work for it', async () => {
  track('tol-run');
  writeEdges('tol-run', 1_000);
  writeTail('tol-run');
  db.writeFacetResults('tol-run', { source: 'full', vocal: { vocalRanges: [], tailVocalRanges: null } });
  assert.equal(vocalRowOf('tol-run')?.reason, 'head-only', 'fixture: the stuck row');
  const vocalPlan = () => P.planAcoustics({
    ids: ['tol-run'], facets: P.parseFacets('vocal'), where: { kind: 'needs' }, state: db.loadFacetState(P.parseFacets('vocal')),
    capabilities: { clap: false, demucs: true, tailVocal: true, wholeFile: true },
  });
  const first = vocalPlan();
  assert.deepEqual(first.items.map(i => i.facets), [['vocal']]);
  requests.length = 0;
  await runAnalysisPass({ plan: first });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tail_window, { end_ms: 213_000, duration_ms: 214_000 });
  assert.deepEqual(db.getTrack('tol-run')!.outro?.vocalRanges, [{ startMs: 205_000, endMs: 207_000 }]);
  for (let i = 0; i < 2; i++) {
    const again = vocalPlan();
    assert.equal(again.items.length, 0, `run ${i + 2} plans no work: ${JSON.stringify(again.items)}`);
  }
  consistent();
});

test('a regular run measures the edges first, so a NEW track\'s tail is placed on its one read', async () => {
  // A track the walk just added: no analysis, no edges. With the whole-file
  // backfill on, the run must measure its edges BEFORE the regular pass reads
  // its tail; the other way round the tail is read off the end of the file,
  // stored one version below, and nothing in the run goes back to it.
  db.upsertTrackMeta('fresh1', { title: 'fresh1', artist: 'A', album: 'B', duration: 214 });
  assert.equal(db.getTrack('fresh1')?.decodedDurationMs ?? null, null);
  // An already-analysed track that only lacks the whole-file facets: the rest
  // of the backfill, which must not hold the new track's analysis back.
  track('old1');
  (config.analyzer as { wholeFile: boolean }).wholeFile = true;
  try {
    requests.length = 0;
    await runAnalysisPass({ vocalBackfill: false, audioBackfill: false });
  } finally {
    (config.analyzer as { wholeFile: boolean }).wholeFile = false;
  }
  const mine = (q: Record<string, unknown>) => JSON.stringify(q).includes('fresh1');
  const edgesAt = requests.findIndex((q) => mine(q) && Array.isArray(q.facets) && (q.facets as string[]).includes('edges'));
  const flatAt = requests.findIndex((q) => mine(q) && !q.facets);
  assert.ok(edgesAt >= 0 && flatAt >= 0, JSON.stringify(requests));
  assert.ok(edgesAt < flatAt, `edges asked at ${edgesAt}, the tail read at ${flatAt}`);
  const oldEdgesAt = requests.findIndex((q) => JSON.stringify(q).includes('old1') && Array.isArray(q.facets) && (q.facets as string[]).includes('edges'));
  assert.ok(oldEdgesAt > flatAt, `the library backfill (old1 at ${oldEdgesAt}) runs after the regular pass (${flatAt})`);
  assert.deepEqual(requests[flatAt].tail_window, { end_ms: 194_000, duration_ms: 214_000 });
  assert.equal(tailVersionCol('fresh1'), 2);
  assert.deepEqual([tailRow('fresh1')?.status, tailRow('fresh1')?.version], ['ok', 2]);
  consistent();
});

// ── Tail vocal evidence is never dropped by a write that did not measure it ──
// The instrumental verdict reads the tail's spans (lyric-vocal.ts: "the tail
// can only move a verdict toward vocal"), so placing a tail without its vocals
// (vocal detection off, or a tail-only run that did not ask) must leave a
// sung track sung.

// The verdict both ways it is read: the JS rule and the SQL scalar's inputs.
const verdicts = (id: string) => {
  const row = sql(`SELECT vocal_ranges_json AS head, ${db.SQL_TAIL_VOCAL_RANGES} AS tail FROM tracks WHERE id = ?`)
    .get(id) as { head: string | null; tail: string | null };
  return { js: LV.isInstrumental(db.getTrack(id) as never), sql: LV.instrumentalFromJson(row.head, row.tail) };
};
// An instrumental head (measured) and a sung end-of-file tail: 7 s of singing,
// past INSTRUMENTAL_VOCAL_TOLERANCE_MS, inside both the end-of-file window and
// the placed one.
const SUNG = [{ startMs: 186_000, endMs: 193_000 }];
const sungTrack = (id: string) => {
  track(id);
  writeEdges(id, 20_000);
  db.writeFacetResults(id, { source: 'full', vocal: { vocalRanges: [], tailVocalRanges: null } });
  db.writeFacetResults(id, { source: 'full', tail: { outro: { ...OUTRO, vocalRanges: SUNG }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  assert.equal(tailVersionCol(id), null, 'fixture: an end-of-file tail');
  assert.equal(tailRow(id)?.version, 1, 'fixture: due for placement');
  assert.deepEqual(verdicts(id), { js: false, sql: 0 }, 'fixture: a sung track');
};

test('a --facets tail run with vocal detection off places the tail and keeps the track sung', async () => {
  sungTrack('sung-run');
  const p = plan(['sung-run']);
  assert.deepEqual(p.items.map(i => i.facets), [['tail']]);
  requests.length = 0;
  await runAnalysisPass({ plan: p, vocalBackfill: false });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tail_window, { end_ms: 194_000, duration_ms: 214_000 });
  assert.notEqual(requests[0].tail_vocals, true, 'no vocal re-measure was asked for');
  assert.equal(tailVersionCol('sung-run'), 2, 'the tail was placed');
  const outro = db.getTrack('sung-run')!.outro!;
  assert.deepEqual(outro.vocalRanges, SUNG, 'the sung spans are kept');
  assert.deepEqual(verdicts('sung-run'), { js: false, sql: 0 }, 'still sung');
  // Read against the MOVED window: the placed wind-down starts at 188 s, and
  // the kept span (absolute time) runs into it, so the ending reads sung.
  assert.equal(outro.startMs, 188_000);
  assert.equal(mix.vocalTailFor(outro.vocalRanges, outro.startMs), true);
  consistent();
});

test('a malformed stored span is carried as stored, so it still keeps the track out of instrumental', () => {
  // The parsed outro drops a bad span; the verdict counts it as singing.
  track('bad-span');
  writeEdges('bad-span', 20_000);
  db.writeFacetResults('bad-span', { source: 'full', vocal: { vocalRanges: [], tailVocalRanges: null } });
  db.requireDb().prepare('UPDATE tracks SET outro_json = ? WHERE id = ?').run(
    JSON.stringify({ ...OUTRO, vocalRanges: [{ startMs: 190_000, endMs: 189_000 }] }), 'bad-span');
  assert.deepEqual(verdicts('bad-span'), { js: false, sql: 0 }, 'fixture: a bad span reads vocal');
  writeTail('bad-span', 2);
  assert.equal(tailVersionCol('bad-span'), 2);
  assert.deepEqual(verdicts('bad-span'), { js: false, sql: 0 });
});

test('a placed tail measured with its vocals replaces the kept evidence', () => {
  // Vocal detection on: the re-measure arrives with the tail and wins, even
  // when it moves the verdict (the tail WAS measured for vocals).
  sungTrack('sung-remeasured');
  db.writeFacetResults('sung-remeasured', { source: 'full', tail: {
    outro: { ...OUTRO, startMs: 188_000, vocalRanges: [] }, tailSilenceMs: 20_000, tailStartMs: 194_000, version: 2 } });
  assert.deepEqual(db.getTrack('sung-remeasured')!.outro?.vocalRanges, []);
  assert.deepEqual(verdicts('sung-remeasured'), { js: true, sql: 1 });
  consistent();
});

// Last: a --re-analyze clears and re-analyses every track in this database.
test('a vocal-off --re-analyze places the tail and keeps the track sung (#2255)', async () => {
  sungTrack('sung-flat');
  requests.length = 0;
  await runAnalysisPass({ reAnalyze: true, vocalBackfill: false, audioBackfill: false });
  const mine = requests.find((q) => JSON.stringify(q).includes('sung-flat') && !q.facets);
  assert.ok(mine, 'the flat request was sent');
  assert.deepEqual(mine.tail_window, { end_ms: 194_000, duration_ms: 214_000 });
  assert.equal(tailVersionCol('sung-flat'), 2, 'the flat answer placed the tail');
  assert.deepEqual(db.getTrack('sung-flat')!.outro?.vocalRanges, SUNG);
  assert.deepEqual(verdicts('sung-flat'), { js: false, sql: 0 });
  consistent();
});
