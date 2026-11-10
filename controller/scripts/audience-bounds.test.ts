// broadcast/audience.ts keys its day maps by beacon text, and POST /beacon is
// public. Pins two things: a key that names an Object.prototype member counts
// like any other, and what one day can hold is bounded where it is written.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { beforeEach } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-audience-bounds-'));
const audience = await import('../src/broadcast/audience.js');

beforeEach(() => audience.resetAudience());

let n = 0;
const nextIp = () => `10.3.${(n >> 8) & 255}.${n++ & 255}`;

test('prototype-named keys count as numbers', () => {
  for (let i = 0; i < 3; i++) {
    audience.record({ ip: nextIp(), utmSource: 'constructor', path: 'toString' });
    audience.record({ ip: nextIp(), referrer: 'http://constructor/', path: '__proto__' });
  }
  const s = audience.summary();
  const source = s.referrers.find(r => r.source === 'constructor');
  assert.equal(source?.count, 6, 'utmSource and referrer host both fold to the same numeric count');
  assert.equal(s.paths.find(p => p.path === 'toString')?.count, 3);
  assert.equal(s.paths.find(p => p.path === '__proto__')?.count, 3);
  for (const row of [...s.referrers, ...s.paths]) assert.equal(typeof row.count, 'number');
});

test('a day folds its long tail into one key instead of growing without bound', () => {
  for (let i = 0; i < 2_000; i++) audience.record({ ip: nextIp(), path: `/p/${i}` });
  const s = audience.summary();
  assert.equal(s.sessions, 2_000, 'every session still counts');
  const other = s.paths.find(p => p.path === '(other)');
  assert.ok(other && other.count >= 1_500, `the overflow lands in one bucket (${other?.count})`);
});

test('a day stops admitting new sessions past its dedupe ceiling', () => {
  for (let i = 0; i < 50_100; i++) audience.record({ ip: `172.16.${i >> 8}.${i & 255}x` });
  assert.equal(audience.summary().sessions, 50_000);
});
