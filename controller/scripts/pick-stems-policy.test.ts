// Pick-time stems policy (#2197, broadcast/pick-stems-policy.ts) and the
// setting that turns it on (`transitions.pickTimeStems`).
//
// The policy is pure, so every veto is pinned here against a fact sheet that
// otherwise says "go", along with the budget's overshoot bound, the request
// deadline, the render's stand-down and the once-per-change notices. The runner's IO and the drain's trigger are pinned by
// scripts/pick-stems.test.ts and scripts/pick-stems-drain.test.ts.
//
// The setting is pinned with a cold load (controller/CLAUDE.md): load()
// composes each block explicitly, so a field missing there saves and works
// until the next restart, then silently vanishes.
//
// Run: `npm test -- pick-stems-policy`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { coldLoadSettings } from './test-utils/settings.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-pick-stems-policy-'));
process.env.STATE_DIR = stateRoot;

const policy = await import('../src/broadcast/pick-stems-policy.js');
const { quietOnlyEnabled } = await import('../src/music/analyze-quiet-pure.js');
const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');

const GO: import('../src/broadcast/pick-stems-policy.js').PickStemsStation = {
  enabled: true,
  stemBlends: true,
  stemCache: true,
  pairDrainActive: true,
  held: true,
  quietOnly: false,
};

// ---- station --------------------------------------------------------------

test('station: every gate open lets it through', () => {
  assert.equal(policy.stationVeto(GO), null);
  assert.equal(policy.busyVeto({ bulkPassRunning: false, inFlight: false }), null);
});

test('station: each gate on its own turns it away, with its own reason', () => {
  assert.equal(policy.stationVeto({ ...GO, enabled: false }), 'off');
  assert.equal(policy.stationVeto({ ...GO, stemBlends: false }), 'no-blends');
  assert.equal(policy.stationVeto({ ...GO, stemCache: false }), 'no-cache');
  assert.equal(policy.stationVeto({ ...GO, pairDrainActive: false }), 'no-pair-drain');
  assert.equal(policy.stationVeto({ ...GO, held: false }), 'not-held');
  assert.equal(policy.stationVeto({ ...GO, quietOnly: true }), 'quiet-only');
  assert.equal(policy.busyVeto({ bulkPassRunning: true, inFlight: false }), 'bulk-pass');
  assert.equal(policy.busyVeto({ bulkPassRunning: false, inFlight: true }), 'in-flight');
});

test('station: off is the first answer, so a station without the feature reads nothing else', () => {
  assert.equal(policy.stationVeto({
    enabled: false, stemBlends: false, stemCache: false, pairDrainActive: false, held: false, quietOnly: true,
  }), 'off');
});

test('quiet-only: the setting, or ANALYZE_QUIET_ONLY switching it on (never off)', () => {
  assert.equal(quietOnlyEnabled(undefined, { analyzeQuietOnly: true }), true);
  assert.equal(quietOnlyEnabled(undefined, { analyzeQuietOnly: false }), false);
  assert.equal(quietOnlyEnabled(undefined, null), false);
  assert.equal(quietOnlyEnabled('1', { analyzeQuietOnly: false }), true);
  assert.equal(quietOnlyEnabled('YES', undefined), true);
  assert.equal(quietOnlyEnabled('0', { analyzeQuietOnly: true }), true, 'env never switches it off');
  assert.equal(quietOnlyEnabled(undefined, { analyzeQuietOnly: 'yes' }), false, 'only a real true counts');
});

// ---- analyzer -------------------------------------------------------------

test('analyzer: only a backend that reported both facets and Demucs', () => {
  assert.equal(policy.analyzerVeto({ facets: true, demucs: true }), null);
  assert.equal(policy.analyzerVeto({ facets: null, demucs: true }), 'no-facets');
  assert.equal(policy.analyzerVeto({ facets: false, demucs: true }), 'no-facets');
  assert.equal(policy.analyzerVeto({ facets: true, demucs: null }), 'no-demucs');
  assert.equal(policy.analyzerVeto({ facets: true, demucs: false }), 'no-demucs');
});

// ---- track ----------------------------------------------------------------

