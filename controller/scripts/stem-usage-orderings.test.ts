// Every ordering of a walk and a writer of the stem cache, enumerated, not
// sampled (#2317). The stored cache size must never be trusted and wrong, and
// with pick-time stems on, a separation that settles during or after the
// hourly sweep's walk must no longer leave it stale.
//
// Two actors run at once against a real temp cache: a walk (the sweep, or a
// read that found the snapshot untrusted) and a writer (a pick-time
// separation, forgetStems' drop, an id rotation's rename, or a second writer).
// Each stops at the named points stem-cache.ts and stem-usage-journal.ts
// expose (_usageStepsForTests): the walk's start, the end of its scan, its
// re-measure, its store, the trim's rename and its end; the writer's open,
// its base measure, its writes, its close, its read of the snapshot, and each
// journal append's open and its inode check. A driver picks which parked
// actor goes next, and a depth-first odometer over those picks runs every
// schedule once.
// - With the in-process lock off, any point interleaves with any other, which
//   is what two processes (the controller and the tagger child) can do.
// - With it on, the points inside a locked section are not decision points:
//   the orderings one process can produce.
// After each schedule: a trusted figure must be what a walk of the disk finds,
// and the next read must find the disk's figure either way. Each scenario logs
// how many schedules ended trusted and how many stale.
//
// Run: npm test -- stem-usage-orderings

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-stem-orderings-'));
after(async () => { await removeTempDir(stateDir); });
process.env.STATE_DIR = stateDir;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
const stemCache = await import('../src/music/stem-cache.js');
const journal = await import('../src/music/stem-usage-journal.js');

const root = stemCache.stemsRoot();
// Thousands of walks: keep their progress lines out of the output.
const log = console.log;
console.log = (...args: unknown[]) => { if (!String(args[0]).startsWith('[stem-cache]')) log(...args); };
after(() => { console.log = log; });
const GB = 1024 ** 3;

// ---- the cache -------------------------------------------------------------

function seed(): void {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(stateDir, 'stem-cache-usage.json'), { force: true });
  rmSync(join(stateDir, 'stem-cache-usage.journal'), { force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  for (const [id, n] of [['a', 1000], ['b', 1000], ['c', 2000]] as const) {
    mkdirSync(stemCache.dirFor(id), { recursive: true });
    writeFileSync(join(stemCache.dirFor(id), 'head-drums.flac'), 'x'.repeat(n));
  }
}

// What a walk of the disk finds, counted the way measureDir counts.
function disk(): { bytes: number; dirs: number } {
  let bytes = 0;
  let dirs = 0;
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    dirs += 1;
    for (const f of readdirSync(dir)) bytes += statSync(join(dir, f)).size;
  }
  return { bytes, dirs };
}

function writeFile(id: string, file: string, n: number): void {
  mkdirSync(stemCache.dirFor(id), { recursive: true });
  writeFileSync(join(stemCache.dirFor(id), file), 'y'.repeat(n));
}

// ---- the driver ------------------------------------------------------------

const als = new AsyncLocalStorage<string>();
const parked = new Map<string, () => void>();
// Points inside a locked section: with the lock on, they are not decision
// points (another actor of this process cannot run there).
const INSIDE_LOCK = new Set(['walk:remeasured', 'walk:store', 'trim:renamed', 'walk:trimmed', 'walk:stored', 'write:read']);
let lockOn = false;
let useAppendPoints = false;
// Points a scenario passes through without deciding (see the trim scenario).
let skipPoints: ReadonlySet<string> = new Set();
const trace: string[] = [];

async function gate(label: string): Promise<void> {
  const actor = als.getStore();
  if (!actor) return;
  if (label === 'walk:stored') return; // nothing of this actor follows it
  if (label.startsWith('append:') && !useAppendPoints) return;
  if (lockOn && INSIDE_LOCK.has(label)) return;
  if (skipPoints.has(label)) return;
  await new Promise<void>(resume => parked.set(actor, () => { trace.push(`${actor}:${label}`); resume(); }));
}

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`an actor never reached its next point after ${trace.join(' → ')}`);
    await new Promise(r => setImmediate(r));
  }
}

