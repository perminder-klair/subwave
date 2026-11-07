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
// - a full budget still takes a pick, the overshoot stops at its allowance
//   however many picks come before the sweep, and the sweep's stem-priority
//   order evicts never-aired dirs before the one just separated;
// - the request has its own deadline, longer than the pass's, and one that
//   still fires is logged as a timeout the worker may yet finish;
// - while the worker separates, the blend render stands down instead of
//   queueing behind it, unless the sidecar pool has a spare member, and a
//   second pick is turned away (single-flight);
// - a station-level reason the Stems page can't show is logged once, not
//   once per pick;
// - every IO-backed veto sends nothing to the worker.
//
// Run: `npm test -- pick-stems.test`.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
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
  stems_windows?: string[];
}

const seen = { analyze: [] as AnalyzeBody[], render: 0, stream: [] as string[] };
// Set by a test to hold the fake worker mid-separation.
let holdWorker: Promise<void> | null = null;
let onWorkerStart: (() => void) | null = null;
// Set by a test for stem files of a real dir's size, written sparse so they
// cost no disk: the budget reads st.size.
let sparseStemBytes = 0;
// What the fake reports on /health (analyzer.refreshCapabilities re-reads it).
// `concurrency` is the sidecar's pool size (`analyze_concurrency`); null leaves
// the field out, as a sidecar that predates it does.
const health = { facets: true, vocal: true, concurrency: null as number | null };

async function readJson(req: IncomingMessage): Promise<AnalyzeBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeStems(dir: string, window: 'head' | 'tail'): void {
  mkdirSync(dir, { recursive: true });
  for (const s of STEM_NAMES) {
    const f = path.join(dir, `${window}-${s}.flac`);
    writeFileSync(f, Buffer.alloc(STEM_BYTES, 1));
    if (sparseStemBytes > STEM_BYTES) truncateSync(f, sparseStemBytes);
  }
  if (window === 'tail') writeFileSync(path.join(dir, 'tail-meta.json'), JSON.stringify({ duration_s: 200, offset_s: 180 }));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  req.on('error', () => {});
  res.on('error', () => {});
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_facets_capable: health.facets, analyze_vocal_capable: health.vocal,
      ...(health.concurrency === null ? {} : { analyze_concurrency: health.concurrency }),
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
    // A worker that honours stems_windows separates only the windows named.
    const windows = body.stems_windows ?? ['head', 'tail'];
    if (body.stems_dir) {
      if (windows.includes('head')) writeStems(body.stems_dir, 'head');
      // 'fail-' ids die after the head, as a request that times out would
      // while the worker carries on writing.
      if (path.basename(body.stems_dir).startsWith('fail-')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'worker died' }));
        return;
      }
      if (body.complete && windows.includes('tail')) writeStems(body.stems_dir, 'tail');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      facets: {
        stems: {
          status: 'ok',
          data: windows.includes('head')
            ? { stems_cached: true, tail_stems: !!body.complete }
            : { tail_stems: true },
        },
      },
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
const { config } = await import('../src/config.js');
const db = await import('../src/music/library-db.js');
const stemCache = await import('../src/music/stem-cache.js');
const analyzer = await import('../src/music/analyzer.js');
const pickStems = await import('../src/broadcast/pick-stems.js');
const policy = await import('../src/broadcast/pick-stems-policy.js');
const stemBlend = await import('../src/broadcast/stem-blend.js');
const { pidfilePath } = await import('../src/music/tagger-lock.js');
const { stemCacheSweepTick } = await import('../src/broadcast/scheduler.js');
const { queue } = await import('../src/broadcast/queue.js');

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
  assert.equal(req.stems_windows, undefined, 'both windows missing: the field is not sent, as before');
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

