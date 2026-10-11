import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-facet-regression-'));
process.env.STATE_DIR = stateDir;
process.env.ANALYZE_PYTHON = '';
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
let tailCapable: boolean | null = true;
let failAnalysis = false;
const requests: Array<Record<string, unknown>> = [];
const head = [{ startMs: 5000, endMs: 15000 }];
const tail = [{ startMs: 225000, endMs: 239000 }];
let reportedTail = tail;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.startsWith('/health')) {
    res.end(JSON.stringify({ ok: true, engines: ['analyze'], analyze_audio_capable: false,
      analyze_vocal_capable: true, analyze_tail_vocal_capable: tailCapable }));
  } else if (req.url?.startsWith('/analyze')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input: Record<string, unknown> = JSON.parse(body);
      requests.push(input);
      res.end(JSON.stringify(failAnalysis ? { ok: false, error: 'decode failed' } : {
        ok: true, bpm: 120, key: 'Am', intro_ms: 1000, confidence: 0.9,
        loudness_lufs: -10, peak_db: -1, tail_silence_ms: 0, tail_start_ms: 240000,
        outro: { startMs: 220000, ending: 'cold',
          ...(input.vocal !== false && tailCapable === true ? { vocalRanges: reportedTail } : {}) },
        ...(input.vocal !== false ? { vocal_ranges: head } : {}),
      }));
    });
  } else if (req.url?.includes('getLyrics')) {
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', lyricsList: { structuredLyrics: [] } } }));
  } else {
    res.setHeader('Content-Type', 'audio/flac');
    res.end(Buffer.alloc(1024, 1));
  }
});

let db: typeof import('../src/music/library-db.js');
let planner: typeof import('../src/music/acoustics-plan.js');
let analyzer: typeof import('../src/music/analyzer.js');
let runAnalysisPass: typeof import('../src/music/analyze.js').runAnalysisPass;
let checkFacets: typeof import('../src/music/facet-check.js').checkFacets;

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
  process.env.NAVIDROME_URL = process.env.ANALYZE_URL;
  db = await import('../src/music/library-db.js');
  planner = await import('../src/music/acoustics-plan.js');
  analyzer = await import('../src/music/analyzer.js');
  ({ runAnalysisPass } = await import('../src/music/analyze.js'));
  ({ checkFacets } = await import('../src/music/facet-check.js'));
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  await analyzer.isAvailable();
});

after(async () => {
  analyzer?.shutdown();
  if (db?.isOpen()) db.close();
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  rmSync(stateDir, { recursive: true, force: true });
});

function seed(id: string, measuredTail: boolean) {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 240 });
  db.upsertTrackAnalysis(id, { bpm: 120, musicalKey: 'Am', loudnessLufs: -10,
    vocalRanges: head, outro: { startMs: 220000, ending: 'cold', lufs: -10, bpm: 120,
      beats: null, bars: null, ...(measuredTail ? { vocalRanges: tail } : {}) },
    source: 'full' });
}

function plan(id: string, facet: import('../src/music/library-db.js').Facet,
  kind: import('../src/music/acoustics-plan.js').WhereKind = 'needs') {
  return planner.planAcoustics({ ids: [id], facets: [facet], where: { kind },
    state: db.loadFacetState([facet]), capabilities: { clap: false, demucs: true,
      tailVocal: tailCapable } });
}

async function cli(id: string, where = 'needs') {
  const file = join(stateDir, 'ids.txt');
  writeFileSync(file, `# explicit scope\n${id}\nunknown-id\n`);
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/music/analyze-library.ts',
      '--facets', 'vocal', '--where', where, '--ids-file', file, '--limit', '1', '--dry-run'], {
      cwd: new URL('..', import.meta.url), env: process.env,
    });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

test('a tail-only plan preserves measured tail vocals and their older version', async () => {
  seed('tail-redo', true);
  db.requireDb().prepare("UPDATE track_facet_status SET version = 0 WHERE track_id = 'tail-redo' AND facet = 'vocal'").run();
  const stats = await runAnalysisPass({ plan: plan('tail-redo', 'tail', 'all') });
  assert.equal(stats.analyzed, 1);
  assert.equal(requests.at(-1)?.vocal, false);
  assert.deepEqual(db.getTrack('tail-redo')?.outro?.vocalRanges, tail);
  assert.deepEqual(db.getTrack('tail-redo')?.vocalRanges, head);
  assert.equal(db.loadFacetState(['vocal']).get('tail-redo')?.get('vocal')?.version, 0);
  assert.equal(checkFacets().driftCount, 0);
});

