// settings.beds.requestIntros — front-padding a listener request's intro with
// a bed instead of talking over the song's opening (#1465).
//
// A COLD-LOAD round trip, not an in-process assertion: settings.load()'s beds
// block composes explicitly rather than spreading DEFAULTS, so a field missing
// from that composition still validates, still saves, still works for the rest
// of the process — and then silently vanishes on the next restart, with the
// feature reverting to the downstream default and nothing in the logs. That is
// the failure #1317 and #1327 both shipped; the assertions below only catch it
// because setCache(null) forces a real re-read from disk.
//
// The other half of the contract is the ABSENT case. Beds are off by default,
// so a fresh station is unchanged either way; but a station already running
// beds has a settings.json written before this key existed, and what it reads
// as decides whether that station's behaviour changes at upgrade. It reads as
// ON — a deliberate behaviour change, pinned here so it can't drift silently
// in either direction.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/llm-repeat-penalty.test.ts).
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-beds-request-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { bedWanted } = await import('../src/broadcast/bed-policy.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(beds: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ beds }));
  setCache(null);
  await settings.load();
  return settings.get().beds;
}

test('requestIntros survives a controller restart', async () => {
  assert.equal((await coldLoad({ enabled: true, requestIntros: false })).requestIntros, false);
  assert.equal((await coldLoad({ enabled: true, requestIntros: true })).requestIntros, true);
});

test('a requestIntros-only settings patch persists without changing beds.enabled', async () => {
  await coldLoad({ enabled: true, requestIntros: false, thresholdSec: 12, crossSec: 6 });
  const result = await settings.update({ beds: { requestIntros: true } });
  assert.equal(result.saved.beds.enabled, true);
  assert.equal(result.saved.beds.requestIntros, true);

  setCache(null);
  await settings.load();
  assert.equal(settings.get().beds.enabled, true);
  assert.equal(settings.get().beds.requestIntros, true);
});

test('a settings.json written before the key existed reads as on', async () => {
  // The upgrade case: beds already enabled, no requestIntros key on disk.
  const beds = await coldLoad({ enabled: true, thresholdSec: 20 });
  assert.equal(beds.requestIntros, true);
  // The neighbours it composes alongside are untouched.
  assert.equal(beds.enabled, true);
  assert.equal(beds.thresholdSec, 20);
});

test('beds off means requestIntros can never fire, whatever it says', async () => {
  // requestIntros is a sub-switch, not a second way in — maybePushBed returns
  // on `!cfg.enabled` before it is ever read. Pinned at the settings layer
  // because the value stays true here and only the ORDER of the two gates
  // keeps a beds-off station silent.
  const beds = await coldLoad({ enabled: false, requestIntros: true });
  assert.equal(beds.enabled, false);
  assert.equal(beds.requestIntros, true);
});

test('a non-boolean requestIntros falls back to the default, never wedges load', async () => {
  // Hand-edited settings.json: the load path repairs rather than throws, the
  // same posture as every other boolean in the block.
  assert.equal((await coldLoad({ enabled: true, requestIntros: 'yes' })).requestIntros, true);
  assert.equal((await coldLoad({ enabled: true, requestIntros: null })).requestIntros, true);
});

test('the loaded block is a usable BedOpts for the policy it gates', async () => {
  // settings.beds is passed to bedWanted() verbatim as its opts (queue.ts
  // maybePushBed), so the cold-loaded shape has to satisfy it — a request beds
  // regardless of length, a link still answers to the threshold.
  const beds = await coldLoad({ enabled: true, thresholdSec: 12, crossSec: 6 });
  assert.equal(bedWanted(3_000, null, beds, 'request'), true);
  assert.equal(bedWanted(3_000, null, beds, 'link'), false);
});