test('only the tail missing on a complete download: the worker is asked for the tail alone (#2253)', async () => {
  addTrack('tail-only-1');
  writeStems(stemCache.dirFor('tail-only-1'), 'head');
  const headFile = path.join(stemCache.dirFor('tail-only-1'), 'head-drums.flac');
  const old = (Date.now() - 3600_000) / 1000;
  utimesSync(headFile, old, old);
  const { lines, outcome } = run('tail-only-1');
  const result = await outcome;
  assert.equal(result.ran && result.ok, true);
  const req = seen.analyze.at(-1);
  assert.equal(path.basename(String(req?.stems_dir)), 'tail-only-1');
  assert.deepEqual(req?.stems_windows, ['tail']);
  assert.equal(req?.complete, true);
  assert.equal(await stemCache.hasWindow('tail-only-1', 'tail'), true);
  assert.ok(Math.abs(statSync(headFile).mtimeMs - old * 1000) < 1000, 'the cached head is not separated again');
  assert.match(lines[0], /separating "Song tail-only-1" \(tail\)/);
  assert.match(lines[1], /\(head \+ tail cached\)/);
  assert.equal(db.needsStemsIds().includes('tail-only-1'), false, 'stamped like any attempt');
});

test('a truncated download still separates a missing head, and asks for no tail', async () => {
  addTrack('big-2');
  const result = await run('big-2').outcome;
  assert.equal(result.ran && result.ok, true);
  assert.equal(seen.analyze.at(-1)?.complete, false);
  assert.equal(seen.analyze.at(-1)?.stems_windows, undefined, 'a head to fill asks for both, as before');
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

const MB = 1024 ** 2;
const DAY_S = 86_400;
// The cache as a finished backfill leaves it: exactly at its budget (15 GB,
// the default), so the pass's headroom is 0 for good.
function fullSnapshot(bytes = stemCache.budgetBytes(), dirs = 600): void {
  const now = new Date().toISOString();
  writeFileSync(snapFile, JSON.stringify({
    version: 1, root: stemCache.stemsRoot(), bytes, dirs, measuredAt: now, updatedAt: now,
  }));
}
function ageDir(id: string, secondsAgo: number): void {
  const t = Date.now() / 1000 - secondsAgo;
  for (const f of readdirSync(stemCache.dirFor(id))) utimesSync(path.join(stemCache.dirFor(id), f), t, t);
}
function aired(id: string): void {
  db.recordPlay({
    trackId: id, title: `Song ${id}`, artist: 'A', album: 'B', playedAt: new Date().toISOString(),
    source: 'ai', requestedBy: null, showId: null, showName: null,
  });
}

test('a full budget still separates a net-new pick, and the snapshot counts it', async () => {
  fullSnapshot();
  assert.equal(await stemCache.headroomTracks(), 0, 'by the pass\'s rule there is no room');
  addTrack('p4');
  const { lines, outcome } = run('p4');
  const result = await outcome;
  assert.equal(result.ran && result.ok, true);
  assert.equal(await stemCache.hasWindow('p4', 'tail'), true);
  const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
  assert.equal(snap.bytes, stemCache.budgetBytes() + (await stemCache.trackDirBytes('p4'))!, 'over by the one dir');
  assert.equal(snap.dirs, 601);
  assert.equal(snap.stale, undefined, 'counted without a walk, so the next sweep sees it');
  assert.equal(await stemCache.headroomTracks(), 0, 'and the pass still adds nothing');
  assert.ok(!lines.some(l => l.startsWith('[warn]')), lines.join('\n'));
  rmSync(snapFile, { force: true });
});

test('many picks before the sweep: the overshoot stops at its allowance, and is said once', async () => {
  const budget = stemCache.budgetBytes();
  fullSnapshot(budget, 600);
  sparseStemBytes = 16 * MB; // a 128 MB dir: head + tail, four stems each
  const outcomes: Array<Awaited<ReturnType<typeof run>['outcome']>> = [];
  const warns: string[] = [];
  const analysesBefore = seen.analyze.length;
  try {
    for (let i = 0; i < 12; i++) {
      addTrack(`many-${i}`);
      const { lines, outcome } = run(`many-${i}`);
      outcomes.push(await outcome);
      warns.push(...lines.filter(l => l.startsWith('[warn]')));
    }
  } finally {
    sparseStemBytes = 0;
  }
  const ran = outcomes.filter(o => o.ran).length;
  assert.ok(ran >= 2, `${ran} separated`);
  assert.ok(outcomes.slice(0, ran).every(o => o.ran && o.ok), 'every pick until the ceiling ran');
  assert.ok(outcomes.slice(ran).every(o => !o.ran && 'veto' in o && o.veto === 'budget-full'),
    'and none after it until the sweep');
  assert.equal(seen.analyze.length - analysesBefore, ran, 'a turned-away pick sends nothing to the worker');

  const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
  const allowance = policy.overshootAllowanceBytes(budget, stemCache.estimateTrackBytes(snap.bytes, snap.dirs));
  const oneDir = (await stemCache.trackDirBytes('many-0'))!;
  assert.ok(oneDir >= 128 * MB);
  assert.ok(snap.bytes - budget >= allowance, 'the allowance was spent before a pick was turned away');
  assert.ok(snap.bytes - budget <= allowance + oneDir,
    `${Math.round((snap.bytes - budget) / MB)} MB over, allowance ${Math.round(allowance / MB)} MB + one dir`);
  assert.deepEqual(warns, [`[warn] ${policy.NOTICE_MESSAGES['budget-full']}`], 'one booth-log line for the lot');
  rmSync(snapFile, { force: true });
});

test('the sweep evicts never-aired dirs the backfill wrote before the one just separated', async () => {
  rmSync(snapFile, { force: true });
  for (const id of ['bf-1', 'bf-2', 'bf-3']) {
    addTrack(id);
    writeStems(stemCache.dirFor(id), 'head');
    writeStems(stemCache.dirFor(id), 'tail');
    ageDir(id, DAY_S);
  }
  addTrack('fresh-1');
  assert.equal((await run('fresh-1').outcome).ran, true);
  // A budget only one dir fits: the sweep evicts in its order until it does,
  // so whatever survives was last in line.
  const swept = await stemCache.sweep((await stemCache.trackDirBytes('fresh-1'))!);
  assert.ok(swept.removed >= 3);
  assert.equal(existsSync(stemCache.dirFor('fresh-1')), true, 'the just-separated dir goes last');
  for (const id of ['bf-1', 'bf-2', 'bf-3']) assert.equal(existsSync(stemCache.dirFor(id)), false, id);
});

test('once it airs, a separated dir outranks newer never-aired ones', async () => {
  addTrack('aired-1');
  addTrack('unaired-1');
  assert.equal((await run('aired-1').outcome).ran, true);
  assert.equal((await run('unaired-1').outcome).ran, true);
  for (const id of ['bf-4', 'bf-5']) {
    addTrack(id);
    writeStems(stemCache.dirFor(id), 'head');
    writeStems(stemCache.dirFor(id), 'tail');
  }
  // Both separated dirs older than the backfill's, so mtime alone would evict
  // them first; only one has aired.
  ageDir('aired-1', 2 * DAY_S);
  ageDir('unaired-1', 2 * DAY_S);
  aired('aired-1');
  await stemCache.sweep((await stemCache.trackDirBytes('aired-1'))!);
  assert.equal(existsSync(stemCache.dirFor('aired-1')), true, 'airplay ranks it above every never-aired dir');
  for (const id of ['unaired-1', 'bf-4', 'bf-5']) assert.equal(existsSync(stemCache.dirFor(id)), false, id);
});

// ---- the hourly sweep keeps the queue last ------------------------------
// Once pick-time stems has run for a while, the cache has turned over to
// tracks that aired: a two-sided dir aired 30 days ago scores
// 2 * (100 + 20 + 40) = 320. A just-separated pick has not aired, so it scores
// 200 (100 one-sided, 280 if it aired more than 90 days ago) and stem-priority
// alone would evict it first, before its seam renders. These run the real
// separation and the real hourly tick (scheduler.ts stemCacheSweepTick) on a
// 1 GB budget filled with sparse 16 MB dirs, so the pick takes it just over.

function clearCache(): void {
  for (const name of readdirSync(stemCache.stemsRoot())) {
    if (!name.startsWith('.')) rmSync(path.join(stemCache.stemsRoot(), name), { recursive: true, force: true });
  }
  rmSync(snapFile, { force: true });
}
function airedDaysAgo(id: string, days: number): void {
  db.recordPlay({
    trackId: id, title: `Song ${id}`, artist: 'A', album: 'B',
    playedAt: new Date(Date.now() - days * DAY_S * 1000).toISOString(),
    source: 'ai', requestedBy: null, showId: null, showName: null,
  });
}

interface SweepScenario {
  cacheAiredDaysAgo: number | null; // null: a never-aired backfill
  pick: string;
  pickGrids?: { head?: boolean; tail?: boolean };
  pickAiredDaysAgo?: number;
  queued?: boolean;         // the pick still waits in the queue at the sweep
  enabledAtSweep?: boolean; // transitions.pickTimeStems when the tick runs
}

async function sweepScenario(sc: SweepScenario): Promise<{ pickSurvives: boolean; evicted: string[] }> {
  clearCache();
  await settings.update({ audio: { stemCacheGb: 1 } });
  const backfill: string[] = [];
  sparseStemBytes = 2 * MB; // 8 stem files: a 16 MB dir
  const item = { track: { id: sc.pick, title: `Song ${sc.pick}` }, queuedAt: new Date().toISOString(), sent: false };
  try {
    for (let i = 0; i < 63; i++) { // 1008 MB: under the 1 GB budget
      const id = `${sc.pick}-bf-${i}`;
      addTrack(id);
      db.stampStemsCached(id);
      writeStems(stemCache.dirFor(id), 'head');
      writeStems(stemCache.dirFor(id), 'tail');
      ageDir(id, 3 * DAY_S);
      if (sc.cacheAiredDaysAgo !== null) airedDaysAgo(id, sc.cacheAiredDaysAgo);
      backfill.push(id);
    }
    addTrack(sc.pick, sc.pickGrids);
    if (sc.pickAiredDaysAgo !== undefined) airedDaysAgo(sc.pick, sc.pickAiredDaysAgo);
    const result = await run(sc.pick).outcome;
    assert.equal(result.ran && result.ok, true, JSON.stringify(result));
    if (sc.queued !== false) queue.upcoming.push(item as unknown as (typeof queue.upcoming)[number]);
    if (sc.enabledAtSweep === false) await settings.update({ transitions: { pickTimeStems: false } });
    await stemCacheSweepTick();
    return {
      pickSurvives: existsSync(stemCache.dirFor(sc.pick)),
      evicted: backfill.filter(id => !existsSync(stemCache.dirFor(id))),
    };
  } finally {
    sparseStemBytes = 0;
    queue.upcoming = queue.upcoming.filter(i => i.track?.id !== sc.pick);
    await settings.update({ audio: { stemCacheGb: 15 }, transitions: { pickTimeStems: true } });
  }
}

test('a cache of aired dirs: the hourly sweep keeps a never-aired pick still in the queue', async () => {
  const r = await sweepScenario({ cacheAiredDaysAgo: 30, pick: 'mature-1' });
  assert.equal(r.pickSurvives, true, 'stem-priority alone would evict it first (200 vs 320)');
  assert.equal(r.evicted.length, 1, 'the oldest of the aired dirs went instead');
});

test('a cache of aired dirs: a pick that last aired 120 days ago is kept too', async () => {
  const r = await sweepScenario({ cacheAiredDaysAgo: 30, pick: 'mature-2', pickAiredDaysAgo: 120 });
  assert.equal(r.pickSurvives, true, '280 vs 320');
  assert.equal(r.evicted.length, 1);
});

test('a one-sided pick is kept over two-sided never-aired dirs (round 2 Decision 3)', async () => {
  const r = await sweepScenario({ cacheAiredDaysAgo: null, pick: 'one-sided-1', pickGrids: { head: true } });
  assert.equal(r.pickSurvives, true, '100 vs 200');
  assert.equal(r.evicted.length, 1);
});

test('a never-aired backfill: the pick survives either way (the newest of equals)', async () => {
  const r = await sweepScenario({ cacheAiredDaysAgo: null, pick: 'young-1' });
  assert.equal(r.pickSurvives, true);
  assert.equal(r.evicted.length, 1);
});

test('pick-time stems off at the sweep, or the pick no longer queued: the plain stem-priority order', async () => {
  const off = await sweepScenario({ cacheAiredDaysAgo: 30, pick: 'mature-off', enabledAtSweep: false });
  assert.equal(off.pickSurvives, false, 'off, the sweep is develop\'s: the lowest score goes first');
  assert.deepEqual(off.evicted, []);
  const gone = await sweepScenario({ cacheAiredDaysAgo: 30, pick: 'mature-gone', queued: false });
  assert.equal(gone.pickSurvives, false, 'only the queue is kept last');
  clearCache();
});

// ---- the request deadline ------------------------------------------------

test('the request outlives the pass\'s deadline, which the pass keeps', async () => {
  const passTimeoutMs = config.analyzer.requestTimeoutMs;
  (config.analyzer as { requestTimeoutMs: number }).requestTimeoutMs = 300;
  try {
    holdWorker = new Promise<void>(r => setTimeout(r, 800));
    addTrack('slow-1');
    const result = await run('slow-1').outcome;
    assert.equal(result.ran && result.ok, true, 'a worker 800 ms in, past a 300 ms pass deadline');
    // The pass's own facet request, on the same worker: its deadline is unchanged.
    holdWorker = new Promise<void>(r => setTimeout(r, 800));
    addTrack('slow-pass');
    await assert.rejects(
      analyzer.analyzeFacets('slow-pass', { facets: ['stems'], stems_dir: stemCache.dirFor('slow-pass') }),
      (err: unknown) => analyzer.isTimeoutError(err),
    );
  } finally {
    (config.analyzer as { requestTimeoutMs: number }).requestTimeoutMs = passTimeoutMs;
    await holdWorker;
    holdWorker = null;
    await new Promise(r => setTimeout(r, 50)); // the fake finishes its write
  }
});

test('a deadline that still fires is logged as a timeout the worker may finish', async () => {
  await stemCache.sweep(1024 ** 3, { force: true });
  let release!: () => void;
  holdWorker = new Promise<void>(r => { release = r; });
  pickStems._setRequestDeadlineForTests(300);
  addTrack('late-1');
  try {
    const { lines, outcome } = run('late-1');
    const result = await outcome;
    assert.equal(result.ran, true);
    assert.equal(result.ran && result.ok, false);
    assert.match(lines.at(-1) ?? '',
      /^\[warn\] pick-time stems: "Song late-1" timed out after \d+\.\ds \(the worker may still finish\)$/);
    assert.ok(!lines.some(l => / failed /.test(l)), lines.join('\n'));
    assert.equal(JSON.parse(readFileSync(snapFile, 'utf8')).stale, true, 'the next read walks');
    assert.ok(db.needsStemsIds().includes('late-1'), 'no stamp: unconfirmed');
    assert.equal(pickStems.separationInFlight(), false);
    assert.deepEqual(existsSync(stagingDir) ? readdirSync(stagingDir) : [], []);
  } finally {
    pickStems._setRequestDeadlineForTests(null);
    holdWorker = null;
    release();
  }
  // The worker does finish, and the walk the stale mark asked for counts it.
  for (let i = 0; i < 50 && !(await stemCache.hasWindow('late-1', 'tail')); i++) await new Promise(r => setTimeout(r, 20));
  const before = (await stemCache.storedUsage())!.dirs;
  const walked = await stemCache.usage();
  assert.equal(walked.dirs, before + 1);
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

test('a sidecar pool with a spare member renders while it separates', async () => {
  const concurrency = config.analyzer.concurrency;
  (config.analyzer as { concurrency: number }).concurrency = 2;
  let release!: () => void;
  holdWorker = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { onWorkerStart = r; });
  addTrack('p7');
  const first = run('p7');
  try {
    await started;
    assert.equal(pickStems.separationInFlight(), true);
    const rendersBefore = seen.render;
    // out-1 -> in-1 is cached (the test above).
    await stemBlend.maybeRenderBlend(
      { id: 'out-1', title: 'out', replayGain: null, gainDb: 0 },
      { id: 'in-1', title: 'in', replayGain: null },
      300,
    );
    assert.equal(seen.render, rendersBefore + 1, 'the free member takes the render');
  } finally {
    (config.analyzer as { concurrency: number }).concurrency = concurrency;
    holdWorker = null;
    onWorkerStart = null;
    release();
    // Settled even when an assertion above failed, so no claim outlives it.
    assert.equal((await first.outcome).ran, true);
  }
});

test('a sidecar whose /health reports a smaller pool than the controller\'s: the render stands down (#2253)', async () => {
  const concurrency = config.analyzer.concurrency;
  (config.analyzer as { concurrency: number }).concurrency = 2;
  health.concurrency = 1;
  await analyzer.refreshCapabilities();
  assert.equal(analyzer.sidecarConcurrency(), 1);
  let release!: () => void;
  holdWorker = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { onWorkerStart = r; });
  addTrack('p8');
  const first = run('p8');
  try {
    await started;
    const rendersBefore = seen.render;
    assert.equal(await stemBlend.maybeRenderBlend(
      { id: 'out-1', title: 'out', replayGain: null, gainDb: 0 },
      { id: 'in-1', title: 'in', replayGain: null },
      300,
    ), null);
    assert.equal(seen.render, rendersBefore, 'no spare member: nothing queued behind the separation');
  } finally {
    (config.analyzer as { concurrency: number }).concurrency = concurrency;
    health.concurrency = null;
    holdWorker = null;
    onWorkerStart = null;
    release();
    assert.equal((await first.outcome).ran, true);
    await analyzer.refreshCapabilities();
  }
  assert.equal(analyzer.sidecarConcurrency(), null, 'a sidecar without the field reads as unknown');
});

// ---- station-level notices -----------------------------------------------

test('no Demucs, or ANALYZE_QUIET_ONLY, is said once in the booth log, not once per pick', async () => {
  addTrack('n1');
  const warns = async () => {
    const { lines, outcome } = run('n1');
    return { outcome: await outcome, warns: lines.filter(l => l.startsWith('[warn]')) };
  };
  health.vocal = false;
  await analyzer.refreshCapabilities();
  try {
    const a = await warns();
    assert.deepEqual(a.outcome, { ran: false, veto: 'no-demucs' });
    assert.deepEqual(a.warns, [`[warn] ${policy.NOTICE_MESSAGES['no-demucs']}`]);
    assert.deepEqual((await warns()).warns, [], 'the next pick says nothing');
  } finally {
    health.vocal = true;
    await analyzer.refreshCapabilities();
  }

  process.env.ANALYZE_QUIET_ONLY = '1';
  try {
    const c = await warns();
    assert.deepEqual(c.outcome, { ran: false, veto: 'quiet-only' });
    assert.deepEqual(c.warns, [`[warn] ${policy.NOTICE_MESSAGES['quiet-only-env']}`], 'a change is said');
    assert.deepEqual((await warns()).warns, []);
  } finally {
    delete process.env.ANALYZE_QUIET_ONLY;
  }
  // The saved setting has its note on the Stems page, so it is not said here.
  await settings.update({ audio: { analyzeQuietOnly: true } });
  try {
    const d = await warns();
    assert.deepEqual(d.outcome, { ran: false, veto: 'quiet-only' });
    assert.deepEqual(d.warns, []);
  } finally {
    await settings.update({ audio: { analyzeQuietOnly: false } });
  }
  assert.equal((await warns()).outcome.ran, true);
});

test('an analyzer that does not answer is not blamed on its image', async () => {
  // No sidecar answers (port 9 is the discard port) and no local worker is
  // configured: facetsAvailable() is null, the same answer an old image gives.
  const urls = [...config.analyzer.urls];
  config.analyzer.urls.splice(0, urls.length, 'http://127.0.0.1:9');
  analyzer._resetBackendCacheForTests();
  addTrack('n2');
  try {
    const { lines, outcome } = run('n2');
    assert.deepEqual(await outcome, { ran: false, veto: 'no-facets' });
    const warns = lines.filter(l => l.startsWith('[warn]'));
    assert.equal(warns.length, 1, lines.join('\n'));
    assert.match(warns[0], /not answering/, 'the operator is told to check it is running');
  } finally {
    config.analyzer.urls.splice(0, config.analyzer.urls.length, ...urls);
    analyzer._resetBackendCacheForTests();
  }
  // With the sidecar back, the next pick separates and clears the notice.
  assert.equal((await run('n2').outcome).ran, true);
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
