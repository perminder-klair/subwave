// Orphan-stem purge, IO layer against a temp STATE_DIR (music/orphan-purge.ts).
// The decisions themselves are pinned in scripts/orphan-purge-pure.test.ts; this
// file drives real directories: move-to-quarantine, the aged delete, release
// back to the library, the in-flight grace, failure accounting, and the
// snapshot invalidation that keeps the usage report honest.
//
// stem-cache resolves its root from config at import time, so this file loads
// the modules ONCE against one temp STATE_DIR (matching scripts/stem-cache-sweep.test.ts)
// and gives every test its own directory names. Quarantine age is steered by
// passing a future `now` to the pass, not by racing mtimes.

import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const DAY = 86400_000;

const stateDir = createTempDir(join(tmpdir(), 'subwave-orphan-io-'));
after(async () => { await removeTempDir(stateDir); });
process.env.STATE_DIR = stateDir;
const cache = await import('../src/music/stem-cache.js');
const purge = await import('../src/music/orphan-purge.js');
const ROOT = cache.stemsRoot();
const QU = join(ROOT, '.orphan-quarantine');
mkdirSync(ROOT, { recursive: true });
// Production caches carry the marker; without it every empty fresh root reads
// as an unmounted share. The offline-but-quarantine-visible case has its own
// test below.
writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}');
const NOW_BASE = Date.now();
// The containers' default: mkdir's mode is masked by it.
process.umask(0o022);

let seq = 0;
function seedStem(opts: { fresh?: boolean } = {}): string {
  const id = `track-${seq++}`;
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'window-drums.flac'), 'x'.repeat(1024));
  if (!opts.fresh) {
    // Two days behind `nowBase` below; passes use nowBase so it is not in-flight.
    const t = new Date(NOW_BASE - 2 * DAY);
    utimesSync(dir, t, t);
  }
  return id;
}

test('an orphan is moved into the quarantine, and it leaves the cache root', async () => {
  const gone = seedStem();
  const kept = seedStem();
  const rep = await purge.runOrphanPurge({ knownIds: [kept, '_sentinel'], confirm: true, now: NOW_BASE });
  assert.equal(rep.quarantined, 1);
  assert.ok(!existsSync(join(ROOT, gone)));
  assert.ok(existsSync(join(QU, gone)));
  assert.ok(existsSync(join(ROOT, kept)));
});

test('the quarantine is shared 777 like the cache root, whatever the umask', async () => {
  // mkdir({ mode: 0o777 }) alone comes out 755 under umask 022; a 755 left by
  // an older controller is opened up on the next move.
  assert.equal(statSync(QU).mode & 0o777, 0o777);
  chmodSync(QU, 0o755);
  seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  assert.equal(statSync(QU).mode & 0o777, 0o777);
});

test('an unconfirmed pass is a dry run: the report counts, the disk does not change', async () => {
  const gone = seedStem();
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: false, now: NOW_BASE });
  assert.equal(rep.dryRun, true);
  assert.ok(rep.quarantined >= 1);
  assert.ok(existsSync(join(ROOT, gone)), 'dry run must not move anything');
});

test('a quarantine past the grace period is deleted and its bytes counted', async () => {
  const oldOrphan = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  assert.ok(existsSync(join(QU, oldOrphan)));
  // 8 days later: past the 7-day grace.
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 8 * DAY });
  // The shared root carries quarantines from earlier tests, so assert "this one
  // is gone" plus at-least-one deleted, not an exact count.
  assert.ok(rep.deletedCount >= 1);
  assert.ok(rep.freedBytes >= 1024);
  assert.ok(!existsSync(join(QU, oldOrphan)));
});

test('a quarantine inside the grace period only ages', async () => {
  const fresh = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + DAY });
  assert.equal(rep.deletedCount, 0);
  assert.ok(rep.agingCount >= 1);
  assert.ok(existsSync(join(QU, fresh)));
});

test('a quarantined id that walked back into the library is released to its live slot', async () => {
  const revival = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const rep = await purge.runOrphanPurge({ knownIds: [revival, '_sentinel'], confirm: true, now: NOW_BASE + DAY });
  assert.ok(rep.released.includes(revival));
  assert.ok(existsSync(join(ROOT, revival)));
  assert.ok(!existsSync(join(QU, revival)));
});

