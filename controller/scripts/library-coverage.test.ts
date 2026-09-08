// #1570: `coverage.total` is one Navidrome getAlbum call per album, so three
// things must hold — get() NEVER scans, the count PERSISTS (nothing recounts
// unattended, so an in-memory cache would blank it every restart), and a
// failed count is recorded rather than only logged.
//
// Pinned both behaviourally (doScan sets `scanning` before its first await)
// and from source, since the behavioural half cannot tell a scan that never
// started from one that failed instantly against a stub server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-library-coverage-'));
process.env.STATE_DIR = STATE;

const COUNT_FILE = join(STATE, 'library-count.json');
const SRC = new URL('../src/music/library-coverage.ts', import.meta.url);
const ROUTES = new URL('../src/routes/library.ts', import.meta.url);

const coverage = await import('../src/music/library-coverage.js');

// The source files name refresh() in their own comments, so strip comments
// before asserting on code.
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, '');

test.after(() => rmSync(STATE, { recursive: true, force: true }));

test('get() never starts a scan', async () => {
  // doScan() sets cache.scanning synchronously, before its first await.
  const snap = await coverage.get();
  assert.equal(snap.scanning, false, 'get() started a scan');
  assert.equal(snap.total, null, 'an uncounted library must report a null total, not 0');
  assert.equal(snap.percent, null, 'percent is null while the total is unknown');
  assert.equal(snap.scannedAt, null);

  // Twice: a second read is where a TTL staleness check would fire.
  const again = await coverage.get();
  assert.equal(again.scanning, false, 'a repeat get() started a scan');
  assert.equal(again.total, null);
});

test('the read path names no walker', async () => {
  const src = codeOnly(await readFile(SRC, 'utf8'));
  const body = src.slice(src.indexOf('export async function get()'));
  assert.ok(
    !/\brefresh\(\)/.test(body),
    'get() calls refresh() — that is the #1570 bug, a scan on the read path',
  );
  assert.ok(
    !/\bSTALE_MS\b|\bisStale\b/.test(src),
    'a staleness check is back in library-coverage — get() must never expire its own cache',
  );
});

