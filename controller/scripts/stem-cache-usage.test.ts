// The stem cache's STORED size, for the budget field.
//
// Lowering `audio.stemCacheGb` under what the cache holds makes the next
// hourly sweep delete the difference, and the budget field showed no cache
// size at all. The figure it now shows comes from the usage snapshot
// (`stem-cache-usage.json`) and NEVER from a walk: a walk of a large cache on
// a network share takes minutes, and this is read whenever the Settings page
// opens. Pinned here:
// - storedUsage() reports the snapshot and never walks (cacheWalks unchanged);
// - a snapshot older than a day, or with a pass writing, still reports, but
//   says so (`fresh: false` / `passRunning: true`) — the operator sees an old
//   figure with its age rather than nothing;
// - stems dropped for a replaced file come off the stored size by what they
//   measured, so the next read needs no walk; a drop that cannot be counted
//   (refused part-way) marks it stale instead;
// - a stale snapshot still reports, flagged (`stale: true`), and the sweep
//   re-measures it rather than trusting it; a writer never moves one;
// - a walk in flight when stems are dropped never stores a trusted figure that
//   counts them, whatever state the snapshot was in (the usage journal, #2317);
// - a pick-time settle counts against what the snapshot holds for its dir, so
//   a walk mid-separation never has the dir's growth laid over it, and the
//   walk's figure is not left stale for it;
// - no snapshot, another root, or a malformed one reports null;
// - GET /stem-cache/usage carries it plus the budget in force.
//
// Run: npm test -- stem-cache-usage

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from './test-utils/http.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-stem-usage-'));
after(async () => { await removeTempDir(stateDir); });
process.env.STATE_DIR = stateDir;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
const stemCache = await import('../src/music/stem-cache.js');
const { router } = await import('../src/routes/stem-cache.js');
const express = (await import('express')).default;

const root = stemCache.stemsRoot();
const snapFile = join(stateDir, 'stem-cache-usage.json');
const GB = 1024 ** 3;
const HOUR = 3600_000;
// A snapshot written by hand is one from before the usage journal, as an
// upgrade finds it: the journal goes too, and the next read stamps it.
const journalFile = join(stateDir, 'stem-cache-usage.journal');
const writeSnap = (over: Record<string, unknown>) => {
  const now = new Date().toISOString();
  rmSync(journalFile, { force: true });
  writeFileSync(snapFile, JSON.stringify({ version: 1, root, bytes: 0, dirs: 0, measuredAt: now, updatedAt: now, ...over }));
};

test('a fresh snapshot is reported as is, with no walk', async () => {
  const measuredAt = new Date(Date.now() - HOUR).toISOString();
  writeSnap({ bytes: 778 * GB, dirs: 76_020, measuredAt });
  const walks = stemCache._cacheWalksForTests();
  const u = await stemCache.storedUsage();
  assert.equal(stemCache._cacheWalksForTests(), walks, 'reading the stored size must never walk the cache');
  assert.ok(u);
  assert.equal(u.bytes, 778 * GB);
  assert.equal(u.dirs, 76_020);
  assert.equal(u.measuredAt, measuredAt);
  assert.equal(u.fresh, true);
  assert.equal(u.passRunning, false);
  assert.equal(u.estTrackBytes, stemCache.estimateTrackBytes(778 * GB, 76_020));
});

test('an old snapshot still reports, marked not fresh', async () => {
  writeSnap({ bytes: 5 * GB, dirs: 400, measuredAt: new Date(Date.now() - 30 * HOUR).toISOString() });
  const walks = stemCache._cacheWalksForTests();
  const u = await stemCache.storedUsage();
  assert.equal(stemCache._cacheWalksForTests(), walks);
  assert.equal(u?.bytes, 5 * GB);
  assert.equal(u?.fresh, false);
});

test('a pass writing right now is said, not hidden', async () => {
  writeSnap({ bytes: 5 * GB, dirs: 400, pending: { pid: process.pid, since: new Date().toISOString() } });
  const u = await stemCache.storedUsage();
  assert.equal(u?.passRunning, true);
  assert.equal(u?.fresh, false);
});

test('no snapshot, another root, or a malformed one is null', async () => {
  rmSync(snapFile, { force: true });
  assert.equal(await stemCache.storedUsage(), null);
  writeSnap({ root: '/elsewhere', bytes: GB, dirs: 10 });
  assert.equal(await stemCache.storedUsage(), null);
  writeSnap({ bytes: 'lots', dirs: 10 });
  assert.equal(await stemCache.storedUsage(), null);
  writeFileSync(snapFile, '{not json');
  assert.equal(await stemCache.storedUsage(), null);
});