const BOTH = { hasHeadGrid: true, hasTailGrid: true, hasHead: false, hasTail: false };

test('track: no grid at all is an unanalysed track, never measured here', () => {
  assert.equal(policy.trackNeed({ ...BOTH, hasHeadGrid: false, hasTailGrid: false }), 'no-grid');
});

test('track: a window is wanted only when its grid exists and the cache lacks it', () => {
  assert.deepEqual(policy.trackNeed(BOTH), { head: true, tail: true });
  assert.deepEqual(policy.trackNeed({ ...BOTH, hasHead: true }), { head: false, tail: true });
  assert.deepEqual(policy.trackNeed({ ...BOTH, hasTail: true }), { head: true, tail: false });
  // A head without its grid is bytes the render rejects.
  assert.deepEqual(policy.trackNeed({ ...BOTH, hasHeadGrid: false }), { head: false, tail: true });
  assert.equal(policy.trackNeed({ ...BOTH, hasHead: true, hasTail: true }), 'cached');
  assert.equal(policy.trackNeed({ ...BOTH, hasTailGrid: false, hasHead: true }), 'cached');
});

test('after download: a truncated file only stops a tail-only separation', () => {
  assert.equal(policy.afterDownload({ head: true, tail: true }, false), null, 'the head still lands');
  assert.equal(policy.afterDownload({ head: true, tail: false }, false), null);
  assert.equal(policy.afterDownload({ head: false, tail: true }, true), null);
  assert.equal(policy.afterDownload({ head: false, tail: true }, false), 'truncated');
});

test('describeNeed names the windows for the log line', () => {
  assert.equal(policy.describeNeed({ head: true, tail: true }), 'head + tail');
  assert.equal(policy.describeNeed({ head: true, tail: false }), 'head');
  assert.equal(policy.describeNeed({ head: false, tail: true }), 'tail');
});

// ---- the budget -----------------------------------------------------------

const GiB = 1024 ** 3;
const MB = 1024 ** 2;

test('budget: the allowance is an hour of picks, capped at 5% of the budget, never under one dir', () => {
  // The default 15 GB budget at a measured 15 MB a dir: 20 dirs, about 2%.
  assert.equal(policy.overshootAllowanceBytes(15 * GiB, 15 * MB), 20 * 15 * MB);
  // The 1 GB floor at the cold 25 MB guess: 20 dirs would be half the budget.
  assert.equal(policy.overshootAllowanceBytes(1 * GiB, 25 * MB), 0.05 * GiB);
  // Dirs bigger than 5% of the budget: still one, so the cache turns over.
  assert.equal(policy.overshootAllowanceBytes(1 * GiB, 60 * MB), 60 * MB);
});

test('budget: a full cache still takes a pick, up to the allowance', () => {
  const at = (usedBytes: number) => policy.budgetVeto({ usedBytes, budgetBytes: 15 * GiB, estTrackBytes: 15 * MB });
  const allowance = policy.overshootAllowanceBytes(15 * GiB, 15 * MB);
  assert.equal(at(0), null);
  assert.equal(at(15 * GiB), null, 'exactly full: the steady state after a backfill');
  assert.equal(at(15 * GiB + allowance - 1), null);
  assert.equal(at(15 * GiB + allowance), 'budget-full');
  assert.equal(at(40 * GiB), 'budget-full', 'a budget just lowered under the cache');
});

test('budget: many picks between two sweeps never pass budget + allowance + one dir', () => {
  for (const [budget, est, dir] of [
    [15 * GiB, 15 * MB, 15 * MB],
    [15 * GiB, 15 * MB, 40 * MB], // dirs bigger than the average
    [1 * GiB, 25 * MB, 8 * MB],
    [1 * GiB, 60 * MB, 60 * MB],
  ]) {
    let used = budget; // the backfill filled it
    let admitted = 0;
    for (let pick = 0; pick < 500; pick++) {
      if (policy.budgetVeto({ usedBytes: used, budgetBytes: budget, estTrackBytes: est })) continue;
      used += dir; // at most one dir a separation, settled before the next
      admitted += 1;
    }
    const allowance = policy.overshootAllowanceBytes(budget, est);
    assert.ok(admitted >= 1, 'a full cache always turns over at least one pick');
    assert.ok(used - budget <= allowance + dir, `${budget}/${est}/${dir}: ${used - budget} over`);
    assert.equal(admitted, Math.ceil(allowance / dir));
  }
});