type Actors = Record<string, () => Promise<unknown>>;

// One schedule: `choices[k]` picks among the actors parked at decision k
// (sorted by name; missing = 0). Returns how many were parked at each.
async function runSchedule(actors: Actors, choices: number[]): Promise<number[]> {
  const finished = new Set<string>();
  const errors: unknown[] = [];
  parked.clear();
  trace.length = 0;
  const names = Object.keys(actors);
  for (const name of names) {
    void als.run(name, () => actors[name]()).then(
      () => { finished.add(name); },
      (err) => { errors.push(err); finished.add(name); },
    );
  }
  await until(() => names.every(n => parked.has(n) || finished.has(n)));
  const branching: number[] = [];
  while (finished.size < names.length) {
    const ready = [...parked.keys()].sort();
    const pick = ready[Math.min(choices[branching.length] ?? 0, ready.length - 1)];
    branching.push(ready.length);
    const resume = parked.get(pick)!;
    parked.delete(pick);
    resume();
    await until(() => parked.has(pick) || finished.has(pick));
  }
  if (errors.length) throw errors[0];
  return branching;
}

// The next schedule after `choices`, given the branching it saw; null when done.
function nextChoices(choices: number[], branching: number[]): number[] | null {
  const c = branching.map((_, i) => choices[i] ?? 0);
  for (let i = c.length - 1; i >= 0; i -= 1) {
    if (c[i] + 1 < branching[i]) return [...c.slice(0, i), c[i] + 1];
  }
  return null;
}

interface Outcome { schedules: number; trusted: number; stale: number }

async function enumerate(
  name: string,
  opts: { lock: boolean; trim: boolean; appendPoints?: boolean; staleFirst?: boolean; skip?: string[] },
  actors: () => Actors,
): Promise<Outcome> {
  const out: Outcome = { schedules: 0, trusted: 0, stale: 0 };
  let choices: number[] | null = [];
  while (choices) {
    seed();
    await stemCache.usage(); // a trusted figure of the seed
    if (opts.staleFirst) await stemCache.markUsageStale();
    lockOn = opts.lock;
    useAppendPoints = opts.appendPoints === true;
    skipPoints = new Set(opts.skip ?? []);
    journal._trimAboveBytesForTests(opts.trim ? 0 : null);
    stemCache._usageStepsForTests(gate, { lock: opts.lock });
    let branching: number[];
    try {
      branching = await runSchedule(actors(), choices);
    } finally {
      stemCache._usageStepsForTests(null);
      journal._trimAboveBytesForTests(null);
    }
    out.schedules += 1;
    const stored = await stemCache.storedUsage();
    const truth = disk();
    if (stored?.fresh) {
      out.trusted += 1;
      assert.deepEqual({ bytes: stored.bytes, dirs: stored.dirs }, truth,
        `${name}: trusted and wrong after ${trace.join(' → ')}`);
    } else {
      out.stale += 1;
    }
    const next = await stemCache.usage();
    assert.deepEqual({ bytes: next.bytes, dirs: next.dirs }, truth, `${name}: the next read, after ${trace.join(' → ')}`);
    choices = nextChoices(choices, branching);
  }
  console.log(`[orderings] ${name}: ${out.schedules} schedules, ${out.trusted} trusted and right, ${out.stale} stale, 0 trusted and wrong`);
  return out;
}

// ---- the actors -------------------------------------------------------------

const sweep = () => stemCache.sweep(100 * GB, { force: true });
const read = () => stemCache.usage();
// A pick-time separation of a new dir, written in two steps (head, then tail).
const separate = (id = 'p', steps = 2) => async () => {
  const writes = await stemCache.beginTrackWrite(id);
  await gate('p:head');
  writeFile(id, 'head-drums.flac', 700);
  if (steps > 1) {
    await gate('p:tail');
    writeFile(id, 'tail-drums.flac', 300);
  }
  await stemCache.settleTrackWrite(id, writes);
};
// A separation that grows an existing dir (a head-only dir gaining its tail).
const grow = (id: string) => async () => {
  const writes = await stemCache.beginTrackWrite(id);
  await gate('p:tail');
  writeFile(id, 'tail-drums.flac', 500);
  await stemCache.settleTrackWrite(id, writes);
};
const drop = (id: string) => () => stemCache.forgetStems([id]);
// What moveStemDirs does for one id rotation: both names opened, one rename.
const renameDir = (from: string, to: string) => async () => {
  const writes = new stemCache.StemDirWrites();
  await writes.touch(from);
  await writes.touch(to);
  await gate('r:rename');
  await rename(stemCache.dirFor(from), stemCache.dirFor(to));
  await writes.settle();
};