test('directories written in the last hour are never quarantined', async () => {
  const midWrite = seedStem();
  // Pin the dir five minutes before a pass that runs at that same `now`:
  // in-flight by age, whatever the earlier tests' clock jumps left behind.
  const inFlightNow = NOW_BASE + 402 * DAY;
  { const { utimesSync: u } = await import('node:fs'); const t = new Date(inFlightNow - 300_000); u(join(ROOT, midWrite), t, t); }
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: inFlightNow });
  // Earlier tests leave aged dirs that legitimately quarantine in this pass;
  // what matters is that the fresh one is neither moved nor counted.
  assert.equal(rep.inFlight, 1);
  assert.ok(!rep.quarantinedNames.includes(midWrite));
  assert.ok(existsSync(join(ROOT, midWrite)));
});

test('an empty id set is refused, not trusted as an empty library', async () => {
  const aTrack = seedStem();
  const rep = await purge.runOrphanPurge({ knownIds: [], confirm: true, now: NOW_BASE });
  assert.equal(rep.refused, true);
  assert.equal(rep.quarantined, 0);
  assert.ok(existsSync(join(ROOT, aTrack)));
});

test('a quarantine that cannot be deleted is counted, never thrown', async () => {
  const stuck = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const q = join(QU, stuck);
  // The quarantine entry itself refuses deletion (root-squashed NFS: the dir
  // is read-only, so removing the file inside fails). readdir still works.
  chmodSync(q, 0o555);
  try {
    const before = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: false, now: NOW_BASE + 8 * DAY });
    // What the other aged quarantines really hold, measured before the pass.
    const { readdirSync } = await import('node:fs');
    const others = before.deletedNames.filter(n => n !== stuck)
      .reduce((sum, n) => sum + readdirSync(join(QU, n)).reduce((s, f) => s + statSync(join(QU, n, f)).size, 0), 0);
    assert.ok(before.deletedCount <= 10, 'deletedNames lists every candidate here');
    const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 8 * DAY });
    assert.equal(rep.failed, 1);
    assert.ok(existsSync(q));
    // Its bytes are still on disk, so they are not reported as freed: only the
    // other aged quarantines' bytes are (the dry run counted it as deletable).
    assert.equal(rep.deletedCount, before.deletedCount - 1);
    assert.equal(rep.freedBytes, others, 'the stuck quarantine\'s bytes are not counted as freed');
  } finally {
    chmodSync(q, 0o755);
  }
});

test('a quarantine with no readable stamp starts its grace now, never from the dir mtime', async () => {
  // The dir's mtime is two days old and a rename keeps it; with the stamp
  // gone, the old fallback read a just-quarantined dir as old enough to delete.
  const unstamped = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 500 * DAY });
  const q = join(QU, unstamped);
  rmSync(join(q, '.orphaned-at'));
  const t = new Date(NOW_BASE - 30 * DAY);
  utimesSync(q, t, t);
  const first = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 500 * DAY + 60_000 });
  assert.ok(existsSync(q), 'kept, a minute after the move');
  assert.ok(!first.deletedNames.includes(unstamped));
  assert.equal(Number(readFileSync(join(q, '.orphaned-at'), 'utf8')), NOW_BASE + 500 * DAY + 60_000, 'stamped now');
  const later = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 508 * DAY });
  assert.ok(later.deletedNames.includes(unstamped) || !existsSync(q), 'deleted once the grace has passed from the new stamp');
});

test('a move whose stamp cannot be written is undone and counted', async () => {
  const id = seedStem();
  const live = join(ROOT, id);
  // The rename works, the stamp write does not (a directory sits where the
  // stamp goes, so writeFile fails with EISDIR, as a refused write would). The
  // dir must go back to the cache, unquarantined.
  mkdirSync(join(live, '.orphaned-at'));
  const t = new Date(NOW_BASE - 2 * DAY);
  utimesSync(live, t, t);
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 600 * DAY });
  assert.ok(rep.failed >= 1);
  assert.ok(existsSync(join(live, 'window-drums.flac')), 'moved back to the cache');
  assert.ok(!existsSync(join(QU, id)));
  rmSync(live, { recursive: true, force: true });
});