// ---- the sweep ------------------------------------------------------------

test('sweep: queued tracks are kept last only while pick-time stems is on', () => {
  assert.equal(policy.sweepKeepLast({ enabled: false, queuedTrackIds: ['held', 'next'] }), undefined,
    'off: no set, so both sweeps keep their plain order');
  assert.equal(policy.sweepKeepLast({ enabled: true, queuedTrackIds: [] }), undefined, 'nothing queued');
  assert.deepEqual(
    [...policy.sweepKeepLast({ enabled: true, queuedTrackIds: ['held', null, '', undefined, 7, 'next', 'held'] })!],
    ['held', 'next'],
    'an item without a track id (a jingle, a clip) is skipped',
  );
});

test('sweep: the queue snapshot gives its queued track ids, and anything else none', () => {
  assert.deepEqual(policy.queuedTrackIdsFromSnapshot({
    upcoming: [{ track: { id: 'held', title: 'Held' } }, { track: { title: 'no id' } }, null, { track: { id: 'next' } }],
    current: { track: { id: 'on-air' } },
  }), ['held', 'next'], 'upcoming only: the track on air has a play row already');
  for (const bad of [null, undefined, 'x', 42, {}, { upcoming: 'x' }, { upcoming: null }]) {
    assert.deepEqual(policy.queuedTrackIdsFromSnapshot(bad), [], JSON.stringify(bad));
  }
});

// ---- the request ----------------------------------------------------------

test('request: its deadline outlasts the slowest measured separation and the pass\'s own', () => {
  assert.equal(policy.requestDeadlineMs(120_000), 300_000);
  assert.ok(policy.requestDeadlineMs(120_000) > 176_000, 'head + tail measured 176 s on 2 CPUs, cold');
  // An operator who raised the pass's deadline never gets a shorter one here.
  assert.equal(policy.requestDeadlineMs(600_000), 600_000);
});

// ---- the render -----------------------------------------------------------

test('render: stands down for a separation only when no pool member is spare', () => {
  const at = (separating: boolean, backend: string, concurrency: number) =>
    policy.renderStandsDown({ separating, backend, concurrency });
  assert.equal(at(false, 'sidecar', 1), false, 'nothing separating: nothing to wait behind');
  assert.equal(at(true, 'sidecar', 1), true);
  assert.equal(at(true, 'sidecar', 2), false, 'a spare member serves it at once');
  assert.equal(at(true, 'sidecar', 8), false);
  assert.equal(at(true, 'local', 2), true, 'a local stdio worker is single-flight whatever the setting');
  assert.equal(at(true, 'none', 2), true);
});

test('render: the pool is the smaller of the controller\'s figure and the sidecar\'s (#2253)', () => {
  const at = (concurrency: number, sidecarConcurrency: number | null | undefined) =>
    policy.renderStandsDown({ separating: true, backend: 'sidecar', concurrency, sidecarConcurrency });
  assert.equal(at(2, 1), true, 'a controller set higher than its sidecar: no spare member');
  assert.equal(at(4, 2), false);
  assert.equal(at(1, 4), true, 'the controller\'s own setting still caps it');
  assert.equal(at(2, null), false, 'an older sidecar reports none: the controller\'s figure, as before');
  assert.equal(at(2, undefined), false);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(policy.renderPoolSize({ concurrency: 2, sidecarConcurrency: bad }), 2);
  assert.equal(policy.renderStandsDown({ separating: false, backend: 'sidecar', concurrency: 2, sidecarConcurrency: 1 }), false);
});

test('request: the tail alone when only the tail is missing (#2253)', () => {
  assert.deepEqual(policy.stemsWindowsFor({ head: false, tail: true }), ['tail']);
  assert.equal(policy.stemsWindowsFor({ head: true, tail: true }), undefined, 'both: the field is not sent');
  assert.equal(policy.stemsWindowsFor({ head: true, tail: false }), undefined,
    'a head to fill: both, so an older worker and a newer one do the same');
});

