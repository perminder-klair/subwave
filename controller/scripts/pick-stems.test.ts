// Pick-time stems runner (#2197, broadcast/pick-stems.ts), end to end over
// loopback HTTP: one server plays both the analyzer sidecar (/health,
// /analyze, /render-transition) and Navidrome (/rest/stream), so the real
// capped download, facet request, stems marker, budget headroom, facet write
// and usage snapshot all run. The fake worker writes stem files the way the
// real one does: head always, tail only from a complete file.
//
// Pinned here:
// - a separation writes the stems, stamps stems_at and logs started + done;
// - its bytes reach the hourly sweep's budget check without a walk (the sweep
//   used to trust a snapshot that only the analysis pass kept current);
// - while the worker separates, the blend render stands down instead of
//   queueing behind it, and a second pick is turned away (single-flight);
// - every IO-backed veto sends nothing to the worker.
//
// Run: `npm test -- pick-stems.test`.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const MAX_BYTES = 4096;
const STEM_BYTES = 1000;
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];

interface AnalyzeBody {
  path?: string;
  url?: string;
  facets?: string[];
  complete?: boolean;
  stems_dir?: string;
  stems_require_marker?: boolean;
}

const seen = { analyze: [] as AnalyzeBody[], render: 0, stream: [] as string[] };
// Set by a test to hold the fake worker mid-separation.
let holdWorker: Promise<void> | null = null;
let onWorkerStart: (() => void) | null = null;

async function readJson(req: IncomingMessage): Promise<AnalyzeBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeStems(dir: string, window: 'head' | 'tail'): void {
  mkdirSync(dir, { recursive: true });
  for (const s of STEM_NAMES) writeFileSync(path.join(dir, `${window}-${s}.flac`), Buffer.alloc(STEM_BYTES, 1));
  if (window === 'tail') writeFileSync(path.join(dir, 'tail-meta.json'), JSON.stringify({ duration_s: 200, offset_s: 180 }));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_facets_capable: true, analyze_vocal_capable: true,
    }));
    return;
  }
  if (url.pathname.startsWith('/rest/stream')) {
    const id = url.searchParams.get('id') || '';
    seen.stream.push(id);
    // 'big-' ids run past the download cap, as a long FLAC does.
    const body = Buffer.alloc(id.startsWith('big-') ? MAX_BYTES * 4 : 2048, 0x5a);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) });
    res.end(body);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/render-transition') {
    seen.render += 1;
    res.writeHead(404).end(); // a pre-render sidecar: no blend, and no error
    return;
  }
  if (req.method === 'POST' && url.pathname === '/analyze') {
    const body = await readJson(req);
    seen.analyze.push(body);
    onWorkerStart?.();
    if (holdWorker) await holdWorker;
    if (body.stems_dir) {
      writeStems(body.stems_dir, 'head');
      // 'fail-' ids die after the head, as a request that times out would
      // while the worker carries on writing.
      if (path.basename(body.stems_dir).startsWith('fail-')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'worker died' }));
        return;
      }
      if (body.complete) writeStems(body.stems_dir, 'tail');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      facets: { stems: { status: 'ok', data: { stems_cached: true, tail_stems: !!body.complete } } },
      source: { kind: 'path', duration_s: 200, complete: body.complete ?? null },
    }));
    return;
  }
  res.writeHead(404).end();
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-pick-stems-'));
process.env.STATE_DIR = stateRoot;
process.env.ANALYZE_URL = base;
process.env.ANALYZE_MAX_BYTES = String(MAX_BYTES);
process.env.NAVIDROME_URL = base;
process.env.NAVIDROME_USER = 'test';
process.env.NAVIDROME_PASS = 'test';
delete process.env.ANALYZE_QUIET_ONLY;

const settings = await import('../src/settings.js');
const db = await import('../src/music/library-db.js');
const stemCache = await import('../src/music/stem-cache.js');
const analyzer = await import('../src/music/analyzer.js');
const pickStems = await import('../src/broadcast/pick-stems.js');
const stemBlend = await import('../src/broadcast/stem-blend.js');
const { pidfilePath } = await import('../src/music/tagger-lock.js');

