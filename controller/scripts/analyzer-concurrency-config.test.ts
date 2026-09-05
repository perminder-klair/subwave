// Verifies the public config.analyzer.concurrency contract in fresh processes,
// because config.ts reads environment variables once at module load.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');

function readConcurrency(value: string | undefined): number {
  const env = { ...process.env };
  delete env.ANALYZE_CONCURRENCY;
  if (value !== undefined) env.ANALYZE_CONCURRENCY = value;
  const script = "import('./src/config.js').then(({ config }) => console.log(config.analyzer.concurrency))";
  const output = execFileSync(tsx, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Number(output.trim());
}

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
