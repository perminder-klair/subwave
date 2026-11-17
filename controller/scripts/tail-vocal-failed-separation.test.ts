// A flat analysis with vocal detection on whose tail separation fails (#2318).
//
// The worker's Demucs tail pass is best-effort: when it throws, the answer
// still carries the outro, only without `vocalRanges`. The flat write used to
// carry the stored tail vocal ranges only on a vocal-off pass
// (`preserveTailVocal: !vocalWantedHere`), so a vocal-on pass whose tail
// separation failed replaced a stored sung tail with an unmeasured one. A
// track with an instrumental head and a sung ending then read as instrumental
// (an instrumental-only show could pick it) until the next vocal pass.
//
// Pinned here, through runAnalysisPass against a stub analyzer:
//   - the stored tail ranges carry onto the new outro, so the instrumental
//     verdict does not move toward instrumental unmeasured;
//   - the vocal row follows its columns: the fresh head plus the carried
//     reading of the same window hold both halves, so it settles, as the
//     vocal-off carry does (#2255), instead of turning head-only;
//   - a tail measured with its vocals still replaces the stored ranges.
//
// Run: `npm test -- tail-vocal-failed-separation`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// The tail vocals the stub's next flat answer carries: undefined = the tail
// separation failed (no `vocalRanges` on the outro).
let tailVocals: Array<{ startMs: number; endMs: number }> | undefined;
const requests: Array<Record<string, unknown>> = [];

function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.url?.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_audio_capable: false,
      analyze_vocal_capable: true, analyze_tail_vocal_capable: true,
    }));
    return;
  }
  if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: true, bpm: 120, key: 'Am', intro_ms: 0, confidence: 0.9, loudness_lufs: -10, peak_db: -1,
        // The head was separated and is instrumental.
        vocal_ranges: [],
        outro: { startMs: 199_000, ending: 'fade', ...(tailVocals ? { vocalRanges: tailVocals } : {}) },
        tail_silence_ms: 500, tail_start_ms: 213_500,
      }));
    });
    return;
  }
  res.setHeader('Content-Type', 'audio/flac');
  res.end(Buffer.alloc(1024, 1));
}

const server = createServer(handler);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const stateDir = createTempDir(join(tmpdir(), 'subwave-tail-vocal-fail-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_URL = `http://127.0.0.1:${port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
delete process.env.ANALYZE_AUDIO_EMBEDDING;
delete process.env.ANALYZE_VOCAL_ACTIVITY;
delete process.env.ANALYZE_WHOLE_FILE;

const db = await import('../src/music/library-db.js');
const { runAnalysisPass } = await import('../src/music/analyze.js');
const analyzer = await import('../src/music/analyzer.js');
const LV = await import('../src/music/lyric-vocal.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
await analyzer.isAvailable();

after(async () => {
  analyzer.shutdown();
  server.close();
  await removeTempDir(stateDir);
});

const SUNG_TAIL = [{ startMs: 205_000, endMs: 211_000 }];
const OUTRO = { startMs: 200_000, ending: 'fade' as const, lufs: null, bpm: null, beats: null, bars: null };

// Analysed, with a sung end-of-file tail stored and the head's vocals not yet
// measured, so the vocal backfill picks it up.
function seed(id: string) {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 214 });
  db.upsertTrackAnalysis(id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
  db.writeFacetResults(id, { source: 'full', tail: {
    outro: { ...OUTRO, vocalRanges: SUNG_TAIL }, tailSilenceMs: 500, tailStartMs: 213_500 } });
  assert.equal(db.getTrack(id)!.vocalRanges ?? null, null, 'fixture: head vocals unmeasured');
  assert.deepEqual(db.getTrack(id)!.outro?.vocalRanges, SUNG_TAIL, 'fixture: a sung tail');
}

test('a failed tail separation keeps the stored tail vocals and the verdict', async () => {
  seed('fail');
  tailVocals = undefined;
  requests.length = 0;
  await runAnalysisPass({ vocalBackfill: true, audioBackfill: false });
  const sent = requests.find((r) => String(r.path ?? r.url).includes('fail'));
  assert.ok(sent, 'the track was analysed');
  assert.equal(sent!.vocal, true, 'with vocal detection on');

  const t = db.getTrack('fail')!;
  assert.deepEqual(t.vocalRanges, [], 'the head measurement is written');
  assert.equal(t.outro?.startMs, 199_000, 'onto the fresh outro');
  assert.deepEqual(t.outro?.vocalRanges, SUNG_TAIL, 'the stored tail vocals carried');
  assert.equal(LV.isInstrumental(t as never), false, 'a sung ending is not read as instrumental');
  // The carried ranges are a real reading of this same window, so with the
  // fresh head the row holds both halves and settles, as the vocal-off carry
  // does (#2255); before the fix it turned head-only and was separated again.
  assert.ok(!db.facetNeedsIds('vocal').includes('fail'), 'both halves held: the vocal row settles');
});

test('a tail measured with its vocals still replaces the stored ones', async () => {
  seed('measured');
  tailVocals = [];
  await runAnalysisPass({ vocalBackfill: true, audioBackfill: false });
  const t = db.getTrack('measured')!;
  assert.deepEqual(t.outro?.vocalRanges, [], 'an instrumental reading of the same window replaces them');
  assert.equal(LV.isInstrumental(t as never), true);
  assert.ok(!db.facetNeedsIds('vocal').includes('measured'), 'measured, so settled');
});
