// The stem cache walk measures track dirs SCAN_CONCURRENCY at a time
// (music/stem-cache.ts scanDirs). The totals must be exactly those of the old
// one-at-a-time walk: every dir counted once, stray files at the root ignored,
// every file's bytes summed.
// Run: `tsx scripts/stem-scan-parallel.test.ts` (auto-discovered by npm test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-stem-scan-'));
process.env.STATE_DIR = stateDir;
const stemCache = await import('../src/music/stem-cache.js');

test('a walk wider than the fan-out counts every dir and every byte once', async () => {
  const n = stemCache.SCAN_CONCURRENCY * 7 + 3;
  let expected = 0;
  for (let i = 0; i < n; i++) {
    const dir = stemCache.dirFor(`t${i}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 3; f++) {
      const size = 100 + i * 3 + f;
      writeFileSync(join(dir, `head-${f}.flac`), Buffer.alloc(size));
      expected += size;
    }
  }
  writeFileSync(join(stemCache.stemsRoot(), 'stray.txt'), 'not a track dir');
  const u = await stemCache.usage();
  assert.equal(u.dirs, n);
  assert.equal(u.bytes, expected);
});

test.after(() => rmSync(stateDir, { recursive: true, force: true }));
