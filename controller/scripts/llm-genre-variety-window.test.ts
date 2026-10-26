// Genre-run setting: defaults, coercion and cold-load persistence.
import assert from 'node:assert/strict';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived.
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-genre-variety-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const GENRE_VARIETY_WINDOW = 0;

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(llm: Record<string, unknown>) { return (await coldLoadSettings({ llm })).llm as Record<string, unknown>; }

test('a configured genre-run limit survives a controller restart', async () => {
  assert.equal((await coldLoad({ genreVarietyWindow: 12 })).genreVarietyWindow, 12);
});

test('a stored window is clamped, and junk falls back to the default', async () => {
  assert.equal((await coldLoad({ genreVarietyWindow: 99 })).genreVarietyWindow, 25, 'ceiling');
  assert.equal((await coldLoad({ genreVarietyWindow: -4 })).genreVarietyWindow, 0, 'floor');
  assert.equal((await coldLoad({ genreVarietyWindow: 7.8 })).genreVarietyWindow, 7, 'floored, not rounded');
  // A string is not a number — the clamp refuses to guess, exactly like
  // clampNoRepeatWindow next to it.
  assert.equal(
    (await coldLoad({ genreVarietyWindow: '9' })).genreVarietyWindow,
    GENRE_VARIETY_WINDOW,
    'a non-number falls back rather than coercing',
  );
});

test('a settings.json written before the field existed picks up the default', async () => {
  assert.equal((await coldLoad({})).genreVarietyWindow, GENRE_VARIETY_WINDOW);
  assert.equal(GENRE_VARIETY_WINDOW, 0, 'upgrades must stay off');
});

test('0 is a real value, not an absent one', async () => {
  // Zero must survive saving/reloading after an operator enables the guard.
  assert.equal((await coldLoad({ genreVarietyWindow: 0 })).genreVarietyWindow, 0);
});

test('saving a window then restarting keeps it — the operator story', async () => {
  await coldLoad({ genreVarietyWindow: GENRE_VARIETY_WINDOW });
  await settings.update({ llm: { genreVarietyWindow: 15 } } as never);
  assert.equal(settings.get().llm.genreVarietyWindow, 15, 'applies immediately');

  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.genreVarietyWindow, 15, 'and survives the restart');
});
