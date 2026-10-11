import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { runGenerationJob } from './generate';
import type { PlaylistGenerationResult } from '@/lib/schemas.generated';

const result = {
  tracks: [{
    id: 'track-1', title: 'Track', artist: 'Artist', album: 'Album',
    durationSec: 180, year: null, genre: null, energy: null,
    moods: [], instrumental: null,
  }],
  degraded: false, reasons: [], poolSize: 1, usedFallback: false,
} satisfies PlaylistGenerationResult;

test('a pre-jobs controller still returns a validated synchronous playlist', async () => {
  const paths: string[] = [];
  const generated = await runGenerationJob(async (path) => {
    paths.push(path);
    return paths.length === 1
      ? new Response(null, { status: 404 })
      : Response.json(result);
  }, { prompt: 'ambient' });
  assert.deepEqual(generated, result);
  assert.deepEqual(paths, ['/playlists/generate/jobs', '/playlists/generate']);
});

test('successful HTTP with malformed playlist data is refused', async () => {
  await assert.rejects(runGenerationJob(async (path) => path.endsWith('/jobs')
    ? new Response(null, { status: 404 })
    : Response.json({ ...result, tracks: [{ id: 'track-1' }] }), {}), /invalid generation response/);
});

test('an invalid job id never reaches the polling endpoint', async () => {
  let requests = 0;
  await assert.rejects(runGenerationJob(async () => {
    requests++;
    return Response.json({ jobId: 42 });
  }, {}), /invalid generation response/);
  assert.equal(requests, 1);
});

test('proxy HTML and malformed JSON produce readable errors', async () => {
  await assert.rejects(runGenerationJob(async () => new Response('<html>Error</html>', {
    status: 502, headers: { 'Content-Type': 'text/html' },
  }), {}), /unexpected response \(HTTP 502\)/);
  await assert.rejects(runGenerationJob(async () => new Response('{', {
    headers: { 'Content-Type': 'application/json' },
  }), {}), /malformed JSON/);
});

test('controller start refusals preserve their error message', async () => {
  await assert.rejects(runGenerationJob(async () => Response.json({ error: 'too many generations' }, {
    status: 429,
  }), {}), /too many generations/);
});

test('a running job completes with its validated result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const paths: string[] = [];
  const generated = runGenerationJob(async (path) => {
    paths.push(path);
    if (paths.length === 1) return Response.json({ jobId: 'job-1' });
    return Response.json(paths.length === 2 ? { status: 'running' } : { status: 'done', result });
  }, {});
  await setImmediate();
  t.mock.timers.tick(2000);
  await setImmediate();
  t.mock.timers.tick(2000);
  assert.deepEqual(await generated, result);
  assert.equal(paths[1], '/playlists/generate/jobs/job-1');
});

test('an unknown poll status cannot masquerade as an empty successful playlist', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const generated = runGenerationJob(async (path) => Response.json(path.endsWith('/jobs')
    ? { jobId: 'job-1' } : { status: 'unexpected' }), {});
  const rejected = assert.rejects(generated, /invalid generation response/);
  for (let attempt = 0; attempt < 3; attempt++) {
    await setImmediate();
    t.mock.timers.tick(2000);
  }
  await rejected;
});
