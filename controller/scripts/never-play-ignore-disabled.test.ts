// Unit test for music/never-play-ignore.ts's disabled posture — no
// NEVER_PLAY_LIBRARY_PATH set. Kept as its own file (rather than a case
// inside scripts/never-play-ignore.test.ts) because ROOT is resolved once at
// module load from config.neverPlay.libraryPath, so a different env value
// needs a fresh process — exactly what run-tests.ts's "each test file is its
// own subprocess" gives every file for free. Mirrors the plain-script shape
// of scripts/never-play-ignore.test.ts for consistency.
//
// Run: `tsx scripts/never-play-ignore-disabled.test.ts` or via `npm test`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'never-play-disabled-state-'));
process.env.STATE_DIR = stateDir;
// Deliberately NOT set — the default, safe posture most installs run with.
delete process.env.NEVER_PLAY_LIBRARY_PATH;

const npi = await import('../src/music/never-play-ignore.js');

try {
  assert.equal(npi.isEnabled(), false);
  assert.equal(npi.libraryRoot(), null);
  assert.deepEqual(npi.list(), []);

  assert.throws(() => npi.resolveWithinRoot('Artist/Album/Track.flac'), /not configured/);
  await assert.rejects(() => npi.add('Artist/Album/Track.flac'), /not configured/);

  // remove() is treated as a plain miss when disabled, not an error — an
  // unblock action on a station that has never enabled this feature (or
  // turned it off since) must not throw.
  assert.equal(await npi.remove('anything'), false);

  console.log('never-play-ignore-disabled.test.ts: all assertions passed');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
