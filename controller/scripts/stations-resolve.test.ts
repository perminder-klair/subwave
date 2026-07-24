// Boot-time pointer resolution — the function config.ts calls at module load.
// Run: npx tsx scripts/stations-resolve.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeStationId, resolveActiveStationDir } from '../src/stations/resolve.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-stations-'));
try {
  // no stations/ dir → single-station mode, resolve to root
  assert.equal(resolveActiveStationDir(root), root);
  assert.equal(activeStationId(root), null);

  // valid pointer + existing dir → station dir
  mkdirSync(join(root, 'stations', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"alpha"}');
  assert.equal(activeStationId(root), 'alpha');
  assert.equal(resolveActiveStationDir(root), join(root, 'stations', 'alpha'));

  // pointer at a missing dir → fall back to root (never boot into a void)
  writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"ghost"}');
  assert.equal(activeStationId(root), null);
  assert.equal(resolveActiveStationDir(root), root);

  // malformed pointer → root
  writeFileSync(join(root, 'stations', 'active.json'), 'nope');
  assert.equal(resolveActiveStationDir(root), root);

  // traversal attempt in the pointer → root
  writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"../../etc"}');
  assert.equal(resolveActiveStationDir(root), root);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('stations-resolve.test: OK');