test('GET /stem-cache/usage: the stored size and the budget in force', async () => {
  writeSnap({ bytes: 3 * GB, dirs: 250 });
  const app = express();
  app.use(router);
  const s = await listen(app);
  s.server.unref();
  const body = await (await fetch(`${s.url}/stem-cache/usage`)).json() as { usage: { bytes: number; dirs: number } | null; budgetBytes: number };
  assert.equal(body.usage?.bytes, 3 * GB);
  assert.equal(body.usage?.dirs, 250);
  assert.equal(body.budgetBytes, stemCache.budgetBytes());
  rmSync(snapFile, { force: true });
  const none = await (await fetch(`${s.url}/stem-cache/usage`)).json() as { usage: unknown };
  assert.equal(none.usage, null);
  await s.close();
});

test('GET /stem-cache/usage: with pick-time stems on, how far over its budget the cache may run', async () => {
  const settings = await import('../src/settings.js');
  const policy = await import('../src/broadcast/pick-stems-policy.js');
  writeSnap({ bytes: 16 * GB, dirs: 1000 });
  const app = express();
  app.use(router);
  const s = await listen(app);
  s.server.unref();
  type Body = { usage: { bytes: number; estTrackBytes: number } | null; budgetBytes: number; pickTimeOvershootBytes?: number };
  const read = async () => (await (await fetch(`${s.url}/stem-cache/usage`)).json()) as Body;
  try {
    const off = await read();
    assert.equal('pickTimeOvershootBytes' in off, false, 'off: the answer is unchanged');
    await settings.update({ transitions: { pickTimeStems: true } });
    const on = await read();
    assert.equal(on.pickTimeOvershootBytes,
      policy.designedOvershootBytes(on.budgetBytes, on.usage!.estTrackBytes),
      'the allowance plus the one separation admitted under it');
    assert.ok(on.pickTimeOvershootBytes! > 0);
    rmSync(snapFile, { force: true });
    assert.equal('pickTimeOvershootBytes' in (await read()), false, 'nothing measured: nothing to size it by');
  } finally {
    await settings.update({ transitions: { pickTimeStems: false } });
    rmSync(snapFile, { force: true });
    await s.close();
  }
});

test('stems dropped for a replaced file come off the stored size, and the next read needs no walk', async () => {
  // Marked stale instead, one replaced file (an MP3 swapped for a FLAC) cost the
  // next read a walk of every stem dir: minutes on a share, holding an import.
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  mkdirSync(stemCache.dirFor('swapped'), { recursive: true });
  writeFileSync(join(stemCache.dirFor('swapped'), 'head-drums.flac'), 'x'.repeat(1000));

  assert.equal((await stemCache.forgetStems(['swapped'])).removed, 1);

  const got = await stemCache.storedUsage();
  assert.equal(got?.bytes, 80 * GB - 1000);
  assert.equal(got?.dirs, 3999);
  assert.equal(got?.stale, false);
  assert.equal(got?.fresh, true);
  // In the file, not this process: the walk that drops stems is the tagger's child.
  assert.equal(JSON.parse(readFileSync(snapFile, 'utf8')).bytes, 80 * GB - 1000);
  const walks = stemCache._cacheWalksForTests();
  await stemCache.usage();
  await stemCache.headroomTracks(100 * GB);
  assert.equal(stemCache._cacheWalksForTests(), walks, 'no walk');
});

