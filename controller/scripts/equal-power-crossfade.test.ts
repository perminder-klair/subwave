// settings.transitions.equalPowerCrossfade — the boolean that selects the fade
// curve PLAIN song-to-song crossfades use. false = linear (today's behaviour,
// byte-identical on upgrade); true = equal-power (cos out, sin^1.5 in), which removes
// the ~3 dB dip mid-crossfade. Effects, stem-blend clip seams, jingles, beds
// and pause breaks always keep their own curves.
//
// Read by the mixer ONCE at startup (liquidsoap_equal_power_crossfade.txt), so
// a change needs a mixer restart — same lifecycle as the crossfade duration and
// the two duck depths.
//
// Four halves are pinned, because each fails silently:
//
//   1. The DEFAULT is false. An upgrade must not flip the curve on every
//      station, so the absent-key case IS the upgrade case.
//
//   2. The setting survives a controller restart. settings.load() composes each
//      block explicitly rather than spreading DEFAULTS, so a field missing from
//      load() saves fine within one process and then vanishes on the next cold
//      start. (Same class as duck-depth #1485.)
//
//   3. Non-boolean stored values load as false. The mixer side only accepts the
//      literal "true"; the controller side coerces === true. A stored "yes" or 1
//      must not silently select equal-power.
//
//   4. The restart flag is gated per-field. The panel posts the whole block on
//      every save, so an idempotent write must NOT raise a restart banner, and a
//      patch that touches only a sibling key must not either.
//
// Plus the writer: the file must contain "true" or "false", never "" or
// "undefined" — radio.liq compares against the literal string.
//
// No containers and no network.
//
// Run: `npm test -- equal-power-crossfade`.

import assert from 'node:assert/strict';
import { coldLoadSettings } from './test-utils/settings.js';
import { existsSync, readFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/duck-depth.test.ts).
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-eq-crossfade-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { LIQ_EQUAL_POWER_CROSSFADE_PATH } = await import('../src/settings/liquidsoap.js');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(transitions: Record<string, unknown> | undefined) {
  return (await coldLoadSettings(transitions === undefined ? {} : { transitions })).transitions;
}

// ---------------------------------------------------------------------------
// 1. The default is linear (false)
// ---------------------------------------------------------------------------

test('an absent block coerces to linear', async () => {
  const t = await coldLoad(undefined);
  assert.equal(t.equalPowerCrossfade, false);
  assert.equal(DEFAULTS.transitions.equalPowerCrossfade, false);
});

// ---------------------------------------------------------------------------
// 2. The setting survives a controller restart
// ---------------------------------------------------------------------------

test('a stored true survives a cold load', async () => {
  const t = await coldLoad({ equalPowerCrossfade: true });
  assert.equal(t.equalPowerCrossfade, true);
});

test('a stored false survives a cold load', async () => {
  const t = await coldLoad({ equalPowerCrossfade: false });
  assert.equal(t.equalPowerCrossfade, false);
});

// ---------------------------------------------------------------------------
// 3. Non-boolean values load as false (absent/malformed = linear)
// ---------------------------------------------------------------------------

test('a non-boolean stored value loads as linear', async () => {
  for (const bad of ['yes', 1, 'true', 'false', null, {}, []]) {
    const t = await coldLoad({ equalPowerCrossfade: bad });
    assert.equal(
      t.equalPowerCrossfade,
      false,
      `stored transitions.equalPowerCrossfade=${JSON.stringify(bad)} should fall back to false`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. The restart flag: gated per-field
// ---------------------------------------------------------------------------

test('enabling equal-power asks for a mixer restart', async () => {
  await coldLoad({ equalPowerCrossfade: false });
  // The file is read ONCE at mixer startup, so a change that does not bounce
  // the container is a change the listener never hears.
  const changed = await settings.update({ transitions: { equalPowerCrossfade: true } });
  assert.equal(changed.requiresRestart, true);
  // …and an idempotent save must NOT: the panel posts the whole block, so
  // without per-field change gating every save in the Transitions section
  // would raise a restart banner.
  const same = await settings.update({ transitions: { equalPowerCrossfade: true } });
  assert.equal(same.requiresRestart, false);
});

test('disabling equal-power asks for a mixer restart', async () => {
  await coldLoad({ equalPowerCrossfade: true });
  const changed = await settings.update({ transitions: { equalPowerCrossfade: false } });
  assert.equal(changed.requiresRestart, true);
});

test('a patch touching only a sibling key leaves equalPowerCrossfade unchanged and does not flag a restart', async () => {
  await coldLoad({ equalPowerCrossfade: true });
  // The panel posts the whole transitions block; a save that changes only
  // pairDrain must not raise a restart banner for the crossfade curve.
  const patched = await settings.update({ transitions: { pairDrain: false } });
  assert.equal(settings.get().transitions.equalPowerCrossfade, true);
  assert.equal(patched.requiresRestart, false);
});

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

test('the handoff file contains "true" after enabling', async () => {
  await coldLoad({ equalPowerCrossfade: false });
  await settings.update({ transitions: { equalPowerCrossfade: true } });
  assert.ok(existsSync(LIQ_EQUAL_POWER_CROSSFADE_PATH), 'liquidsoap_equal_power_crossfade.txt not written');
  assert.equal(readFileSync(LIQ_EQUAL_POWER_CROSSFADE_PATH, 'utf8'), 'true');
});

test('the handoff file contains "false" after disabling', async () => {
  await coldLoad({ equalPowerCrossfade: true });
  await settings.update({ transitions: { equalPowerCrossfade: false } });
  assert.equal(readFileSync(LIQ_EQUAL_POWER_CROSSFADE_PATH, 'utf8'), 'false');
});

test('the default station writes "false", not an empty file', async () => {
  // The upgrade path: a station that never touches this setting still has the
  // file rewritten on its next unrelated save, and radio.liq's string
  // comparison must find "false" rather than '' or 'undefined'.
  await coldLoad(undefined);
  await settings.update({ station: 'SUB/WAVE test' });
  assert.equal(readFileSync(LIQ_EQUAL_POWER_CROSSFADE_PATH, 'utf8'), 'false');
});
