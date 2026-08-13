// Concurrency regression test for music/never-play-ignore.ts:
//
//   1. First-load race — the module used to set a `loaded` flag SYNCHRONOUSLY
//      before `await readFile(...)` resolved, so a second caller arriving
//      while the first read was still in flight saw `loaded === true` and
//      proceeded against a still-empty `ignoredPaths`, silently missing
//      whatever was already on disk.
//   2. Concurrent-mutation race — once add()/remove() were changed to
//      compute-next → persist → publish (so a failed write can't corrupt
//      in-memory state), two concurrent mutations computing `next` from the
//      same pre-mutation snapshot could each persist a smaller list and the
//      second one to finish would silently discard the first's change.
//
// Both are exercised by making the VERY FIRST operations against a fresh
// module instance be two concurrent add() calls, against a root whose
// .ndignore ALREADY has a pre-existing line written directly (not through
// the module) before import — so a premature "loaded" short-circuit would
// be observable as that pre-existing entry going missing from the final
// result, and a lost update would be observable as one of the two new
// entries going missing.
//
// Its own file (rather than a section of scripts/never-play-ignore.test.ts):
// this needs to be the literal first thing the module does in this process,
// which a shared-root file already mid-way through other assertions can't
// offer — run-tests.ts gives every *.test.ts file its own subprocess, so a
// fresh module instance here is free.
//
// Run: `tsx scripts/never-play-ignore-concurrency.test.ts` or via `npm test`.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'never-play-conc-state-'));
const libRoot = mkdtempSync(join(tmpdir(), 'never-play-conc-lib-'));
process.env.STATE_DIR = stateDir;
process.env.NEVER_PLAY_LIBRARY_PATH = libRoot;

const ndignorePath = join(libRoot, '.ndignore');
// Written directly via fs, BEFORE the module is ever imported — this is what
// a controller restart would find already on disk from a previous run.
writeFileSync(ndignorePath, 'Pre/Existing.flac\n');

const npi = await import('../src/music/never-play-ignore.js');

try {
  // Literally the first two calls into the module in this process — nothing
  // has warmed up `loadPromise` yet. Promise.all's array-construction
  // arguments are evaluated synchronously, so the second add()'s call to
  // load() is guaranteed to happen before the first add()'s readFile() can
  // possibly have resolved (fs promises never settle synchronously/inline).
  const [addedA, addedB] = await Promise.all([
    npi.add('New/One.flac'),
    npi.add('New/Two.flac'),
  ]);

  assert.equal(addedA, true);
  assert.equal(addedB, true);

  const finalList = npi.list();
  assert.deepEqual(
    [...finalList].sort(),
    ['New/One.flac', 'New/Two.flac', 'Pre/Existing.flac'].sort(),
    'the pre-existing on-disk entry AND both concurrently-added entries all survive — ' +
    'a premature "loaded" short-circuit would have dropped Pre/Existing.flac, ' +
    'and a lost update between the two concurrent adds would have dropped one of the New/* entries',
  );

  const onDisk = readFileSync(ndignorePath, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(
    [...onDisk].sort(),
    ['New/One.flac', 'New/Two.flac', 'Pre/Existing.flac'].sort(),
    'the persisted file matches memory — no entry was silently overwritten by the losing side of the race',
  );

  console.log('never-play-ignore-concurrency.test.ts: all assertions passed');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(libRoot, { recursive: true, force: true });
}
