// Verifies public analyzer URL and concurrency config in fresh processes, because
// config.ts reads environment variables once at module load.
//
// The bug this pins (#1636): the sidecar base URL defaulted to '', so a
// controller whose compose file predated the ANALYZE_URL line got an EMPTY
// candidate list and reported "no analysis engine running" with a healthy
// analyzer container one DNS name away. The default is now the compose service
// name, exactly as config.navidrome.url has always resolved Navidrome.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');

function readAnalyzer(name: 'ANALYZE_URL' | 'ANALYZE_CONCURRENCY', value: string | undefined): { urls: string[]; concurrency: number } {
  const env = { ...process.env };
  delete env[name];
  if (value !== undefined) env[name] = value;
  // JSON strings avoid FORCE_COLOR escape codes on bare console numbers.
  const script = "import('./src/config.js').then(({ config }) => console.log(JSON.stringify(config.analyzer)))";
  const output = execFileSync(tsx, ['-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.trim().split('\n').pop() || '{}');
}

const readConcurrency = (value: string | undefined) => readAnalyzer('ANALYZE_CONCURRENCY', value).concurrency;
const readUrls = (value: string | undefined) => readAnalyzer('ANALYZE_URL', value).urls;

test('ANALYZE_CONCURRENCY defaults to one and accepts the supported range', () => {
  assert.equal(readConcurrency(undefined), 1);
  assert.equal(readConcurrency(''), 1);
  assert.equal(readConcurrency('4'), 4);
  assert.equal(readConcurrency('8'), 8);
});

test('ANALYZE_CONCURRENCY malformed and out-of-range values fall back without throwing', () => {
  assert.equal(readConcurrency('many'), 1);
  assert.equal(readConcurrency('0'), 1);
  assert.equal(readConcurrency('9'), 1);
});

test('an unset ANALYZE_URL still points at the compose sidecar', () => {
  assert.deepEqual(readUrls(undefined), ['http://analyzer:8080']);
});

test('an EMPTY ANALYZE_URL is absent, not a disabled sidecar', () => {
  // `ANALYZE_URL=` is an ordinary compose line; the documented way to run with
  // no local analyzer is ANALYZER_REPLICAS=0, which removes the container and
  // leaves this candidate as a plain probe miss.
  assert.deepEqual(readUrls(''), ['http://analyzer:8080']);
});

test("an explicit URL wins — a remote analyzer is still the operator's call", () => {
  assert.deepEqual(readUrls('http://192.168.1.101:8080'), ['http://192.168.1.101:8080']);
});

test('a malformed URL falls back to the sidecar rather than emptying the list', () => {
  assert.deepEqual(readUrls('not a url'), ['http://analyzer:8080']);
});