test('stems that refuse to go part-way keep the figure, flagged, and the next read walks', { skip: process.getuid?.() === 0 && 'root deletes through any mode' }, async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  const dir = stemCache.dirFor('stuck');
  mkdirSync(join(dir, 'locked'), { recursive: true });
  writeFileSync(join(dir, 'locked', 'head-drums.flac'), 'x');
  chmodSync(join(dir, 'locked'), 0o555);
  try {
    assert.equal((await stemCache.forgetStems(['stuck'])).failed, 1);
    const got = await stemCache.storedUsage();
    assert.equal(got?.bytes, 80 * GB, 'what went is unknown, so nothing is taken off');
    assert.equal(got?.stale, true);
    const walks = stemCache._cacheWalksForTests();
    await stemCache.usage();
    assert.equal(stemCache._cacheWalksForTests(), walks + 1, 'the next read re-measures it');
  } finally {
    chmodSync(join(dir, 'locked'), 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// One writer's change to one dir (StemDirWrites), as forgetStems, the purge
// and a pick-time separation make it: open, change, settle.
const dropOne = async (id: string) => {
  const writes = new stemCache.StemDirWrites();
  await writes.touch(id);
  rmSync(stemCache.dirFor(id), { recursive: true, force: true });
  return writes.settle();
};
const seedDir = (id: string, bytes: number) => {
  mkdirSync(stemCache.dirFor(id), { recursive: true });
  writeFileSync(join(stemCache.dirFor(id), 'head-drums.flac'), 'x'.repeat(bytes));
};

test('a writer moves only a snapshot the next read would use as is', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  assert.equal(await new stemCache.StemDirWrites().settle(), 'unchanged', 'nothing touched');
  seedDir('w-0', 1000);
  assert.equal(await dropOne('w-0'), 'adjusted');
  assert.deepEqual([(await stemCache.storedUsage())?.bytes, (await stemCache.storedUsage())?.dirs], [80 * GB - 1000, 3999]);
  assert.equal((await stemCache.storedUsage())?.fresh, true);
  // A stale one is owed a walk: a delta onto it would launder the flag, so it
  // is left to that walk as it is.
  await stemCache.markUsageStale();
  const staleBefore = JSON.parse(readFileSync(snapFile, 'utf8'));
  seedDir('w-1', 1000);
  assert.equal(await dropOne('w-1'), 'untrusted');
  assert.deepEqual([JSON.parse(readFileSync(snapFile, 'utf8')).bytes, JSON.parse(readFileSync(snapFile, 'utf8')).updatedAt],
    [staleBefore.bytes, staleBefore.updatedAt], 'not touched');
  assert.equal((await stemCache.storedUsage())?.stale, true);
  // Nothing stored stays nothing.
  rmSync(snapFile, { force: true });
  seedDir('w-2', 1000);
  assert.equal(await dropOne('w-2'), 'untrusted');
  assert.equal(await stemCache.storedUsage(), null);
  // Too old to use: also the walk's; the figure is left as it was.
  const old = new Date(Date.now() - 2 * 24 * HOUR).toISOString();
  writeSnap({ bytes: 80 * GB, dirs: 4000, measuredAt: old });
  seedDir('w-3', 1000);
  assert.equal(await dropOne('w-3'), 'untrusted', 'too old to move');
  assert.equal((await stemCache.storedUsage())?.bytes, 80 * GB);
  assert.equal((await stemCache.storedUsage())?.fresh, false);
});

test('a writer with a pass writing leaves the figure, flagged stale, so the pass settles by a walk', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000, pending: { pid: process.pid, since: new Date().toISOString() } });
  seedDir('w-4', 1000);
  assert.equal(await dropOne('w-4'), 'untrusted');
  assert.equal((await stemCache.storedUsage())?.stale, true);
  assert.equal((await stemCache.storedUsage())?.bytes, 80 * GB);
});

test('a walk between a writer\'s open and its settle: the settle counts against what the walk held (#2317)', async () => {
  // Before the journal this was a compare-and-set on measuredAt, and a walk in
  // between left the snapshot stale. The walk now re-measures the open dir and
  // records what it counted, and the settle counts its final against that.
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  seedDir('w-5', 1000);
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  const writes = new stemCache.StemDirWrites();
  await writes.touch('w-5');
  rmSync(stemCache.dirFor('w-5'), { recursive: true, force: true });
  await stemCache.sweep(100 * GB, { force: true });
  const walked = await freshTotals();
  assert.equal((await stemCache.storedUsage())?.fresh, true, 'the walk stored a trusted figure');
  seedDir('w-5', 3000); // the writer goes on: the dir comes back bigger
  assert.equal(await writes.settle(), 'adjusted');
  const stored = await stemCache.storedUsage();
  assert.equal(stored?.fresh, true);
  assert.deepEqual([stored?.bytes, stored?.dirs], [walked.bytes + 3000, walked.dirs + 1], 'the disk\'s figure');
  rmSync(root, { recursive: true, force: true });
  rmSync(snapFile, { force: true });
});

// What a fresh walk of the cache finds, leaving the stored figure as it was.
async function freshTotals(): Promise<{ bytes: number; dirs: number }> {
  let bytes = 0;
  let dirs = 0;
  const { readdirSync, statSync } = await import('node:fs');
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    dirs += 1;
    for (const f of readdirSync(join(root, name))) bytes += statSync(join(root, name, f)).size;
  }
  return { bytes, dirs };
}

// An analysis pass refused its pending mark (the snapshot was untrusted
// already) writes with no mark to hold off a walk in the other process, so
// that walk stored what it found mid-pass as trusted, short of what the pass
// went on to write. The pass's journal opening now holds it off either way.
test('a pass refused its mark still keeps a walk from trusting what it finds mid-pass (#2317)', async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  seedDir('pass-0', 1000);
  writeSnap({ bytes: 80 * GB, dirs: 4000, stale: true });
  assert.equal(await stemCache.markPassPending(), false, 'refused: the snapshot was not trusted');
  let wrote = false;
  stemCache._duringWalkForTests(async () => {
    if (wrote) return;
    wrote = true;
    seedDir('pass-1', 1000); // the pass goes on writing while the walk runs
  });
  try {
    await stemCache.usage();
  } finally {
    stemCache._duringWalkForTests(null);
  }
  assert.equal(wrote, true);
  assert.notEqual((await stemCache.storedUsage())?.fresh, true, 'no trusted figure while the pass writes');
  // Settled, the next read walks and trusts what it finds.
  assert.equal(await stemCache.settlePassWrites([]), null);
  const u = await stemCache.usage();
  assert.deepEqual([u.bytes, u.dirs], [2000, 2]);
  assert.equal((await stemCache.storedUsage())?.fresh, true);
  rmSync(root, { recursive: true, force: true });
  rmSync(snapFile, { force: true });
});