await settings.load();
await settings.update({
  personas: settings.get().personas.map(p => ({ ...p, djMode: true })),
  transitions: { pairDrain: true, stemBlends: true, pickTimeStems: true },
  audio: { stemCache: true },
});
await db.open({ embeddingDim: 768, adoptStoredDim: true });

after(async () => {
  analyzer.shutdown();
  db.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTempDir(stateRoot);
});

const BARS = [0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000];
function addTrack(id: string, grids: { head?: boolean; tail?: boolean } = { head: true, tail: true }): void {
  db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200 });
  db.upsertTrackAnalysis(id, {
    bpm: 120,
    bars: grids.head ? BARS : null,
    outro: grids.tail
      ? { startMs: 180_000, ending: 'fade', lufs: -14, bpm: 120, beats: null, bars: BARS.map(b => 180_000 + b) }
      : null,
  });
}

const OPTS = { pairDrainActive: true, held: true };
function run(id: string, opts: Partial<typeof OPTS> = {}) {
  const lines: string[] = [];
  const outcome = pickStems.maybeSeparateAtPick(
    { id, title: `Song ${id}` },
    { ...OPTS, ...opts, log: (kind, message) => lines.push(`[${kind}] ${message}`) },
  );
  return { lines, outcome };
}
const analyzedIds = () => seen.analyze.map(b => path.basename(String(b.stems_dir)));
const snapFile = path.join(stateRoot, 'stem-cache-usage.json');
const stagingDir = path.join(stateRoot, 'analyze-tmp');

// ---- the stems share ------------------------------------------------------

test('an unmounted stems share (catalogue remembers stems, root is empty) writes nothing', async () => {
  addTrack('offline-1');
  db.stampStemsCached('offline-1'); // the catalogue says a cache exists somewhere
  const { outcome } = run('offline-1');
  assert.deepEqual(await outcome, { ran: false, veto: 'root-offline' });
  assert.equal(seen.analyze.length, 0);
  assert.equal(existsSync(path.join(stemCache.stemsRoot(), stemCache.STEMS_MARKER)), false);
  // Mount it: the marker is what says the cache is here.
  mkdirSync(stemCache.stemsRoot(), { recursive: true });
  writeFileSync(path.join(stemCache.stemsRoot(), stemCache.STEMS_MARKER), '');
});

// ---- a separation ---------------------------------------------------------

test('a held pick with both grids gets head and tail stems, a stems_at stamp and two log lines', async () => {
  addTrack('p1');
  assert.ok(db.needsStemsIds().includes('p1'));
  const { lines, outcome } = run('p1');
  const result = await outcome;
  assert.equal(result.ran, true);
  assert.equal(result.ran && result.ok, true);
  assert.deepEqual(analyzedIds(), ['p1']);
  const req = seen.analyze[0];
  assert.deepEqual(req.facets, ['stems'], 'the stems facet alone: no CLAP, head or loudness');
  assert.equal(req.complete, true);
  assert.equal(req.stems_require_marker, true);
  assert.equal(req.stems_dir, stemCache.dirFor('p1'));
  assert.ok(req.path?.endsWith('p1.audio'), 'the capped download, not a url fetch by the worker');
  assert.equal(await stemCache.hasWindow('p1', 'head'), true);
  assert.equal(await stemCache.hasWindow('p1', 'tail'), true);
  assert.equal(db.needsStemsIds().includes('p1'), false, 'stamped like a pass attempt');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /^\[mix\] pick-time stems: separating "Song p1" \(head \+ tail\)/);
  assert.match(lines[1], /^\[mix\] pick-time stems: "Song p1" done in \d+\.\ds \(head \+ tail cached\)/);
  assert.deepEqual(existsSync(stagingDir) ? readdirSync(stagingDir) : [], [], 'staging file removed');
  assert.equal(pickStems.separationInFlight(), false);
});

test('a track whose windows are on disk is not separated again', async () => {
  const before = seen.analyze.length;
  assert.deepEqual(await run('p1').outcome, { ran: false, veto: 'cached' });
  assert.equal(seen.analyze.length, before);
});