test('a requested vocal run replaces preserved ranges and settles the version', async () => {
  seed('vocal-redo', false);
  await runAnalysisPass({ plan: plan('vocal-redo', 'vocal') });
  assert.deepEqual(db.getTrack('vocal-redo')?.outro?.vocalRanges, tail);
  assert.equal(db.loadFacetState(['vocal']).get('vocal-redo')?.get('vocal')?.version, db.FACET_VERSIONS.vocal);
  assert.equal(plan('vocal-redo', 'vocal').items.length, 0);
});

test('a measured instrumental tail survives an unrelated run and can replace older vocals', async () => {
  seed('instrumental-tail', true);
  reportedTail = [];
  try {
    await runAnalysisPass({ plan: plan('instrumental-tail', 'vocal', 'all') });
    assert.deepEqual(db.getTrack('instrumental-tail')?.outro?.vocalRanges, []);
    await runAnalysisPass({ plan: plan('instrumental-tail', 'tail', 'all') });
    assert.deepEqual(db.getTrack('instrumental-tail')?.outro?.vocalRanges, []);
  } finally { reportedTail = tail; }
});

test('head-only and outdated vocal work obey the retry ceiling, with deliberate retries', async () => {
  for (const [id, complete] of [['head-only', false], ['outdated', true]] as const) {
    seed(id, complete);
    if (complete) db.requireDb().prepare("UPDATE track_facet_status SET version = 0 WHERE track_id = ? AND facet = 'vocal'").run(id);
    failAnalysis = true;
    try {
      for (let attempt = 0; attempt < db.MAX_ANALYSIS_FAILURES; attempt++) {
        const p = plan(id, 'vocal');
        assert.equal(p.items.length, 1);
        assert.equal((await runAnalysisPass({ plan: p })).failed, 1);
      }
    } finally { failAnalysis = false; }
    const cell = db.loadFacetState(['vocal']).get(id)?.get('vocal');
    assert.equal(cell?.status, 'ok', 'kept measurements are still ok');
    assert.equal(cell?.version, 0, 'a failure cannot promote the measurement');
    assert.equal(cell?.attempts, db.MAX_ANALYSIS_FAILURES);
    assert.equal(db.facetNeedsIds('vocal').includes(id), false);
    assert.equal(plan(id, 'vocal').items.length, 0);
    assert.equal(plan(id, 'vocal', 'outdated').items.length, 0);
    assert.equal(plan(id, 'vocal', 'failed').items.length, 1);
    assert.equal(plan(id, 'vocal', 'all').items.length, 1);
  }
  const scopes = checkFacets().scopes;
  assert.ok(!scopes.find(s => s.facet === 'vocal')?.onlyFacet.includes('head-only'));
  assert.equal(db.facetCounts().find(c => c.facet === 'vocal')?.needs, db.facetNeedsIds('vocal').length);
  db.clearAnalysisFailures('head-only');
  assert.equal(plan('head-only', 'vocal').items.length, 1);
  await runAnalysisPass({ plan: plan('outdated', 'vocal', 'failed') });
  const retried = db.loadFacetState(['vocal']).get('outdated')?.get('vocal');
  assert.equal(retried?.attempts, 0);
  assert.equal(retried?.version, db.FACET_VERSIONS.vocal);
  assert.equal(plan('outdated', 'vocal').items.length, 0);
});

test('reopening upgrades retry bookkeeping without promoting kept versions', async () => {
  seed('upgrade', false);
  for (let i = 0; i < 3; i++) db.recordAnalysisFailure('upgrade', 'decode failed');
  db.requireDb().prepare("UPDATE track_facet_status SET attempts = 0 WHERE track_id = 'upgrade' AND facet = 'vocal'").run();
  db.requireDb().prepare('UPDATE track_facet_meta SET stamp = ?').run(JSON.stringify({ analysis: db.ANALYSIS_VERSION, facets: db.FACET_VERSIONS }));
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(db.loadFacetState(['vocal']).get('upgrade')?.get('vocal')?.attempts, 3);
  assert.equal(db.loadFacetState(['vocal']).get('upgrade')?.get('vocal')?.version, 0);
  assert.equal(plan('upgrade', 'vocal').items.length, 0);
});

