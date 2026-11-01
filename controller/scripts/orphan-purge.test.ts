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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(dir, 'head-drums.flac'), 'x'.repeat(1024));
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
  // The rename works, the stamp write does not (the stamp's name is a link to
  // a directory, so writeFile fails with EISDIR as a refused write would, for
  // root too). A real directory there would stop the dir reading as stems at
  // all. The dir must go back to the cache, unquarantined.
  symlinkSync(stateDir, join(live, '.orphaned-at'));
  const t = new Date(NOW_BASE - 2 * DAY);
  utimesSync(live, t, t);
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 600 * DAY });
  assert.ok(rep.failed >= 1);
  assert.ok(existsSync(join(live, 'head-drums.flac')), 'moved back to the cache');
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

test('a pass that changed the cache keeps the usage figure, flagged stale', async () => {
  // Deleted outright, the budget field lost its figure and a lowering Save went
  // through with no confirm. The figure stays, and the next sweep re-measures.
  seedStem();
  const measuredAt = new Date().toISOString();
  writeFileSync(join(stateDir, 'stem-cache-usage.json'), JSON.stringify({
    version: 1, root: ROOT, bytes: 5_000_000_000, dirs: 400, measuredAt, updatedAt: measuredAt,
  }));
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 2 * DAY });
  const usage = await cache.storedUsage();
  assert.equal(usage?.bytes, 5_000_000_000, 'the figure is still reported');
  assert.equal(usage?.fresh, false);
  assert.equal(usage?.stale, true);
});

test('a dry run leaves the usage figure as it found it', async () => {
  seedStem();
  const measuredAt = new Date().toISOString();
  writeFileSync(join(stateDir, 'stem-cache-usage.json'), JSON.stringify({
    version: 1, root: ROOT, bytes: 5_000_000_000, dirs: 400, measuredAt, updatedAt: measuredAt,
  }));
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: false, now: NOW_BASE + 2 * DAY });
  assert.equal((await cache.storedUsage())?.fresh, true);
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

// What a share can hold that SUB/WAVE never wrote. Unknown to the library, so
// "not a known id" alone reads each as an orphan, and they all sit past the
// in-flight grace: only the look of the dir tells them from stems.
const FOREIGN = ['lost+found', '@eaDir', '#recycle', 'operator-backup'];
for (const name of FOREIGN) {
  for (const populated of [false, true]) {
    test(`${name}, ${populated ? 'populated' : 'empty'}, is left where it is by every pass`, async () => {
      const dir = join(ROOT, name);
      mkdirSync(dir, { recursive: true });
      if (populated) writeFileSync(join(dir, 'keep-me.tar'), 'operator data');
      const t = new Date(NOW_BASE - 30 * DAY);
      utimesSync(dir, t, t);
      try {
        const now = NOW_BASE + 800 * DAY;
        const nightly = await purge.runScheduledOrphanPurge(['_sentinel'], now);
        assert.ok(!nightly.quarantinedNames.includes(name));
        const manual = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now });
        assert.ok(!manual.quarantinedNames.includes(name));
        await purge.runScheduledOrphanPurge(['_sentinel'], now + 8 * DAY);
        assert.ok(existsSync(dir), 'still at the cache root');
        assert.ok(!existsSync(join(QU, name)), 'never quarantined');
        if (populated) assert.equal(readFileSync(join(dir, 'keep-me.tar'), 'utf8'), 'operator data');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('a dir with stems in it and anything else beside them is not an orphan', async () => {
  const mixedFile = seedStem();
  writeFileSync(join(ROOT, mixedFile, 'notes.txt'), 'an operator file');
  const mixedDir = seedStem();
  mkdirSync(join(ROOT, mixedDir, 'old'));
  for (const id of [mixedFile, mixedDir]) {
    const t = new Date(NOW_BASE - 30 * DAY);
    utimesSync(join(ROOT, id), t, t);
  }
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 820 * DAY });
  assert.ok(existsSync(join(ROOT, mixedFile, 'notes.txt')));
  assert.ok(existsSync(join(ROOT, mixedDir, 'old')));
  assert.ok(!existsSync(join(QU, mixedFile)));
  assert.ok(!existsSync(join(QU, mixedDir)));
  rmSync(join(ROOT, mixedFile), { recursive: true, force: true });
  rmSync(join(ROOT, mixedDir), { recursive: true, force: true });
});

test('a foreign dir an earlier build quarantined is never aged out', async () => {
  // Moved before the stem check existed: it sits in the quarantine with a stamp,
  // and the delete is the one step that cannot be undone.
  const dir = join(QU, 'operator-backup');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keep-me.tar'), 'operator data');
  writeFileSync(join(dir, '.orphaned-at'), String(NOW_BASE));
  const dry = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: false, now: NOW_BASE + 840 * DAY });
  assert.ok(!dry.deletedNames.includes('operator-backup'), 'not offered as a delete');
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 840 * DAY });
  assert.ok(!rep.deletedNames.includes('operator-backup'));
  assert.equal(readFileSync(join(dir, 'keep-me.tar'), 'utf8'), 'operator data');
  rmSync(dir, { recursive: true, force: true });
});

