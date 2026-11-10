// The facet request's deadline on the LOCAL worker (ANALYZE_PYTHON), the path
// the AIO image runs. analyzeFacets takes its own `timeoutMs` (a pick-time
// separation passes 300 s, broadcast/pick-stems-policy.ts requestDeadlineMs)
// and must thread it through facetRequest into localRequestRaw; omitted, the
// pass's ANALYZE_REQUEST_TIMEOUT_MS still applies. The sidecar half is pinned
// by scripts/pick-stems.test.ts ("the request outlives the pass's deadline").
//
// The worker is a stand-in speaking the stdio line protocol, run by this very
// node binary: ANALYZE_PYTHON only names the interpreter the controller spawns.
//
// Run: `npm test -- analyzer-facet-deadline`.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-facet-deadline-'));
const worker = join(stateDir, 'worker.mjs');
const WORK_MS = 600;
// Single-flight, like the real worker: one request at a time, each WORK_MS.
writeFileSync(worker, `
import { createInterface } from 'node:readline';
process.stdout.write(JSON.stringify({ ready: true, facets_capable: true }) + '\\n');
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  chain = chain.then(() => new Promise((resolve) => setTimeout(() => {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true,
      facets: { stems: { status: 'ok', data: { stems_cached: false } } },
      source: { kind: 'path', duration_s: 200, complete: true } }) + '\\n');
    resolve();
  }, ${WORK_MS})));
});
`);

process.env.STATE_DIR = stateDir;
process.env.ANALYZE_URL = 'http://127.0.0.1:9'; // no sidecar answers: the local worker is the backend
process.env.ANALYZE_PYTHON = process.execPath;
process.env.ANALYZE_WORKER = worker;
process.env.ANALYZE_REQUEST_TIMEOUT_MS = '200'; // the pass's deadline, under WORK_MS
process.env.NAVIDROME_URL = 'http://127.0.0.1:9';
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';

const analyzer = await import('../src/music/analyzer.js');

after(async () => {
  analyzer.shutdown();
  await removeTempDir(stateDir);
});

test('a longer facet deadline reaches the local worker; omitted, the pass\'s applies', async () => {
  assert.equal(await analyzer.facetsAvailable(), true);
  assert.equal(analyzer.backendLabel(), 'local');

  // Past the pass's 200 ms, inside its own 5 s.
  const t0 = Date.now();
  const res = await analyzer.analyzeFacets('long', { facets: ['stems'], timeoutMs: 5000 });
  assert.equal(res.facets.stems?.status, 'ok');
  assert.ok(Date.now() - t0 >= WORK_MS - 50, `answered after ${Date.now() - t0} ms`);

  // The pass's own request on the same worker keeps ANALYZE_REQUEST_TIMEOUT_MS.
  const t1 = Date.now();
  await assert.rejects(
    analyzer.analyzeFacets('pass', { facets: ['stems'] }),
    (err: unknown) => analyzer.isTimeoutError(err),
  );
  assert.ok(Date.now() - t1 < WORK_MS, `rejected after ${Date.now() - t1} ms, at the pass's deadline`);
  // Let the worker finish the abandoned request before shutdown.
  await new Promise(r => setTimeout(r, WORK_MS));
});

test('a window request keeps a caller\'s SHORTER deadline; only a whole-file one is floored', async () => {
  // Shorter than the pass's 200 ms: honoured as given.
  const t0 = Date.now();
  await assert.rejects(
    analyzer.analyzeFacets('short', { facets: ['stems'], timeoutMs: 50 }),
    (err: unknown) => analyzer.isTimeoutError(err),
  );
  assert.ok(Date.now() - t0 < 180, `rejected after ${Date.now() - t0} ms, before the pass's 200 ms`);
  await new Promise(r => setTimeout(r, WORK_MS));
  // A whole-file request reads the whole file: the same short deadline
  // cannot cut it under ANALYZE_WHOLE_FILE_TIMEOUT_MS, so it is answered.
  const t1 = Date.now();
  const res = await analyzer.analyzeFacets('whole', { facets: ['edges'], timeoutMs: 50 });
  assert.equal(res.facets.stems?.status, 'ok', 'the stand-in answers every request alike');
  assert.ok(Date.now() - t1 >= WORK_MS - 50, `answered after ${Date.now() - t1} ms`);
});
