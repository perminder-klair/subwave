import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';

interface SeenRequest {
  path?: string;
  url?: string;
  embed?: boolean;
  vocal?: boolean;
  complete?: boolean;
  stems_dir?: string;
  embedding_only?: boolean;
}

const seen: SeenRequest[] = [];
const sidecar = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, engines: ['analyze'] }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/analyze') {
    res.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SeenRequest;
  seen.push(body);

  if (body.path === '/remote/missing.audio') {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      detail: {
        code: 'path_unavailable',
        message: 'analyzer cannot read /remote/missing.audio',
      },
    }));
    return;
  }
  if (body.path === '/remote/broken.audio') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'decode failed' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    bpm: 123,
    key: '8A',
    intro_ms: 900,
    confidence: 0.8,
  }));
});

let analyzer: typeof import('../src/music/analyzer.js');

before(async () => {
  await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  const address = sidecar.address();
  assert.ok(address && typeof address === 'object');
  process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
  analyzer = await import('../src/music/analyzer.js');
});

after(async () => {
  analyzer?.shutdown();
  await new Promise<void>((resolve, reject) => sidecar.close((err) => err ? reject(err) : resolve()));
});

test('a sidecar path-unavailable response retries once by URL without shared-path options', async () => {
  const result = await analyzer.analyzePathWithUrlFallback(
    'remote-track',
    '/remote/missing.audio',
    {
      embed: true,
      vocal: true,
      complete: false,
      stems_dir: '/var/sub-wave/stems/remote-track',
      embedding_only: true,
    },
  );

  assert.equal(result.bpm, 123);
  const requests = seen.filter((body) => body.path === '/remote/missing.audio' || body.url?.includes('id=remote-track'));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    path: '/remote/missing.audio',
    embed: true,
    vocal: true,
    complete: false,
    stems_dir: '/var/sub-wave/stems/remote-track',
    embedding_only: true,
  });
  assert.equal(typeof requests[1].url, 'string');
  assert.equal(requests[1].path, undefined);
  assert.equal(requests[1].complete, undefined, 'the URL downloader must determine completeness itself');
  assert.equal(requests[1].stems_dir, undefined, 'a remote analyzer cannot write controller-local stems');
  assert.equal(requests[1].embed, true);
  assert.equal(requests[1].vocal, true);
  assert.equal(requests[1].embedding_only, true);
});

test('an ordinary sidecar analysis failure is not retried by URL', async () => {
  const beforeCount = seen.length;
  await assert.rejects(
    analyzer.analyzePathWithUrlFallback('broken-track', '/remote/broken.audio'),
    /decode failed/,
  );
  assert.equal(seen.length - beforeCount, 1);
  assert.equal(seen.at(-1)?.path, '/remote/broken.audio');
});

test('a readable shared path keeps the one-request fast path', async () => {
  const beforeCount = seen.length;
  const result = await analyzer.analyzePathWithUrlFallback('shared-track', '/shared/track.audio');
  assert.equal(result.musicalKey, '8A');
  assert.equal(seen.length - beforeCount, 1);
  assert.equal(seen.at(-1)?.path, '/shared/track.audio');
});
