// embedding.enrichment.lastfmTags is tri-state: true always fetches Last.fm
// tags, false never does, and null (the default) is auto, on when a Last.fm key
// is set (lastfm.lastfmEnrichEnabled). Issue #2233: update() coerced the value
// with !!, so a null it was sent stored false, and the Library form, which had
// no way to hold auto, sent false on every save. A keyed install that had never
// touched the toggle lost Last.fm enrichment the first time anyone saved that
// section, and nothing said so.
//
// Cold-load round trips throughout: update() writes settings.json and load()
// composes the field explicitly, so an in-process assertion would not show
// what a restart keeps.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived.
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-lastfm-tags-auto-'));
process.env.STATE_DIR = stateRoot;

const { STATE_DIR } = await import('../src/config.js');
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { lastfmEnrichEnabled } = await import('../src/music/lastfm.js');

test.after(() => removeTempDir(stateRoot));

async function restart() {
  setCache(null);
  await settings.load();
  return settings.get().embedding.enrichment;
}

const stored = () =>
  JSON.parse(readFileSync(path.join(STATE_DIR, 'settings.json'), 'utf8')).embedding.enrichment.lastfmTags;

test('a Library save that keeps Auto keeps it across a restart', async () => {
  assert.equal((await coldLoadSettings({})).embedding.enrichment.lastfmTags, null, 'unset is auto');

  // The whole enrichment block, as LibrarySection posts it after an edit to
  // Lyrics alone, with Last.fm tags left on Auto.
  await settings.update({ embedding: { enrichment: { lastfmTags: null, lastfmTrackTags: false, lyrics: false } } });
  assert.equal(stored(), null, 'settings.json holds auto, not false');

  const en = await restart();
  assert.equal(en.lastfmTags, null);
  assert.equal(en.lyrics, false, 'the edit that was made still lands');
  assert.equal(lastfmEnrichEnabled(en.lastfmTags, true), true, 'a keyed install still enriches');
});

test('an explicit off can go back to Auto', async () => {
  await coldLoadSettings({ embedding: { enrichment: { lastfmTags: false } } });
  await settings.update({ embedding: { enrichment: { lastfmTags: null } } });
  assert.equal((await restart()).lastfmTags, null);
});

test('on and off are stored as before, and other values still coerce', async () => {
  for (const [sent, kept] of [[true, true], [false, false], [1, true], [0, false], ['', false]] as const) {
    await coldLoadSettings({});
    await settings.update({ embedding: { enrichment: { lastfmTags: sent } } });
    assert.equal((await restart()).lastfmTags, kept, `sent ${JSON.stringify(sent)}`);
  }
});

test('a patch without the field leaves a stored off alone: no migration', async () => {
  assert.equal((await coldLoadSettings({ embedding: { enrichment: { lastfmTags: false } } })).embedding.enrichment.lastfmTags, false);
  await settings.update({ embedding: { enrichment: { lyrics: false } } });
  assert.equal((await restart()).lastfmTags, false);
});