test('only the tail missing on a truncated download: no worker call, staging removed', async () => {
  addTrack('big-1');
  writeStems(stemCache.dirFor('big-1'), 'head');
  const before = seen.analyze.length;
  assert.deepEqual(await run('big-1').outcome, { ran: false, veto: 'truncated' });
  assert.equal(seen.analyze.length, before);
  assert.ok(seen.stream.includes('big-1'), 'it did download to learn the file is capped');
  assert.deepEqual(existsSync(stagingDir) ? readdirSync(stagingDir) : [], []);
});

test('a truncated download still separates a missing head, and asks for no tail', async () => {
  addTrack('big-2');
  const result = await run('big-2').outcome;
  assert.equal(result.ran && result.ok, true);
  assert.equal(seen.analyze.at(-1)?.complete, false);
  assert.equal(await stemCache.hasWindow('big-2', 'head'), true);
  assert.equal(await stemCache.hasWindow('big-2', 'tail'), false);
});

// ---- the budget -----------------------------------------------------------

test('pick-time writes reach the hourly sweep\'s budget check', async () => {
  // A trusted snapshot of what is there now, as the last sweep left it.
  await stemCache.sweep(1024 ** 3, { force: true });
  const measured = (await stemCache.storedUsage())!;
  assert.equal(measured.fresh, true);
  addTrack('p2');
  const result = await run('p2').outcome;
  assert.equal(result.ran && result.ok, true);
  const grown = (await stemCache.storedUsage())!;
  assert.equal(grown.fresh, true, 'still trusted: no walk needed for one dir');
  assert.equal(grown.dirs, measured.dirs + 1);
  assert.equal(grown.bytes - measured.bytes, (await stemCache.trackDirBytes('p2'))!);
  // A budget the old figure fits and the new one doesn't: the sweep must see it.
  const budget = measured.bytes + STEM_BYTES;
  const swept = await stemCache.sweep(budget);
  assert.equal(swept.skipped, undefined, 'the sweep walked instead of trusting a stale figure');
  assert.ok(swept.removed >= 1);
});

test('a snapshot a pass owns is marked stale rather than added to', async () => {
  await stemCache.sweep(1024 ** 3, { force: true });
  const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
  // Another process's live pass (pid 1 is always alive) owns the baseline.
  writeFileSync(snapFile, JSON.stringify({ ...snap, pending: { pid: 1, since: new Date().toISOString() } }));
  addTrack('p3');
  const result = await run('p3').outcome;
  assert.equal(result.ran && result.ok, true);
  const marked = JSON.parse(readFileSync(snapFile, 'utf8'));
  assert.equal(marked.bytes, snap.bytes, 'the pass settles its own baseline');
  assert.equal(marked.stale, true, 'so its settle refuses and the cache is walked');
  rmSync(snapFile, { force: true });
});

test('a failed request logs its duration, stamps nothing and leaves the cache to be walked', async () => {
  await stemCache.sweep(1024 ** 3, { force: true });
  addTrack('fail-1');
  const { lines, outcome } = run('fail-1');
  const result = await outcome;
  assert.equal(result.ran, true);
  assert.equal(result.ran && result.ok, false);
  assert.match(lines.at(-1) ?? '', /^\[warn\] pick-time stems: "Song fail-1" failed after \d+\.\ds: /);
  assert.ok(db.needsStemsIds().includes('fail-1'), 'no stems_at: the backfill still owns it');
  const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
  assert.equal(snap.stale, true, 'the worker may still be writing, so the next read walks');
  assert.equal(pickStems.separationInFlight(), false);
  rmSync(snapFile, { force: true });
});

test('a net-new dir with no headroom left is not written', async () => {
  addTrack('p4');
  const now = new Date().toISOString();
  writeFileSync(snapFile, JSON.stringify({
    version: 1, root: stemCache.stemsRoot(), bytes: 15 * 1024 ** 3, dirs: 600, measuredAt: now, updatedAt: now,
  }));
  const before = seen.analyze.length;
  assert.deepEqual(await run('p4').outcome, { ran: false, veto: 'budget-full' });
  assert.equal(seen.analyze.length, before);
  assert.equal(existsSync(stemCache.dirFor('p4')), false);
  rmSync(snapFile, { force: true });
});