// An upgrade finds the build-before-#2317 files: the snapshot (no journal
// position) and its change token, and no journal. The first sweep must be no
// worse than before: it reuses the snapshot with no walk.
test('an upgrade from the change token: the first sweep reuses the stored size, and the token goes', async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  writeSnap({ bytes: 5 * GB, dirs: 400 });
  const token = join(stateDir, 'stem-cache-usage.changes');
  writeFileSync(token, 'a1b2c3d4-0000-4000-8000-000000000000\n');
  const walks = stemCache._cacheWalksForTests();
  const swept = await stemCache.sweep(100 * GB);
  assert.equal(swept.skipped, 'snapshot', 'inside its budget: no walk');
  assert.equal(stemCache._cacheWalksForTests(), walks);
  assert.equal(existsSync(token), false, 'the old token is removed');
  assert.ok(existsSync(journalFile), 'the journal is created');
  assert.equal((await stemCache.storedUsage())?.fresh, true);
  // And a writer after it counts as before.
  seedDir('up-0', 1000);
  assert.equal(await dropOne('up-0'), 'adjusted');
  assert.equal((await stemCache.storedUsage())?.bytes, 5 * GB - 1000);
  rmSync(root, { recursive: true, force: true });
  rmSync(snapFile, { force: true });
});