// ---- the scenarios ------------------------------------------------------------

test('one process: a separation against the hourly sweep never leaves the figure stale, in any order', async () => {
  // The case the issue measured: pick-time separations and the hourly sweep
  // both run in the controller. Before the journal, every schedule in which
  // the separation landed inside the walk ended stale.
  const o = await enumerate('controller: sweep × separation', { lock: true, trim: false }, () => ({ walk: sweep, write: separate() }));
  assert.ok(o.schedules > 20, `${o.schedules} schedules`);
  assert.equal(o.stale, 0, 'no schedule leaves the figure stale');
  const t = await enumerate('controller: sweep × separation, trimming', { lock: true, trim: true }, () => ({ walk: sweep, write: separate() }));
  assert.equal(t.stale, 0, 'nor with a trim at every store');
});

test('one process: a separation that grows an existing dir against the sweep', async () => {
  const o = await enumerate('controller: sweep × grow', { lock: true, trim: false }, () => ({ walk: sweep, write: grow('a') }));
  assert.equal(o.stale, 0);
});

test('two processes: a walk and a separation, every interleaving of every step', async () => {
  await enumerate('sweep × separation', { lock: false, trim: false }, () => ({ walk: sweep, write: separate() }));
  await enumerate('read × separation', { lock: false, trim: false, staleFirst: true }, () => ({ walk: read, write: separate() }));
  await enumerate('sweep × grow', { lock: false, trim: false }, () => ({ walk: sweep, write: grow('a') }));
});

test('two processes: a walk and forgetStems\' drop, and a walk and an id rotation\'s rename', async () => {
  await enumerate('sweep × drop', { lock: false, trim: false }, () => ({ walk: sweep, write: drop('b') }));
  await enumerate('read × drop', { lock: false, trim: false, staleFirst: true }, () => ({ walk: read, write: drop('b') }));
  await enumerate('sweep × rename', { lock: false, trim: false }, () => ({ walk: sweep, write: renameDir('c', 'c2') }));
});

test('two processes: two writers settling on one snapshot, and two writers in one dir', async () => {
  const o = await enumerate('separation × drop', { lock: false, trim: false }, () => ({ w1: separate('p', 1), w2: drop('b') }));
  assert.ok(o.trusted > 0, 'most orders settle both');
  await enumerate('grow × drop of the same dir', { lock: false, trim: false }, () => ({ w1: grow('a'), w2: drop('a') }));
});

// The trim replaces the journal. A line a writer appends between the walk's
// last read and the trim, or after the trim's rename, must reach the new
// file: copied from the old one's tail, or appended again by its writer when
// its inode check finds the path moved. Each append's open, write and check
// are decision points here, so a write into the old file after the trim
// copied its tail is run too. Points that order nothing against a trim (the
// walk before its scan ends, the writer's base measure) pass through: they
// made this scenario five times longer and caught nothing more. Undo either
// the copy or the second append and a schedule here ends trusted and wrong.
// A drop is the writer: its lines are an opening and a close, like every
// other writer's, and the trim never looks at what a dir holds.
test('two processes: a trimming walk never loses a line a writer appended around it', async () => {
  await enumerate('sweep (trims) × drop, every append', {
    lock: false, trim: true, appendPoints: true, skip: ['walk:start', 'walk:listed', 'write:based'],
  }, () => ({ walk: sweep, write: drop('b') }));
});

test('two processes: two walks, each trimming at its store', async () => {
  await enumerate('sweep × read, both trimming', { lock: false, trim: true, staleFirst: true }, () => ({ w1: sweep, w2: read }));
});