// ---- the worker is spoken for -------------------------------------------

test('while it separates, a second pick is turned away and the blend render stands down', async () => {
  // A seam whose stems are all cached, so only the in-flight veto stops it.
  addTrack('out-1');
  addTrack('in-1');
  writeStems(stemCache.dirFor('out-1'), 'tail');
  writeStems(stemCache.dirFor('in-1'), 'head');
  const render = () => stemBlend.maybeRenderBlend(
    { id: 'out-1', title: 'out', replayGain: null, gainDb: 0 },
    { id: 'in-1', title: 'in', replayGain: null },
    300,
  );

  let release!: () => void;
  holdWorker = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { onWorkerStart = r; });
  addTrack('p5');
  addTrack('p6');
  const first = run('p5');
  try {
    await started;
    assert.equal(pickStems.separationInFlight(), true);
    assert.deepEqual(await run('p6').outcome, { ran: false, veto: 'in-flight' });
    const rendersBefore = seen.render;
    assert.equal(await render(), null);
    assert.equal(seen.render, rendersBefore, 'no render request queued behind the separation');
  } finally {
    holdWorker = null;
    onWorkerStart = null;
    release();
  }
  const result = await first.outcome;
  assert.equal(result.ran && result.ok, true);
  assert.equal(pickStems.separationInFlight(), false);
  // The same seam reaches the worker once the separation is done.
  const rendersBefore = seen.render;
  await render();
  assert.equal(seen.render, rendersBefore + 1, 'the setup does reach the render');
  // And the next pick goes through.
  assert.equal((await run('p6').outcome).ran, true);
});

// ---- vetoes that send nothing --------------------------------------------

test('vetoes: nothing reaches the worker or Navidrome', async () => {
  addTrack('v1');
  addTrack('v-nogrid', {});
  const streams = seen.stream.length;
  const analyses = seen.analyze.length;
  const cur = settings.get();

  assert.deepEqual(await run('v1', { held: false }).outcome, { ran: false, veto: 'not-held' });
  assert.deepEqual(await run('v1', { pairDrainActive: false }).outcome, { ran: false, veto: 'no-pair-drain' });
  assert.deepEqual(await run('v-nogrid').outcome, { ran: false, veto: 'no-grid' });

  await settings.update({ transitions: { pickTimeStems: false } });
  const off = run('v1');
  assert.deepEqual(await off.outcome, { ran: false, veto: 'off' });
  assert.deepEqual(off.lines, [], 'off is silent');
  await settings.update({ transitions: { pickTimeStems: true } });

  await settings.update({ audio: { analyzeQuietOnly: true } });
  assert.deepEqual(await run('v1').outcome, { ran: false, veto: 'quiet-only' });
  await settings.update({ audio: { analyzeQuietOnly: false } });
  process.env.ANALYZE_QUIET_ONLY = '1';
  try {
    assert.deepEqual(await run('v1').outcome, { ran: false, veto: 'quiet-only' });
  } finally {
    delete process.env.ANALYZE_QUIET_ONLY;
  }

  await settings.update({ transitions: { stemBlends: false } });
  assert.deepEqual(await run('v1').outcome, { ran: false, veto: 'no-blends' });
  await settings.update({ transitions: { stemBlends: true }, audio: { stemCache: false } });
  assert.deepEqual(await run('v1').outcome, { ran: false, veto: 'no-cache' });
  await settings.update({ audio: { stemCache: true } });

  // A live bulk pass holds the worker (its pidfile names this very process).
  writeFileSync(pidfilePath(), JSON.stringify({ pid: process.pid, mode: 'tag', startedAt: new Date().toISOString(), args: [] }));
  try {
    assert.deepEqual(await run('v1').outcome, { ran: false, veto: 'bulk-pass' });
  } finally {
    rmSync(pidfilePath(), { force: true });
  }

  assert.equal(seen.stream.length, streams);
  assert.equal(seen.analyze.length, analyses);
  assert.equal(settings.get().transitions.pickTimeStems, cur.transitions.pickTimeStems);
  // And with the gates open again it runs.
  assert.equal((await run('v1').outcome).ran, true);
});
