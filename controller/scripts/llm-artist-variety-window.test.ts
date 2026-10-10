// settings.llm.artistVarietyWindow — the operator's artist-spacing dial
// (issue #1406). The station reported the same artist three times in one
// morning show, every occurrence legal: the agent path's guard only ever
// compared a pick against the artist ON AIR, so anything 2+ slots away was
// never examined, and nothing operator-facing touched artist spacing at all.
//
// A COLD-LOAD round trip rather than a clamp check, for the reason
// llm-repeat-penalty.test.ts documents: settings.load()'s llm block composes
// explicitly instead of spreading DEFAULTS, so a field missing from it still
// validates, still saves, still works for the rest of the process — then
// silently vanishes on the next restart. An in-process assertion passes on
// that bug; only a restart catches it.
//
// The guard's own decision (which cause fires, and what the re-pick may choose
// from) is pinned separately and without settings in artist-guard.test.ts.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived.
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-artist-variety-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { ARTIST_VARIETY_WINDOW } = await import('../src/broadcast/dj-agent/artist-guard.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm }));
  setCache(null);
  await settings.load();
  return settings.get().llm as Record<string, unknown>;
}

test('a configured spacing window survives a controller restart', async () => {
  assert.equal((await coldLoad({ artistVarietyWindow: 12 })).artistVarietyWindow, 12);
});

test('a stored window is clamped, and junk falls back to the default', async () => {
  assert.equal((await coldLoad({ artistVarietyWindow: 99 })).artistVarietyWindow, 25, 'ceiling');
  assert.equal((await coldLoad({ artistVarietyWindow: -4 })).artistVarietyWindow, 0, 'floor');
  assert.equal((await coldLoad({ artistVarietyWindow: 7.8 })).artistVarietyWindow, 7, 'floored, not rounded');
  // A string is not a number — the clamp refuses to guess, exactly like
  // clampNoRepeatWindow next to it.
  assert.equal(
    (await coldLoad({ artistVarietyWindow: '9' })).artistVarietyWindow,
    ARTIST_VARIETY_WINDOW,
    'a non-number falls back rather than coercing',
  );
});

test('a settings.json written before the field existed picks up the default', async () => {
  // The upgrade story: spacing turns ON, because the shipped default is the
  // window the guard was already using internally for its re-pick pool. An
  // absent key must never read as 0 — that would leave the exact on-air-only
  // behaviour #1406 was filed against, and leave it silently.
  assert.equal((await coldLoad({})).artistVarietyWindow, ARTIST_VARIETY_WINDOW);
  assert(ARTIST_VARIETY_WINDOW > 0, 'the shipped default must actually space artists out');
});

test('0 is a real value, not an absent one', async () => {
  // Operator turning spacing off is a supported choice (the back-to-back guard
  // is not disableable and does not read this). It must not be confused with
  // "unset" and quietly re-defaulted on every restart.
  assert.equal((await coldLoad({ artistVarietyWindow: 0 })).artistVarietyWindow, 0);
});

test('saving a window then restarting keeps it — the operator story', async () => {
  await coldLoad({ artistVarietyWindow: ARTIST_VARIETY_WINDOW });
  await settings.update({ llm: { artistVarietyWindow: 15 } } as never);
  assert.equal(settings.get().llm.artistVarietyWindow, 15, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.artistVarietyWindow, 15, 'and survives the restart');
});