// A journal that cannot be read for what it is vouches for nothing: no
// trusted figure, whatever the snapshot says, and a walk stores stale, as a
// walk overlapped by a change did before the journal.
test('a journal that is not a journal: nothing is trusted until the next walk, which replaces it', async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  seedDir('nj-0', 1000);
  rmSync(snapFile, { force: true });
  await stemCache.usage(); // a trusted figure at a journal position
  assert.equal((await stemCache.storedUsage())?.fresh, true);
  // What a crash can leave of it (an empty file), or another version's.
  for (const bad of ['', 'not a journal\n']) {
    writeFileSync(journalFile, bad);
    assert.equal((await stemCache.storedUsage())?.fresh, false);
    assert.equal((await stemCache.storedUsage())?.stale, true);
    const walks = stemCache._cacheWalksForTests();
    await stemCache.headroomTracks(100 * GB);
    assert.equal(stemCache._cacheWalksForTests(), walks + 1, 'the read walks');
    // Left in place, it would vouch for nothing ever again: every read a walk.
    assert.equal((await stemCache.storedUsage())?.fresh, true, 'the walk stored a trusted figure in a new journal');
    await stemCache.headroomTracks(100 * GB);
    assert.equal(stemCache._cacheWalksForTests(), walks + 1, 'and the next read needs no walk');
    assert.match(readFileSync(journalFile, 'utf8'), /^subwave-stem-journal 1 \S+ 0\n/, 'dated 0: no snapshot stamps into trust');
  }
  rmSync(journalFile, { force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(snapFile, { force: true });
});

// The other process can lose the journal at any moment (an append that fails
// drops it) and a writer there create a new one and log a whole change in it.
// A walk that trims must then not take the new file for its own:
// - lost before the trim opens it, the new file is not the one the walk read,
//   though it can be given that one's inode number: the trim copied only its
//   lines past the old end and dropped the rest, the change among them;
// - lost after the trim renamed its own into place, the position the trim
//   returns was taken in a file it never wrote, past the change.
// Either way the walk stored a trusted figure that missed the change. The trim
// now checks each file by its id, and stands down; the walk's figure, at the
// old journal's position, then vouches for nothing.
test('a walk whose journal is lost and created again around its trim stores nothing trusted', async () => {
  const journal = await import('../src/music/stem-usage-journal.js');
  const policy = await import('../src/music/stem-usage-policy.js');
  // `pad`: openings logged after the change, so the new file reaches past the
  // trim's position (it carries three openings) and a reader would trust it.
  for (const [point, pad] of [['walk:store', 0], ['trim:renamed', 2]] as const) {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
    seedDir('tj-b', 1000);
    rmSync(snapFile, { force: true });
    rmSync(journalFile, { force: true });
    await stemCache.usage();
    // Writers still running at the store: the trim carries their openings.
    const running = ['tj-y1', 'tj-y2', 'tj-y3'].map(() => new stemCache.StemDirWrites());
    for (const [i, w] of running.entries()) {
      seedDir(`tj-y${i + 1}`, 500);
      await w.touch(`tj-y${i + 1}`);
    }
    let replaced = false;
    journal._trimAboveBytesForTests(0);
    stemCache._usageStepsForTests(async (step) => {
      if (step !== point || replaced) return;
      replaced = true;
      assert.equal(await journal.dropJournal(), true);
      const s = journal.newSessionId();
      assert.equal(await journal.appendLines([policy.openLine(s, 'tj-b', Date.now(), process.pid, null)]), true);
      rmSync(stemCache.dirFor('tj-b'), { recursive: true, force: true });
      assert.equal(await journal.appendLines([policy.closeLine(s, 'tj-b')]), true);
      for (let i = 0; i < pad; i += 1) {
        assert.equal(await journal.appendLines([policy.openLine(journal.newSessionId(), `tj-z${i}`, Date.now(), process.pid, null)]), true);
      }
    });
    try {
      await stemCache.sweep(100 * GB, { force: true });
      stemCache._usageStepsForTests(null);
      assert.equal(replaced, true, `${point}: the journal was replaced`);
      const stored = await stemCache.storedUsage();
      const truth = await freshTotals();
      if (stored?.fresh) {
        assert.deepEqual([stored.bytes, stored.dirs], [truth.bytes, truth.dirs], `${point}: a trusted figure must be the disk's`);
      }
      const u = await stemCache.usage();
      assert.deepEqual([u.bytes, u.dirs], [truth.bytes, truth.dirs], `${point}: the next read`);
    } finally {
      stemCache._usageStepsForTests(null);
      journal._trimAboveBytesForTests(null);
      for (const w of running) await w.abandon();
      rmSync(journalFile, { force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(snapFile, { force: true });
    }
  }
});

// An append checks that the path still names the file it wrote to, and goes
// again if not. Checked after closing that file, the check could pass on a
// new journal given the gone one's inode number (the other process dropped it
// and created another), and the line was lost while the writer counted it
// written. It is checked with the file still open now.
test('an append whose journal is lost and created again before its check still lands', async () => {
  const journal = await import('../src/music/stem-usage-journal.js');
  const policy = await import('../src/music/stem-usage-policy.js');
  rmSync(journalFile, { force: true });
  assert.ok(await journal.ensureJournal());
  const line = policy.closeLine(journal.newSessionId(), 'ap-0');
  let replaced = false;
  journal._journalStepsForTests(async (step) => {
    if (step !== 'append:written' || replaced) return;
    replaced = true;
    assert.equal(await journal.dropJournal(), true);
    assert.ok(await journal.ensureJournal());
  });
  try {
    assert.equal(await journal.appendLines([line]), true);
    assert.equal(replaced, true);
    const j = await journal.readJournal();
    assert.ok(j?.entries.some(e => e.line === line), 'a line reported written is in the journal');
  } finally {
    journal._journalStepsForTests(null);
    rmSync(journalFile, { force: true });
  }
});

// A state dir on a filesystem without hard links (FAT/exFAT, some FUSE and SMB
// mounts) could never create the journal, which is put in place by a link: no
// figure was ever trusted again, and every read walked the cache, for good.
// It is renamed into place there instead, under the trim lock, so two
// processes creating it at once end with one journal holding both's lines.
test('a filesystem without hard links still gets a journal, and reads trust it after one walk', async () => {
  const journal = await import('../src/music/stem-usage-journal.js');
  const policy = await import('../src/music/stem-usage-policy.js');
  journal._linkForTests(async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
  try {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
    seedDir('nl-0', 1000);
    seedDir('nl-1', 1000);
    rmSync(snapFile, { force: true });
    rmSync(journalFile, { force: true });
    const walks = stemCache._cacheWalksForTests();
    await stemCache.headroomTracks(100 * GB);
    assert.equal(stemCache._cacheWalksForTests(), walks + 1, 'one walk');
    assert.ok(existsSync(journalFile), 'the journal is created');
    assert.equal((await stemCache.storedUsage())?.fresh, true);
    await stemCache.headroomTracks(100 * GB);
    assert.equal(stemCache._cacheWalksForTests(), walks + 1, 'and the next read needs none');
    assert.equal(await dropOne('nl-0'), 'adjusted');
    assert.equal((await stemCache.storedUsage())?.bytes, 1000);
    // Two writers creating it at once: the first is held at its link while the
    // second creates the journal and writes to it. The first must then find
    // that journal, not put its own over it and lose the second's line.
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let links = 0;
    journal._linkForTests(async () => {
      links += 1;
      if (links === 1) await held;
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    rmSync(journalFile, { force: true });
    const [first, second] = [0, 1].map(() => policy.closeLine(journal.newSessionId(), 'nl-1'));
    const firstDone = journal.appendLines([first]);
    while (links === 0) await new Promise(r => setImmediate(r));
    assert.equal(await journal.appendLines([second]), true);
    release();
    assert.equal(await firstDone, true);
    const j = await journal.readJournal();
    for (const l of [first, second]) assert.ok(j?.entries.some(e => e.line === l), 'a line reported written is in the journal');
  } finally {
    journal._linkForTests(null);
    rmSync(journalFile, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(snapFile, { force: true });
  }
});

test('a stale snapshot is still reported, flagged, and never walked for', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  await stemCache.markUsageStale();
  const walks = stemCache._cacheWalksForTests();
  const got = await stemCache.storedUsage();
  assert.equal(got?.bytes, 80 * GB);
  assert.equal(got?.fresh, false);
  assert.equal(got?.stale, true);
  assert.equal(stemCache._cacheWalksForTests(), walks);
});

test('nothing stored stays nothing: marking stale invents no figure', async () => {
  rmSync(snapFile, { force: true });
  await stemCache.markUsageStale();
  assert.equal(await stemCache.storedUsage(), null);
});

test('stale is a walk for the sweep and the headroom read, and a live pass still owns its mark', () => {
  const base = { version: 1 as const, root, bytes: GB, dirs: 10, measuredAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  assert.equal(stemCache.snapshotVerdict({ snap: base, root, nowMs: Date.now(), pendingAlive: false }), 'use');
  assert.equal(stemCache.snapshotVerdict({ snap: { ...base, stale: true }, root, nowMs: Date.now(), pendingAlive: false }), 'walk');
  const pending = { pid: process.pid, since: new Date().toISOString() };
  assert.equal(stemCache.snapshotVerdict({ snap: { ...base, stale: true, pending }, root, nowMs: Date.now(), pendingAlive: true }), 'pass-running');
});

test('the sweep re-measures a stale snapshot, and the flag goes with it', async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  await stemCache.markUsageStale();
  const walks = stemCache._cacheWalksForTests();
  const swept = await stemCache.sweep(100 * GB);
  assert.equal(swept.skipped, undefined, 'walked: a stale figure is not a reason to skip');
  assert.ok(stemCache._cacheWalksForTests() > walks);
  const got = await stemCache.storedUsage();
  assert.equal(got?.bytes, 0, 're-measured');
  assert.equal(got?.fresh, true);
  assert.equal(got?.stale, false);
});

test('a pass settling onto a stale snapshot takes the walk, and cannot launder the flag', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  assert.equal(await stemCache.markPassPending(), true);
  await stemCache.markUsageStale();
  assert.equal(await stemCache.settlePassWrites([]), null);
  assert.equal((await stemCache.storedUsage())?.stale, true);
  // Clear what the refused settlement left for the rest of the file.
  await stemCache.sweep(100 * GB, { force: true });
});

test('GET /stem-cache/usage carries the stale flag to the budget field', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  await stemCache.markUsageStale();
  const app = express();
  app.use(router);
  const { server, url } = await listen(app);
  server.unref();
  const body = await (await fetch(`${url}/stem-cache/usage`)).json() as { usage: { bytes: number; stale: boolean } };
  assert.equal(body.usage.bytes, 80 * GB);
  assert.equal(body.usage.stale, true);
  await new Promise(r => server.close(r));
});

// A walk in flight while stems are dropped (forgetStems, or the orphan purge's
// moves) may have counted some of them. When the snapshot the walk started on
// was untrusted or absent, the drop leaves the file as it found it, so the
// file alone cannot tell the walk: the change token does. Whatever the
// snapshot's state, the walk must end with a figure that is either untrusted
// or right, never trusted and wrong.
test('a walk that a drop of stems lands in never stores a trusted figure that counts them', async () => {
  const states: Array<[string, () => void]> = [
    ['stale', () => writeSnap({ bytes: 80 * GB, dirs: 4000, stale: true })],
    ['over a day old', () => writeSnap({ bytes: 80 * GB, dirs: 4000, measuredAt: new Date(Date.now() - 2 * 24 * HOUR).toISOString() })],
    ['absent', () => rmSync(snapFile, { force: true })],
  ];
  const walkers: Array<[string, () => Promise<unknown>]> = [
    ['a read', () => stemCache.usage()],
    ['the sweep', () => stemCache.sweep(100 * GB, { force: true })],
  ];
  try {
    for (const [stateName, setState] of states) {
      for (const [walkerName, walk] of walkers) {
        const label = `${walkerName} on a snapshot ${stateName}`;
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
        for (const id of ['mid-0', 'mid-1', 'mid-2']) {
          mkdirSync(stemCache.dirFor(id), { recursive: true });
          writeFileSync(join(stemCache.dirFor(id), 'head-drums.flac'), 'x'.repeat(1000));
        }
        setState();
        let landed = false;
        // The walk has listed and measured all three dirs; the drop lands now.
        stemCache._duringWalkForTests(async () => {
          if (landed) return;
          landed = true;
          assert.equal((await stemCache.forgetStems(['mid-1'])).removed, 1);
        });
        await walk();
        stemCache._duringWalkForTests(null);
        assert.equal(landed, true, `${label}: the drop landed mid-walk`);
        let snap: Parameters<typeof stemCache.snapshotVerdict>[0]['snap'] = null;
        try { snap = JSON.parse(readFileSync(snapFile, 'utf8')); } catch { /* none stored */ }
        const verdict = stemCache.snapshotVerdict({ snap, root, nowMs: Date.now(), pendingAlive: false });
        if (verdict === 'use') {
          assert.deepEqual([snap?.bytes, snap?.dirs], [2000, 2], `${label}: a trusted figure must be the disk's`);
        }
        // And the next read gets the disk right.
        const u = await stemCache.usage();
        assert.deepEqual([u.bytes, u.dirs], [2000, 2], `${label}: the next read`);
      }
    }
  } finally {
    stemCache._duringWalkForTests(null);
    rmSync(root, { recursive: true, force: true });
    rmSync(snapFile, { force: true });
  }
});

// A pick-time separation writes its dir over seconds to minutes. A walk that
// lands in that time (the hourly sweep) counts the part written so far and
// stores it as a new measurement; the settle's full growth on top of that
// counted the part twice and stayed trusted. The settle now counts against
// the measurement read before the write began (beginTrackWrite).
test('a pick-time settle never adds growth a walk mid-separation already counted', async () => {
  try {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
    for (const id of ['settled-0', 'settled-1']) {
      mkdirSync(stemCache.dirFor(id), { recursive: true });
      writeFileSync(join(stemCache.dirFor(id), 'head-drums.flac'), 'x'.repeat(1000));
    }
    rmSync(snapFile, { force: true });
    await stemCache.usage(); // a trusted measurement of the two dirs
    const base = await stemCache.beginTrackWrite('separating');
    // Half the set is written when the sweep's walk lands, and it stores what it found.
    mkdirSync(stemCache.dirFor('separating'), { recursive: true });
    writeFileSync(join(stemCache.dirFor('separating'), 'head-drums.flac'), 'x'.repeat(1000));
    await new Promise(r => setTimeout(r, 5)); // a later measuredAt than the first walk's
    await stemCache.sweep(100 * GB, { force: true });
    assert.equal(JSON.parse(readFileSync(snapFile, 'utf8')).dirs, 3, 'the walk counted the half-written dir');
    writeFileSync(join(stemCache.dirFor('separating'), 'head-vocals.flac'), 'x'.repeat(1000));
    await stemCache.settleTrackWrite('separating', base);

    const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
    if (stemCache.snapshotVerdict({ snap, root, nowMs: Date.now(), pendingAlive: false }) === 'use') {
      assert.deepEqual([snap.bytes, snap.dirs], [4000, 3], 'a trusted figure must be the disk\'s');
    }
    const u = await stemCache.usage();
    assert.deepEqual([u.bytes, u.dirs], [4000, 3], 'the next read');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(snapFile, { force: true });
  }
});

// A full walk says why it walks, and the reason comes from the cascade that
// decided to walk (judgeSnapshot), not a second reading of the file: the copy
// that was here called another root's snapshot, or one dated ahead, "over a
// day old".
test('a walk logs the reason its snapshot was refused, from the same cascade', async () => {
  const cases: Array<[Record<string, unknown> | null, string]> = [
    [null, 'no stored size'],
    [{ root: '/elsewhere' }, 'another cache root'],
    [{ bytes: 'x' }, 'malformed'],
    [{ stale: true }, 'marked stale'],
    [{ measuredAt: new Date(Date.now() - 2 * 24 * HOUR).toISOString() }, 'over a day old'],
    [{ measuredAt: new Date(Date.now() + 2 * HOUR).toISOString() }, 'dated in the future'],
    [{ pending: { pid: 2 ** 22 + 12345, since: new Date().toISOString() } }, 'did not settle'],
  ];
  const logged: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    for (const [over, reason] of cases) {
      if (over) writeSnap(over); else rmSync(snapFile, { force: true });
      logged.length = 0;
      await stemCache.usage();
      const line = logged.find(l => l.includes('measuring the stem cache')) ?? '';
      assert.ok(line.includes(reason), `${JSON.stringify(over)}: "${line}" names "${reason}"`);
    }
  } finally {
    console.log = log;
    rmSync(snapFile, { force: true });
  }
});

// #2352: a writer that dies between its change and its close leaves its
// opening in the journal for good. The figure must stop being trusted as soon
// as its process is gone (or its pid names another process, as under tini
// after a restart), not at the next daily walk. A real child process stands
// in for the writer (a separation in the controller, forgetStems in the
// tagger child), so liveness and the start identity are read from /proc.
const hasProc = existsSync('/proc/self/stat');

async function withChildWriter(fn: (child: { pid: number; start: string; kill: () => Promise<void> }) => Promise<void>) {
  const { spawn } = await import('node:child_process');
  const policy = await import('../src/music/stem-usage-policy.js');
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise(r => proc.once('exit', r));
  try {
    const pid = proc.pid!;
    const start = policy.procStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    assert.ok(start);
    await fn({ pid, start, kill: async () => { proc.kill('SIGKILL'); await exited; } });
  } finally {
    proc.kill('SIGKILL');
    await exited;
  }
}

async function freshRootMeasured(): Promise<void> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  seedDir('dw-0', 1000);
  rmSync(snapFile, { force: true });
  rmSync(journalFile, { force: true });
  await stemCache.usage();
  assert.equal((await stemCache.storedUsage())?.fresh, true, 'a trusted measurement to start from');
}

test('a writer that dies mid-change leaves the stored size untrusted at once (#2352)', { skip: !hasProc }, async () => {
  const journal = await import('../src/music/stem-usage-journal.js');
  const policy = await import('../src/music/stem-usage-policy.js');
  try {
    await freshRootMeasured();
    await withChildWriter(async (child) => {
      assert.equal(await journal.appendLines([policy.openLine(journal.newSessionId(), 'dw-1', Date.now(), child.pid, child.start)]), true);
      assert.equal((await stemCache.storedUsage())?.fresh, true, 'a write still running is trusted');
      seedDir('dw-1', 1000); // its change lands, then it is killed before its close
      await child.kill();
      const u = await stemCache.storedUsage();
      assert.equal(u?.fresh, false, 'a dead writer\'s opening vouches for nothing');
      assert.equal(u?.stale, true);
    });
    const walks = stemCache._cacheWalksForTests();
    const u = await stemCache.usage();
    assert.equal(stemCache._cacheWalksForTests(), walks + 1, 'the next read walks');
    assert.deepEqual([u.bytes, u.dirs], [2000, 2]);
    assert.equal((await stemCache.storedUsage())?.fresh, true, 'and that walk stores a trusted figure past the dead opening');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(snapFile, { force: true });
    rmSync(journalFile, { force: true });
  }
});

test('an opening whose pid now names another process vouches for nothing (tini pid reuse, #2352)', { skip: !hasProc }, async () => {
  const journal = await import('../src/music/stem-usage-journal.js');
  const policy = await import('../src/music/stem-usage-policy.js');
  const own = policy.procStartTime(readFileSync('/proc/self/stat', 'utf8'));
  assert.ok(own);
  try {
    await freshRootMeasured();
    assert.equal(await journal.appendLines([policy.openLine(journal.newSessionId(), 'dw-1', Date.now(), process.pid, own)]), true);
    assert.equal((await stemCache.storedUsage())?.fresh, true, 'this process, as it is');
    // This process's pid, but a predecessor's start: a controller that died and
    // was restarted under tini with the same pid.
    assert.equal(await journal.appendLines([policy.openLine(journal.newSessionId(), 'dw-2', Date.now(), process.pid, String(Number(own) - 1))]), true);
    assert.equal((await stemCache.storedUsage())?.fresh, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(snapFile, { force: true });
    rmSync(journalFile, { force: true });
  }
});

test('a walk that held a write open stops being trusted once that writer dies (#2352)', { skip: !hasProc }, async () => {
  const journal = await import('../src/music/stem-usage-journal.js');
  const policy = await import('../src/music/stem-usage-policy.js');
  try {
    await freshRootMeasured();
    await withChildWriter(async (child) => {
      const session = journal.newSessionId();
      assert.equal(await journal.appendLines([policy.openLine(session, 'dw-1', Date.now(), child.pid, child.start)]), true);
      seedDir('dw-1', 1000);
      await new Promise(r => setTimeout(r, 5));
      await stemCache.sweep(100 * GB, { force: true }); // stores the open write in inFlight
      const snap = JSON.parse(readFileSync(snapFile, 'utf8'));
      assert.equal(snap.inFlight?.[policy.inFlightKey(session, 'dw-1')], 1000, 'the walk holds what it counted for the open dir');
      assert.equal((await stemCache.storedUsage())?.fresh, true);
      writeFileSync(join(stemCache.dirFor('dw-1'), 'head-vocals.flac'), 'x'.repeat(1000)); // more lands, then it dies
      await child.kill();
      assert.equal((await stemCache.storedUsage())?.fresh, false, 'nothing past the position changed, but the held write will never settle');
    });
    const u = await stemCache.usage();
    assert.deepEqual([u.bytes, u.dirs], [3000, 2], 'the next read walks to the disk\'s figure');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(snapFile, { force: true });
    rmSync(journalFile, { force: true });
  }
});