test('reopening repairs a legacy null head-only reason while retaining tail provenance', async () => {
  seed('upgrade-null-reason', false);
  db.requireDb().prepare("UPDATE track_facet_status SET reason = NULL WHERE track_id = 'upgrade-null-reason' AND facet = 'vocal'").run();
  const before = db.loadFacetState(['vocal']).get('upgrade-null-reason')?.get('vocal');
  assert.equal(before?.version, 0);
  assert.equal(before?.reason, null);
  db.upsertTrackMeta('upgrade-capped', { title: 'capped', artist: 'A', duration: 240 });
  db.upsertTrackAnalysis('upgrade-capped', { bpm: 120, source: 'capped' });
  db.requireDb().prepare("UPDATE track_facet_status SET version = 0 WHERE track_id = 'upgrade-capped' AND facet = 'tail'").run();
  db.requireDb().prepare('UPDATE track_facet_meta SET stamp = ?').run(JSON.stringify({ analysis: db.ANALYSIS_VERSION, facets: db.FACET_VERSIONS }));
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  const vocal = db.loadFacetState(['vocal']).get('upgrade-null-reason')?.get('vocal');
  assert.equal(vocal?.version, 0, 'repair must not promote a partial measurement');
  assert.equal(vocal?.reason, 'head-only');
  const capped = db.loadFacetState(['tail']).get('upgrade-capped')?.get('tail');
  assert.equal(capped?.reason, 'capped-download');
  assert.equal(capped?.version, 0);
  try {
    for (const capability of [false, null]) {
      tailCapable = capability;
      assert.equal(plan('upgrade-null-reason', 'vocal').items.length, 0);
      const result = await cli('upgrade-null-reason');
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /0 of 1 tracks in scope/);
      assert.match(result.output, /no-tail-vocal 1/);
    }
  } finally { tailCapable = true; }
});

test('older sidecars skip head-only tail work but can still measure missing head vocals', async () => {
  seed('old-sidecar', false);
  db.upsertTrackMeta('missing-head', { title: 'missing-head', artist: 'A', duration: 240 });
  for (const capability of [false, null]) {
    tailCapable = capability;
    analyzer._resetBackendCacheForTests();
    await analyzer.isAvailable();
    const p = plan('old-sidecar', 'vocal');
    assert.equal(p.items.length, 0);
    assert.equal(p.byFacet[0].skipped['no-tail-vocal'], 1);
    assert.equal(plan('missing-head', 'vocal').items.length, 1);
  }
  tailCapable = true;
  analyzer._resetBackendCacheForTests();
  await analyzer.isAvailable();
  await runAnalysisPass({ plan: plan('old-sidecar', 'vocal') });
  assert.equal(plan('old-sidecar', 'vocal').items.length, 0);
});

test('CLI planning gates tail support and exhausted retries without taking the lock', async () => {
  seed('cli-head-only', false);
  const beforeRequests = requests.length;
  for (const capability of [false, null, true]) {
    tailCapable = capability;
    const result = await cli('cli-head-only');
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, capability === true ? /1 of 1 tracks in scope/ : /0 of 1 tracks in scope/);
    if (capability !== true) assert.match(result.output, /no-tail-vocal 1/);
  }
  for (let i = 0; i < 3; i++) db.recordAnalysisFailure('cli-head-only', 'decode failed');
  for (const where of ['needs', 'outdated', 'failed', 'all']) {
    const result = await cli('cli-head-only', where);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, where === 'failed' || where === 'all' ? /1 of 1 tracks in scope/ : /0 of 1 tracks in scope/);
  }
  assert.equal(requests.length, beforeRequests);
  assert.equal(existsSync(join(stateDir, 'tagger.pid')), false);
});

test('clearing analysis resets failure history on kept vocal and stems measurements', () => {
  seed('clear-kept', true);
  db.upsertTrackAnalysis('clear-kept', { stemsAttempted: true });
  for (let i = 0; i < 3; i++) db.recordAnalysisFailure('clear-kept', 'decode failed');
  db.clearAnalysis({ keepVocal: true, clearStems: false });
  const kept = db.loadFacetState(['vocal', 'stems']).get('clear-kept');
  assert.equal(kept?.get('vocal')?.attempts, 0);
  assert.equal(kept?.get('stems')?.attempts, 0);
  assert.equal(checkFacets().driftCount, 0);
});
