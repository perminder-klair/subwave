// Verifies the public config.analyzer.urls contract in fresh processes, because
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

function readUrls(value: string | undefined): string[] {
  const env = { ...process.env };
  delete env.ANALYZE_URL;
  if (value !== undefined) env.ANALYZE_URL = value;
  const script = "import('./src/config.js').then(({ config }) => console.log(JSON.stringify(config.analyzer.urls)))";
  const output = execFileSync(tsx, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.trim().split('\n').pop() || '[]') as string[];
}

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