// ---- notices --------------------------------------------------------------

test('notices: one line when a station-level reason first applies, none per pick', () => {
  const said: Array<string | null> = [];
  let last: import('../src/broadcast/pick-stems-policy.js').PickStemsNotice | null = null;
  const step = (s: import('../src/broadcast/pick-stems-policy.js').PickStemsStep) => {
    const r = policy.noticeStep(last, s);
    last = r.last;
    said.push(r.say);
  };
  step({ ran: false, veto: 'no-demucs' });
  step({ ran: false, veto: 'no-demucs' });
  step({ ran: false, veto: 'cached' }); // a track-level answer between them
  step({ ran: false, veto: 'no-demucs' });
  step({ ran: false, veto: 'no-facets' }); // a change is said
  step({ ran: false, veto: null }); // a failed download
  step({ ran: false, veto: 'no-facets' });
  assert.deepEqual(said, ['no-demucs', null, null, null, 'no-facets', null, null]);
});

test('notices: a separation, or the feature switched off, clears it, so the next onset is said', () => {
  let r = policy.noticeStep(null, { ran: false, veto: 'budget-full' });
  assert.equal(r.say, 'budget-full');
  r = policy.noticeStep(r.last, { ran: true }); // the sweep made room
  assert.deepEqual(r, { say: null, last: null });
  r = policy.noticeStep(r.last, { ran: false, veto: 'budget-full' });
  assert.equal(r.say, 'budget-full');
  r = policy.noticeStep(r.last, { ran: false, veto: 'off' });
  assert.deepEqual(r, { say: null, last: null });
});

test('notices: quiet-only is said only when the env forces it, since the Stems page shows the setting', () => {
  assert.equal(policy.noticeStep(null, { ran: false, veto: 'quiet-only', quietOnlyFromEnv: false }).say, null);
  assert.equal(policy.noticeStep(null, { ran: false, veto: 'quiet-only', quietOnlyFromEnv: true }).say, 'quiet-only-env');
  for (const v of ['no-blends', 'no-cache', 'no-pair-drain', 'not-held', 'bulk-pass', 'in-flight', 'no-grid',
    'cached', 'root-offline', 'truncated'] as const) {
    assert.equal(policy.noticeStep(null, { ran: false, veto: v }).say, null, v);
  }
  for (const n of ['budget-full', 'no-demucs', 'no-facets', 'quiet-only-env'] as const) {
    assert.match(policy.NOTICE_MESSAGES[n], /^pick-time stems: /);
  }
});

// ---- the setting ----------------------------------------------------------

test('setting: off by default, so an upgrade changes nothing', async () => {
  assert.equal(DEFAULTS.transitions.pickTimeStems, false);
  assert.equal((await coldLoadSettings({})).transitions.pickTimeStems, false);
});

test('setting: a saved true survives a cold load', async () => {
  await coldLoadSettings({});
  await settings.update({ transitions: { pickTimeStems: true } });
  assert.equal(settings.get().transitions.pickTimeStems, true);
  // The restart: settings.json as update() wrote it, read back from disk.
  const { readFileSync } = await import('node:fs');
  const stored = JSON.parse(readFileSync(path.join(stateRoot, 'settings.json'), 'utf8'));
  assert.equal((await coldLoadSettings(stored)).transitions.pickTimeStems, true);
});

test('setting: anything but a boolean loads as off', async () => {
  for (const bad of ['yes', 1, null, {}]) {
    const t = (await coldLoadSettings({ transitions: { pickTimeStems: bad } })).transitions;
    assert.equal(t.pickTimeStems, false, `stored ${JSON.stringify(bad)}`);
  }
});

test('setting: a patch touching a sibling leaves it alone', async () => {
  await coldLoadSettings({ transitions: { pickTimeStems: true } });
  await settings.update({ transitions: { stemBlends: true } });
  assert.equal(settings.get().transitions.pickTimeStems, true);
});