test('GET /library/coverage has no ?refresh=1 escape hatch', async () => {
  const src = codeOnly(await readFile(ROUTES, 'utf8'));
  assert.ok(
    !/query\?*\.?\[?['"]?refresh/.test(src),
    'a GET that can start a walk is the shape something eventually polls by accident',
  );
});

test('a library reset does not recount Navidrome', async () => {
  const src = codeOnly(await readFile(ROUTES, 'utf8'));
  const reset = src.slice(src.indexOf("router.post('/library/reset'"));
  const body = reset.slice(0, reset.indexOf('\n// ---'));
  assert.ok(
    !/coverage\.refresh\(\)/.test(body),
    'reset wipes library.db, not Navidrome — the total it would recompute cannot have changed',
  );
});

test('every percentage is capped at 100, not just floored', async () => {
  // The numerator is a live library.db count, the denominator the last
  // Navidrome walk, and they drift by design — a 1413-track db against a
  // 48-song server rendered "2943% tagged".
  const src = codeOnly(await readFile(SRC, 'utf8'));
  const body = src.slice(src.indexOf('const pctOf'), src.indexOf('const embeddedMeta'));
  assert.match(body, /Math\.min\(\s*100/, 'the percentage helper must cap at 100');
  assert.match(body, /Math\.floor/, 'and must still floor — 100% has to mean truly complete');
  for (const field of ['percent', 'analysedPercent', 'audioEmbeddedPercent', 'vocalAnalyzedPercent']) {
    assert.match(
      body, new RegExp(`const ${field} = pctOf\\(`),
      `${field} must go through the shared capped helper, not its own expression`,
    );
  }
});

test('a stored count is restored on boot, with its original age', async () => {
  // Stand in for "a previous process counted this library three days ago".
  const scannedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  writeFileSync(COUNT_FILE, JSON.stringify({ version: 1, total: 29_412, scannedAt }));

  // A fresh module instance is the closest thing to a controller restart.
  const fresh = await import(`../src/music/library-coverage.js?boot=${Date.now()}`);
  const snap = await fresh.get();
  assert.equal(snap.total, 29_412, 'the count did not survive the restart');
  assert.equal(snap.scannedAt, scannedAt, 'the age stamp must be the ORIGINAL count time');
  assert.equal(snap.scanning, false, 'restoring a stored count must not kick a scan');
  assert.equal(fresh.hasCount(), true);
});

test('a missing or corrupt store reads as "never counted", never throws', async () => {
  for (const bad of [
    null,                                             // file absent
    'not json at all',
    '{}',                                             // no fields
    '{"version":1,"total":"lots","scannedAt":"2026-01-01T00:00:00Z"}',
    '{"version":1,"total":-5,"scannedAt":"2026-01-01T00:00:00Z"}',
    '{"version":1,"total":10,"scannedAt":"the other day"}',
  ]) {
    if (bad == null) rmSync(COUNT_FILE, { force: true });
    else writeFileSync(COUNT_FILE, bad);

    const fresh = await import(`../src/music/library-coverage.js?bad=${Math.random()}`);
    const snap = await fresh.get();
    assert.equal(snap.total, null, `corrupt store accepted: ${bad}`);
    assert.equal(snap.scannedAt, null, `corrupt store accepted: ${bad}`);
    assert.equal(fresh.hasCount(), false);
  }
});

test('the persisted shape carries only the count, never the in-flight flags', async () => {
  const scannedAt = new Date().toISOString();
  writeFileSync(COUNT_FILE, JSON.stringify({ version: 1, total: 7, scannedAt }));
  const stored = JSON.parse(readFileSync(COUNT_FILE, 'utf8'));
  // `scanning`/`scanError` describe THIS process's attempt: a stored
  // `scanning: true` from a killed container would spin forever.
  assert.deepEqual(Object.keys(stored).sort(), ['scannedAt', 'total', 'version']);

  const src = codeOnly(await readFile(SRC, 'utf8'));
  const persist = src.slice(src.indexOf('function persistCount()'));
  const body = persist.slice(0, persist.indexOf('\n}'));
  assert.ok(!/scanning|scanError/.test(body), 'persistCount must not write the in-flight flags');
});

test('an atomic write is used, so a torn file cannot replace a good count', async () => {
  const src = await readFile(SRC, 'utf8');
  assert.ok(
    /renameSync\(/.test(src),
    'the count must be written to a temp file and renamed, like the other state side-files',
  );
});

test('the payload carries scanError, and a clean read reports none', async () => {
  rmSync(COUNT_FILE, { force: true });
  const fresh = await import(`../src/music/library-coverage.js?err=${Math.random()}`);
  const snap = await fresh.get();
  assert.ok('scanError' in snap, 'scanError must ride the payload — the panel renders it');
  assert.equal(snap.scanError, null, 'no attempt yet means no error');
});

test('refresh() records why a scan failed instead of only logging it', async () => {
  const src = codeOnly(await readFile(SRC, 'utf8'));
  const refresh = src.slice(src.indexOf('export function refresh()'));
  const body = refresh.slice(0, refresh.indexOf('\n}'));
  assert.ok(
    /cache\.scanError\s*=/.test(body),
    'a failed count must be recorded on the snapshot, not just console.error-ed',
  );
});

test('a scan that fails leaves the previous count and its age in place', async () => {
  // total/scannedAt are written only on success, so a failed re-count cannot
  // blank a good number over a transient Navidrome blip.
  const src = codeOnly(await readFile(SRC, 'utf8'));
  const scan = src.slice(src.indexOf('async function doScan()'));
  const body = scan.slice(0, scan.indexOf('\n}'));
  const assignIdx = body.indexOf('cache.total = count');
  const iterIdx = body.indexOf('iterateAllSongs');
  assert.ok(assignIdx > iterIdx, 'the total must be assigned only after the walk completes');
  assert.ok(
    !/finally[\s\S]*cache\.(total|scannedAt)\s*=/.test(body),
    'the finally block must not write the count — that would land on the failure path too',
  );
});

test('the count persists to state/library-count.json', async () => {
  const scannedAt = new Date().toISOString();
  writeFileSync(COUNT_FILE, JSON.stringify({ version: 1, total: 3, scannedAt }));
  const fresh = await import(`../src/music/library-coverage.js?path=${Math.random()}`);
  assert.equal((await fresh.get()).total, 3);
  assert.ok(existsSync(COUNT_FILE), 'the documented path is state/library-count.json');
});