test('the grammar reads what the analyzer really writes', async () => {
  // Pinned against stem-cache's own names, so the two cannot drift apart.
  const id = `track-${seq++}`;
  const dir = join(ROOT, id);
  mkdirSync(dir, { recursive: true });
  for (const w of ['head', 'tail'] as const) {
    for (const s of cache.STEM_NAMES) writeFileSync(cache.stemPath(id, w, s), 'x');
  }
  writeFileSync(join(dir, 'tail-meta.json'), '{}');
  const t = new Date(NOW_BASE - 30 * DAY);
  utimesSync(dir, t, t);
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 860 * DAY });
  assert.ok(existsSync(join(QU, id)), 'a complete stem set is an orphan');
});

// A track that came back, was analysed again, and left again: the live copy is
// the newer one, and the quarantine holds the stale one.
function collide(t0: number) {
  const id = seedStem();
  return (async () => {
    await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: t0 });
    mkdirSync(join(ROOT, id), { recursive: true });
    writeFileSync(join(ROOT, id, 'head-drums.flac'), 'fresh analysis');
    const t = new Date(NOW_BASE - 2 * DAY);
    utimesSync(join(ROOT, id), t, t);
    const back = await purge.runOrphanPurge({ knownIds: [id, '_sentinel'], confirm: true, now: t0 + DAY });
    assert.equal(back.released.includes(id), false, 'the live slot is taken');
    return id;
  })();
}

test('a collision keeps the newer copy, on a fresh stamp', async () => {
  const t0 = NOW_BASE + 900 * DAY;
  const id = await collide(t0);
  const left = t0 + 6.5 * DAY;
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: left });
  assert.ok(!existsSync(join(ROOT, id)), 'the live copy moved');
  assert.equal(readFileSync(join(QU, id, 'head-drums.flac'), 'utf8'), 'fresh analysis', 'the newer copy is the one kept');
  assert.equal(Number(readFileSync(join(QU, id, '.orphaned-at'), 'utf8')), left, 'the grace starts when it left');
  assert.equal(rep.quarantined, 1);
  // The stale copy's stem file and its stamp are what the replace freed.
  assert.equal(rep.freedBytes, 1024 + String(t0).length);
});

test('a replaced quarantine gets its whole grace, not what was left of the old one', async () => {
  const t0 = NOW_BASE + 920 * DAY;
  const id = await collide(t0);
  const left = t0 + 6.5 * DAY;
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: left });
  // Past the OLD stamp's week, half a day after the track left.
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: t0 + 7 * DAY + 1000 });
  assert.ok(existsSync(join(QU, id)), 'still held inside its own week');
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: left + 7 * DAY + 1000 });
  assert.ok(!existsSync(join(QU, id)), 'aged out a week after it left');
});

test('a collision whose stale copy refuses to go leaves the live copy in the cache', async () => {
  const t0 = NOW_BASE + 940 * DAY;
  const id = await collide(t0);
  chmodSync(join(QU, id), 0o555);
  try {
    const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: t0 + 2 * DAY });
    assert.equal(rep.failed, 1);
    assert.equal(rep.quarantined, 0);
    assert.equal(readFileSync(join(ROOT, id, 'head-drums.flac'), 'utf8'), 'fresh analysis');
  } finally {
    chmodSync(join(QU, id), 0o755);
  }
  rmSync(join(ROOT, id), { recursive: true, force: true });
});

test('a release that fails is counted as failed, and not reported as released', async () => {
  const id = seedStem();
  const now = NOW_BASE + 1000 * DAY;
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now });
  chmodSync(ROOT, 0o555);
  let rep;
  try {
    rep = await purge.runOrphanPurge({ knownIds: ['_sentinel', id], confirm: true, now: now + DAY });
  } finally {
    chmodSync(ROOT, 0o777);
  }
  assert.ok(!rep.released.includes(id));
  assert.equal(rep.failed, 1);
  assert.ok(existsSync(join(QU, id)), 'still quarantined');
  // A dry run names what a pass would release, which is the same word.
  const dry = await purge.runOrphanPurge({ knownIds: ['_sentinel', id], confirm: false, now: now + DAY });
  assert.ok(dry.released.includes(id));
  await purge.runOrphanPurge({ knownIds: ['_sentinel', id], confirm: true, now: now + DAY });
});

