// The music-source form rules (#692): what counts as unsaved, what changes the
// station's track ids (and so earns the warning), and the body that is sent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MusicPluginInfo } from '../../../lib/schemas.generated';
import { blankSource, changesTrackIds, draftDirty, missingFields, selectionPayload, type SavedSelectionView } from './sourceDraft';

const jellyfin: MusicPluginInfo = {
  name: 'jellyfin',
  label: 'Jellyfin',
  description: '',
  version: '1.0.0',
  apiVersion: 1,
  idPrefix: 'jf',
  builtin: true,
  homepage: null,
  envLocked: [],
  error: null,
  config: [
    { key: 'url', label: 'Server URL', type: 'url', required: true },
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    { key: 'limit', label: 'Limit', type: 'number', default: 5 },
  ],
};

const saved: SavedSelectionView = {
  mode: 'router',
  merge: false,
  sources: [{ plugin: 'jellyfin', config: { url: 'http://jf' }, secretsSet: ['apiKey'] }],
};

test('a new source starts from the manifest defaults', () => {
  assert.deepEqual(blankSource(jellyfin), { plugin: 'jellyfin', config: { limit: 5 }, secretsSet: [] });
});

test('a stored secret satisfies a required field; an env lock does too', () => {
  assert.deepEqual(missingFields(saved.sources[0]!, jellyfin).map((f) => f.key), []);
  assert.deepEqual(missingFields({ plugin: 'jellyfin', config: {}, secretsSet: [] }, jellyfin).map((f) => f.key), ['url', 'apiKey']);
  assert.deepEqual(missingFields({ plugin: 'jellyfin', config: {}, secretsSet: [] }, { ...jellyfin, envLocked: ['url', 'apiKey'] }), []);
});

test('dirty: mode, merge, a changed field, or a typed secret', () => {
  assert.equal(draftDirty(saved, 'router', false, saved.sources), false);
  assert.equal(draftDirty(saved, 'navidrome', false, saved.sources), true);
  assert.equal(draftDirty(saved, 'router', true, saved.sources), true);
  assert.equal(draftDirty(saved, 'router', false, [{ ...saved.sources[0]!, config: { url: 'http://other' } }]), true);
  assert.equal(draftDirty(saved, 'router', false, [{ ...saved.sources[0]!, config: { url: 'http://jf', apiKey: 'new' } }]), true);
  assert.equal(draftDirty(saved, 'router', false, [{ ...saved.sources[0]!, config: { url: 'http://jf', apiKey: '' } }]), false, 'a blank secret is "keep"');
});

test('track ids change with the server, not with its password', () => {
  assert.equal(changesTrackIds(saved, 'router', [{ ...saved.sources[0]!, config: { url: 'http://jf', apiKey: 'new' } }], [jellyfin]), false);
  assert.equal(changesTrackIds(saved, 'router', [{ ...saved.sources[0]!, config: { url: 'http://elsewhere' } }], [jellyfin]), true);
  assert.equal(changesTrackIds(saved, 'navidrome', saved.sources, [jellyfin]), true);
  assert.equal(changesTrackIds({ ...saved, mode: 'navidrome' }, 'navidrome', [], [jellyfin]), false);
});

test('the payload carries only what the controller reads', () => {
  assert.deepEqual(selectionPayload('navidrome', true, saved.sources), { mode: 'navidrome' });
  assert.deepEqual(selectionPayload('router', false, saved.sources), {
    mode: 'router',
    merge: false,
    sources: [{ plugin: 'jellyfin', config: { url: 'http://jf' } }],
  });
});
