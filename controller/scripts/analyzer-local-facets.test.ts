import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('a fresh local worker uses the facet protocol for its first planned pass', async t => {
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  if (python.error || python.status !== 0) { t.skip('python3 is unavailable'); return; }
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-local-facets-'));
  const worker = join(stateDir, 'worker.py');
  const requestLog = join(stateDir, 'requests.jsonl');
  writeFileSync(worker, `import json, sys
print(json.dumps({'ready': True, 'facets_capable': True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    with open(${JSON.stringify(requestLog)}, 'a') as log:
        log.write(json.dumps(req) + '\\n')
    if 'facets' in req:
        data = {'facets': {'tail': {'status': 'ok', 'data': {
            'outro': {'startMs': 220000, 'ending': 'cold'}}}},
            'source': {'kind': 'path', 'complete': True}}
    else:
        data = {'bpm': 999, 'key': 'Am'}
    print(json.dumps({'id': req['id'], 'ok': True, **data}), flush=True)
`);
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, engines: [] }));
    } else {
      res.setHeader('Content-Type', 'audio/flac');
      res.end(Buffer.alloc(1024, 1));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.STATE_DIR = stateDir;
  process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
  process.env.NAVIDROME_URL = process.env.ANALYZE_URL;
  process.env.NAVIDROME_USER = 'u';
  process.env.NAVIDROME_PASS = 'p';
  process.env.ANALYZE_PYTHON = python.stdout.trim();
  process.env.ANALYZE_WORKER = worker;
  const db = await import('../src/music/library-db.js');
  const planner = await import('../src/music/acoustics-plan.js');
  const analyzer = await import('../src/music/analyzer.js');
  const { runAnalysisPass } = await import('../src/music/analyze.js');
  try {
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    db.upsertTrackMeta('first', { title: 'first', duration: 240 });
    db.upsertTrackAnalysis('first', { bpm: 100, musicalKey: 'C', loudnessLufs: -9 });
    const plan = planner.planAcoustics({ ids: ['first'], facets: ['tail'], where: { kind: 'all' },
      state: db.loadFacetState(['tail']), capabilities: { clap: false, demucs: false, tailVocal: false } });
    const stats = await runAnalysisPass({ plan });
    assert.equal(stats.analyzed, 1);
    const requests = readFileSync(requestLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].facets, ['tail']);
    assert.equal(db.getTrack('first')?.bpm, 100);
    assert.equal(db.getTrack('first')?.musicalKey, 'C');
    assert.equal(db.getTrack('first')?.loudnessLufs, -9);
  } finally {
    analyzer.shutdown();
    if (db.isOpen()) db.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