test('a released dir drops its quarantine stamp', async () => {
  const id = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 700 * DAY });
  await purge.runOrphanPurge({ knownIds: [id, '_sentinel'], confirm: true, now: NOW_BASE + 701 * DAY });
  assert.ok(existsSync(join(ROOT, id)));
  assert.ok(!existsSync(join(ROOT, id, '.orphaned-at')));
});

test('the usage snapshot is invalidated when the purge moved anything', async () => {
  seedStem();
  writeFileSync(join(stateDir, 'stem-cache-usage.json'), JSON.stringify({ v: 1, bytes: 1, dirs: 1 }));
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 2 * DAY });
  assert.ok(!existsSync(join(stateDir, 'stem-cache-usage.json')), 'stale snapshot must be dropped');
});

test('a pass with nothing to do reports zeros and touches nothing', async () => {
  const healthy = seedStem();
  // Drain any earlier leftovers for a clean read of THIS test's effect.
  await purge.runOrphanPurge({ knownIds: [healthy, '_sentinel'], confirm: true, now: NOW_BASE + 400 * DAY });
  const rep = await purge.runOrphanPurge({ knownIds: [healthy, '_sentinel'], confirm: true, now: NOW_BASE + 401 * DAY });
  assert.equal(rep.quarantined, 0);
  assert.equal(rep.deletedCount, 0);
  assert.equal(rep.released.length, 0);
  assert.ok(existsSync(join(ROOT, healthy)));
});

test('a lost marker does not strand an aged quarantine (quarantine present proves the share)', async () => {
  const stranded = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE });
  const { rmSync } = await import('node:fs');
  rmSync(join(ROOT, cache.STEMS_MARKER)); // operator lost the marker; cache may even be empty now
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 8 * DAY });
  assert.ok(rep.deletedCount >= 1);
  assert.ok(!existsSync(join(QU, stranded)));
  writeFileSync(join(ROOT, cache.STEMS_MARKER), '{}'); // restore for later tests
});

test('the nightly pass stamps each quarantine\'s name, like the manual confirm', async () => {
  // Most quarantining is the cron's: without the stamp, a folder's name
  // outlived nothing once the event logs aged out.
  const gone = seedStem();
  writeFileSync(join(stateDir, 'recent-plays.json'), JSON.stringify([
    { id: gone, title: 'Marionette', artist: 'Mathew Jonson', album: 'Remixes' },
  ]));
  const rep = await purge.runScheduledOrphanPurge(['_sentinel'], NOW_BASE + 403 * DAY);
  assert.ok(rep.quarantined >= 1);
  const meta = JSON.parse(readFileSync(join(QU, gone, '.track-meta.json'), 'utf8'));
  assert.equal(meta.title, 'Marionette');
  assert.equal(meta.artist, 'Mathew Jonson');
});

test('one confirmed pass at a time: a second one is refused while the first runs', async () => {
  seedStem();
  const [a, b] = await Promise.all([
    purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 404 * DAY }),
    purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 404 * DAY }),
  ]);
  assert.equal(a.refused, undefined);
  assert.equal(b.refused, true);
  assert.match(b.reason ?? '', /another purge pass is running/);
  // A dry run is never held back: it moves nothing.
  const dry = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: false, now: NOW_BASE + 404 * DAY });
  assert.equal(dry.refused, undefined);
});

test('the nightly pass refuses a mass move and leaves it to an operator; a manual confirm still makes it', async () => {
  // A library table half-filled after a reset reads like most of the cache
  // left the library. The cron must not act on that by itself.
  const known: string[] = [];
  for (let i = 0; i < 20; i++) known.push(seedStem());
  const orphans: string[] = [];
  for (let i = 0; i < 120; i++) orphans.push(seedStem());
  const now = NOW_BASE + 405 * DAY;
  const auto = await purge.runScheduledOrphanPurge(known, now);
  assert.equal(auto.refused, true);
  // Earlier tests leave a few dirs of their own at the shared root.
  assert.match(auto.reason ?? '', /would quarantine \d+ of \d+ stem dirs/);
  assert.ok(orphans.every(id => existsSync(join(ROOT, id))), 'nothing moved');
  const manual = await purge.runOrphanPurge({ knownIds: known, confirm: true, now });
  assert.ok(manual.quarantined >= 120);
  assert.ok(orphans.every(id => existsSync(join(QU, id))));
});
