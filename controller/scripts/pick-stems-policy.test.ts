// Pick-time stems policy (#2197, broadcast/pick-stems-policy.ts) and the
// setting that turns it on (`transitions.pickTimeStems`).
//
// The policy is pure, so every veto is pinned here against a fact sheet that
// otherwise says "go". The runner's IO and the drain's trigger are pinned by
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
