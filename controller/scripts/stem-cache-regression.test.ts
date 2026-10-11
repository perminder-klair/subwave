import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { createTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-stem-regression-'));
const snapFile = join(stateDir, 'stem-cache-usage.json');
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const HOUR = 3600_000;
let writeWindow: 'head' | 'tail' = 'head';
let writeBytes = 0;
const requestSchema = z.object({ stems_dir: z.string().optional() });
const snapshotSchema = z.object({
  bytes: z.number(), dirs: z.number(),
  pending: z.object({ pid: z.number(), since: z.string() }).optional(),
});
const snapshot = () => snapshotSchema.parse(JSON.parse(readFileSync(snapFile, 'utf8')));

// Sparse payloads exercise the real byte budget without allocating a gigabyte.
function payload(dir: string, window: 'head' | 'tail', bytes: number): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${window}-drums.flac`);
  writeFileSync(file, '');
  truncateSync(file, bytes);
}

const fixture = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, engines: ['analyze'], analyze_vocal_capable: true,
      analyze_audio_capable: false, analyze_text_capable: false,
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/analyze') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    assert.ok(body.stems_dir, 'analysis must allocate a stem directory');
    payload(body.stems_dir, writeWindow, writeBytes);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, bpm: 120, key: 'Am', stems_cached: true }));
    return;
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.end(Buffer.alloc(2048, 0x41));
});

let cache: typeof import('../src/music/stem-cache.js');
let db: typeof import('../src/music/library-db.js');
let settings: typeof import('../src/settings.js');
let analyzer: typeof import('../src/music/analyzer.js');
let runAnalysisPass: typeof import('../src/music/analyze.js').runAnalysisPass;

before(async () => {
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  process.env.STATE_DIR = stateDir;
  process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
  process.env.NAVIDROME_URL = process.env.ANALYZE_URL;
  process.env.ANALYZE_QUIET_ONLY = '0';
  process.env.ANALYZE_CONCURRENCY = '1';
  cache = await import('../src/music/stem-cache.js');
  db = await import('../src/music/library-db.js');
  settings = await import('../src/settings.js');
  analyzer = await import('../src/music/analyzer.js');
  ({ runAnalysisPass } = await import('../src/music/analyze.js'));
});

beforeEach(async () => {
  await settings.update({ audio: { stemCache: true, stemCacheGb: 1, analyzeQuietOnly: false } });
  await db.open({ embeddingDim: 768, adoptStoredDim: true });
});

afterEach(() => {
  chmodSync(stateDir, 0o700);
  db.close();
  for (const name of ['stems', 'stem-cache-usage.json', 'library.db', 'library.db-wal', 'library.db-shm']) {
    rmSync(join(stateDir, name), { recursive: true, force: true });
  }
});

after(async () => {
  analyzer?.shutdown();
  await new Promise<void>((resolve, reject) => fixture.close(err => err ? reject(err) : resolve()));
  rmSync(stateDir, { recursive: true, force: true });
});

const addTrack = (id: string) => db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 200 });
const runPass = () => runAnalysisPass({ audioBackfill: false, vocalBackfill: false });

test('reanalysis completes a partial stem dir and evicts its growth above budget', async () => {
  addTrack('partial');
  payload(cache.dirFor('partial'), 'head', 600 * MB);
  await cache.usage();
  writeWindow = 'tail';
  writeBytes = 600 * MB;
  assert.equal((await runPass()).analyzed, 1);
  assert.equal(existsSync(cache.dirFor('partial')), false, 'the completed dir exceeds the 1 GB budget');
  assert.equal((await cache.usage()).bytes, 0);
});

test('a doctor usage walk during a pass does not double-count its new dirs', async () => {
  payload(cache.dirFor('old'), 'head', 100);
  await cache.usage();
  await cache.markPassPending();
  payload(cache.dirFor('new1'), 'head', 200);
  assert.equal((await cache.usage()).bytes, 300);
  payload(cache.dirFor('new2'), 'head', 300);
  assert.deepEqual(await cache.settlePassWrites(['new1', 'new2'], 1000), {
    bytes: 600, dirs: 3, withinBudget: true,
  });
  assert.equal((await cache.usage()).bytes, 600);
});

test('failed pending publication forces post-pass eviction despite an old snapshot', async () => {
  addTrack('new');
  payload(cache.dirFor('old'), 'head', 100 * MB);
  await cache.usage();
  writeWindow = 'head';
  writeBytes = 1200 * MB;
  // The analyzer can write inside stems while the state directory rejects publication.
  chmodSync(stateDir, 0o500);
  try {
    assert.equal((await runPass()).analyzed, 1);
    assert.equal(existsSync(cache.dirFor('new')), false, 'old usage must not hide the over-budget write');
  } finally {
    chmodSync(stateDir, 0o700);
  }
});

test('an untrustworthy settlement forces the next sweep to measure fresh usage', async () => {
  payload(cache.dirFor('old'), 'head', 100);
  await cache.usage();
  await cache.markPassPending();
  payload(cache.dirFor('new'), 'head', 200);
  const now = new Date().toISOString();
  writeFileSync(snapFile, JSON.stringify({
    version: 1, root: cache.stemsRoot(), bytes: 100, dirs: 1,
    measuredAt: now, updatedAt: now,
  }));
  assert.equal(await cache.settlePassWrites(['new'], 200), null);
  const swept = await cache.sweep(200);
  assert.equal(swept.skipped, undefined);
  assert.ok(swept.removed > 0);
  assert.ok((await cache.usage()).bytes <= 200);
});

test('a live pending pass keeps its dirs when its idle measurement expires', async () => {
  payload(cache.dirFor('writing'), 'head', 300);
  const now = new Date().toISOString();
  writeFileSync(snapFile, JSON.stringify({
    version: 1, root: cache.stemsRoot(), bytes: 100, dirs: 1,
    measuredAt: new Date(Date.now() - 25 * HOUR).toISOString(), updatedAt: now,
    pending: { pid: process.ppid, since: new Date(Date.now() - 2 * HOUR).toISOString() },
  }));
  const swept = await cache.sweep(200);
  assert.equal(swept.skipped, 'pass-running');
  assert.equal(statSync(join(cache.dirFor('writing'), 'head-drums.flac')).size, 300);
});

test('a successful no-work analysis pass leaves no pending snapshot marker', async () => {
  const result = await runPass();
  assert.equal(result.scope, 0);
  assert.equal(result.available, true);
  assert.equal(snapshot().pending, undefined);
  assert.equal((await cache.sweep(GB)).skipped, 'snapshot');
});
