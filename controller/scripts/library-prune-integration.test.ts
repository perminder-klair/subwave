import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTempDir } from './test-utils/temp-dir.js';

type Walk = 'failed-album' | 'malformed-album' | 'complete' | 'empty';

const state = createTempDir(join(tmpdir(), 'subwave-prune-integration-'));
const controller = fileURLToPath(new URL('../', import.meta.url));
const ids = ['keep-1', 'keep-2', 'missing-1'];
let walk: Walk = 'complete';
let scanning = false;
const requests: string[] = [];
const song = (id: string) => ({ id, title: `Fresh ${id}`, artist: 'Fixture', duration: 200 });

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const endpoint = url.pathname.split('/').at(-1) || '';
  requests.push(endpoint);
  let sub: Record<string, unknown> = { status: 'ok' };
  switch (endpoint) {
    case 'getScanStatus': sub.scanStatus = { scanning }; break;
    case 'getAlbumList2':
      sub.albumList2 = { album: walk === 'empty' ? [] : [{ id: 'a' }, { id: 'b' }] };
      break;
    case 'getAlbum':
      if (url.searchParams.get('id') === 'a') {
        sub.album = { id: 'a', song: [song('keep-1')] };
      } else if (walk === 'failed-album') {
        sub = { status: 'failed', error: { code: 0, message: 'Temporary album failure' } };
      } else {
        sub.album = walk === 'malformed-album' ? { id: 'b' } : { id: 'b', song: [song('keep-2')] };
      }
      break;
    default:
      res.writeHead(404);
      res.end();
      return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ 'subsonic-response': sub }));
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
process.env.STATE_DIR = state;
process.env.NAVIDROME_URL = origin;
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASS = 'fixture';

// The real CLI runs without DSP or external services; its no-backend result
// proves the analysis pass was reached after the walk.
const preload = join(state, 'network.mjs');
writeFileSync(preload, `
const request = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== ${JSON.stringify(origin)}) return Promise.reject(new Error('external network disabled'));
  return request(input, init);
};
`);
const db = await import('../src/music/library-db.js');
const rotation = await import('../src/music/id-rotation.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

function vectors(id: string) {
  return {
    text: db.requireDb().prepare('SELECT embedding FROM track_vectors WHERE id = ?').get(id),
    audio: db.requireDb().prepare('SELECT embedding FROM track_audio_vectors WHERE id = ?').get(id),
  };
}

function assertPreserved(id: string, before: ReturnType<typeof vectors>) {
  const track = db.getTrack(id);
  assert.ok(track, `row ${id} must survive`);
  assert.deepEqual(track.moods, ['warm']);
  assert.equal(track.energy, 'medium');
  assert.equal(track.source, 'manual');
  assert.deepEqual(vectors(id), before, `both vector indexes for ${id} must survive`);
}

test.beforeEach(() => {
  db.pruneMissingTracks(new Set());
  requests.length = 0;
  walk = 'complete';
  scanning = false;
  for (const id of ids) {
    db.upsertTrackMeta(id, { title: `Old ${id}`, artist: 'Fixture', duration: 200 });
    db.upsertTrackTags(id, { moods: ['warm'], source: 'manual', energy: 'medium', confidence: 1 });
    db.upsertTrackVector(id, [1, 2, 3, 4, 5, 6, 7, 8], null);
    db.upsertTrackAudioVector(id, new Float32Array(512).fill(0.25));
  }
});

test.after(async () => {
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(state, { recursive: true, force: true });
});

async function runCli(script: string, args: string[]): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, script, ...args], {
    cwd: controller,
    env: { ...process.env, ANALYZE_URL: 'http://127.0.0.1:1', ANALYZE_PYTHON: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, output);
  return output;
}

for (const incomplete of ['failed-album', 'malformed-album'] as const) {
  test(`analyzer --walk preserves derived data and reaches analysis after ${incomplete}`, async () => {
    walk = incomplete;
    const before = new Map(ids.map(id => [id, vectors(id)]));
    const output = await runCli('src/music/analyze-library.ts', ['--walk']);

    assert.equal(db.trackCount(), 3, output);
    for (const [id, vector] of before) assertPreserved(id, vector);
    assert.equal(db.getTrack('keep-1')?.title, 'Fresh keep-1');
    assert.equal(db.getTrack('keep-2')?.title, 'Old keep-2');
    assert.match(output, /Library walk incomplete/);
    assert.match(output, /\[event\] \{"kind":"warning"/);
    assert.match(output, /no analysis backend/);
    assert.match(output, /\[analyze\] stats:/);
    assert.deepEqual(requests, ['getAlbumList2', 'getAlbum', 'getAlbum']);
  });
}

test('a complete analyzer --walk permits ordinary deletion and reaches analysis', async () => {
  const before = vectors('keep-1');
  const output = await runCli('src/music/analyze-library.ts', ['--walk']);

  assert.equal(db.trackCount(), 2, output);
  assert.equal(db.getTrack('missing-1'), null);
  assert.deepEqual(vectors('missing-1'), { text: undefined, audio: undefined });
  assertPreserved('keep-1', before);
  assert.equal(db.getTrack('keep-1')?.title, 'Fresh keep-1');
  assert.equal(db.getTrack('keep-2')?.title, 'Fresh keep-2');
  assert.match(output, /no analysis backend/);
  assert.match(output, /\[analyze\] stats:/);
});

for (const confirmMassPrune of [false, true]) {
  test(`HTTP scan status holds pruning with confirmation ${confirmMassPrune}, then permits it when false`, async () => {
    const before = vectors('missing-1');
    scanning = true;
    const live = new Set(['keep-1', 'keep-2']);
    const held = await rotation.adoptAndPrune(live, { confirmMassPrune });

    assert.equal(held.pruned, 0);
    assert.equal(held.held?.reason, 'scanning');
    assert.equal(db.trackCount(), 3);
    assertPreserved('missing-1', before);
    assert.deepEqual(requests, ['getScanStatus']);

    scanning = false;
    const pruned = await rotation.adoptAndPrune(live, { confirmMassPrune });
    assert.equal(pruned.pruned, 1);
    assert.equal(pruned.held, undefined);
    assert.equal(db.trackCount(), 2);
    assert.equal(db.getTrack('missing-1'), null);
    assert.deepEqual(vectors('missing-1'), { text: undefined, audio: undefined });
    assert.deepEqual(requests, ['getScanStatus', 'getScanStatus']);
  });
}

test('a complete empty walk keeps all rows and skips confirmation in analyzer and reconcile', async () => {
  walk = 'empty';
  for (let i = ids.length; i < 800; i++) {
    db.upsertTrackMeta(`empty-${i}`, { title: 'Empty fixture', artist: 'Fixture' });
  }
  const before = vectors('missing-1');
  for (const [script, args] of [
    ['src/music/analyze-library.ts', ['--walk', '--confirm-prune']],
    ['src/music/tag-library.ts', ['--reconcile-only', '--confirm-prune']],
  ] as const) {
    requests.length = 0;
    await runCli(script, [...args]);
    assert.equal(db.trackCount(), 800);
    assertPreserved('missing-1', before);
    assert.deepEqual(requests, ['getAlbumList2'], 'empty walks must not enter adoptAndPrune');
  }
});