test('a dry run names the ceiling the automatic pass would refuse at, without refusing itself', async () => {
  const known: string[] = [];
  for (let i = 0; i < 20; i++) known.push(seedStem());
  const orphans: string[] = [];
  for (let i = 0; i < 120; i++) orphans.push(seedStem());
  const now = NOW_BASE + 1020 * DAY;
  const dry = await purge.runOrphanPurge({ knownIds: known, confirm: false, now });
  assert.match(dry.autoRefusal ?? '', /would quarantine \d+ of \d+ stem dirs/);
  assert.equal(dry.refused, undefined, 'the operator can still confirm it');
  assert.ok(dry.quarantined >= 120);
  await purge.runOrphanPurge({ knownIds: known, confirm: true, now });
  const after = await purge.runOrphanPurge({ knownIds: known, confirm: false, now });
  assert.equal(after.autoRefusal, undefined, 'gone once the move is made');
});

test('a refused automatic pass still releases what came back, and holds the aged deletes', async () => {
  // The ceiling trips when the library looks half-loaded. A release is safe on
  // that reading; a delete is the one step nothing undoes.
  const t0 = NOW_BASE + 1040 * DAY;
  const back = seedStem();
  const aged = seedStem();
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: t0 });
  const known: string[] = [back];
  for (let i = 0; i < 20; i++) known.push(seedStem());
  for (let i = 0; i < 120; i++) seedStem();
  const rep = await purge.runScheduledOrphanPurge(known, t0 + 8 * DAY);
  assert.equal(rep.refused, true);
  assert.deepEqual(rep.released, [back]);
  assert.ok(existsSync(join(ROOT, back)), 'released');
  assert.equal(rep.deletedCount, 0);
  assert.ok(existsSync(join(QU, aged)), 'the aged delete waits for a confirm');
  assert.equal(rep.quarantined, 0);
  const manual = await purge.runOrphanPurge({ knownIds: known, confirm: true, now: t0 + 8 * DAY });
  assert.ok(!existsSync(join(QU, aged)), 'a manual confirm makes the delete too');
  assert.ok(manual.quarantined >= 120);
});

test('a quarantine wider than the walk\'s pool is read in full', async () => {
  // The quarantine walk runs in parallel: every entry still lands in the plan.
  const now = NOW_BASE + 1060 * DAY;
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) ids.push(seedStem());
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now });
  for (const id of ids) rmSync(join(QU, id, '.orphaned-at'));
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: now + DAY });
  for (const id of ids) assert.equal(Number(readFileSync(join(QU, id, '.orphaned-at'), 'utf8')), now + DAY);
  const dry = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: false, now: now + 9 * DAY });
  assert.ok(dry.deletedCount >= 40);
});

test('a collision re-reads the quarantined entry: what is not stems is never replaced', async () => {
  // The replace deletes, so it reads the dir first, like the aged delete.
  const id = seedStem();
  const dir = join(QU, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'keep-me.tar'), 'operator data');
  writeFileSync(join(dir, '.orphaned-at'), String(NOW_BASE));
  const rep = await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now: NOW_BASE + 1080 * DAY });
  assert.equal(readFileSync(join(dir, 'keep-me.tar'), 'utf8'), 'operator data');
  assert.ok(existsSync(join(ROOT, id, 'head-drums.flac')), 'the live copy stays in the cache');
  assert.equal(rep.failed, 1);
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(ROOT, id), { recursive: true, force: true });
});

test('the report counts every quarantine entry, whatever a pass would do with it', async () => {
  // Aged out and back in the library, these are neither new orphans nor aging,
  // and the panel's Show tracks count has to include them.
  const aged = seedStem();
  const back = seedStem();
  const now = NOW_BASE + 1100 * DAY;
  await purge.runOrphanPurge({ knownIds: ['_sentinel'], confirm: true, now });
  const dry = await purge.runOrphanPurge({ knownIds: ['_sentinel', back], confirm: false, now: now + 8 * DAY });
  const onDisk = readdirSync(QU).length;
  assert.equal(dry.quarantineEntries, onDisk);
  assert.ok(onDisk >= 2);
  assert.ok(existsSync(join(QU, aged)));
});
