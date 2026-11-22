// The music-source form rules (#692): what counts as unsaved, what changes the
// station's track ids (and so earns the warning), and the body that is sent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MusicPluginInfo } from '../../../lib/schemas.generated';
import { blankSource, changesTrackIds, draftDirty, missingFields, seedableSources, selectionPayload, type SavedSelectionView } from './sourceDraft';

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
  capabilities: null,
  devOnly: false,
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

// #1827 review: with the router down, the controller hides every setting of a
// saved source (it cannot tell a URL from a secret without the manifest). A
// draft seeded from that answer, saved once the router was back, dropped every
// optional setting.
test('the draft waits for an answer that carries the router manifests', () => {
  const masked = { mode: 'router' as const, merge: false, sources: [{ plugin: 'plex', config: {}, secretsSet: ['url', 'section'] }] };
  assert.equal(seedableSources({ ...masked, router: null }), null);
  const full = { ...masked, sources: [{ plugin: 'plex', config: { url: 'http://px', section: '3' }, secretsSet: ['token'] }] };
  assert.deepEqual(seedableSources({ ...full, router: { plugins: [] } }), full.sources);
  assert.deepEqual(seedableSources({ mode: 'navidrome', merge: false, sources: [], router: null }), [], 'nothing saved, nothing to wait for');
});

// The warning is the controller's own rule (musicSelectionIdentity), so a
// manifest's affectsIds marks decide it on both sides.
test('the id-change warning follows the manifest marks', () => {
  const plex = { ...jellyfin, name: 'plex', config: [
    { key: 'url', label: 'URL', type: 'url' as const, affectsIds: true },
    { key: 'token', label: 'Token', type: 'secret' as const },
    { key: 'sonicSimilarity', label: 'Sonic', type: 'boolean' as const, affectsIds: false },
  ] };
  const view = { mode: 'router' as const, merge: false, sources: [{ plugin: 'plex', config: { url: 'http://px', sonicSimilarity: true }, secretsSet: ['token'] }] };
  assert.equal(changesTrackIds(view, 'router', [{ ...view.sources[0]!, config: { url: 'http://px', sonicSimilarity: false } }], [plex]), false, 'a toggle');
  assert.equal(changesTrackIds(view, 'router', [{ ...view.sources[0]!, config: { url: 'http://px2', sonicSimilarity: true } }], [plex]), true, 'a new server');
});

test('the Navidrome source plays the station connection, so the draft asks nothing of it', () => {
  const navidrome = { ...jellyfin, name: 'navidrome', label: 'Navidrome', config: [{ key: 'url', label: 'Server URL', type: 'url' as const, required: true }] };
  assert.deepEqual(missingFields({ plugin: 'navidrome', config: {}, secretsSet: [] }, navidrome), []);
});

test('the default and direct Navidrome are the same library; another source is not', () => {
  const dflt: SavedSelectionView = { mode: 'router', merge: false, sources: [{ plugin: 'navidrome', config: {}, rawIds: true, secretsSet: [] }] };
  assert.equal(changesTrackIds(dflt, 'navidrome', [], [jellyfin]), false, 'going direct keeps every id');
  assert.equal(changesTrackIds(dflt, 'router', [{ plugin: 'jellyfin', config: { url: 'http://jf' }, secretsSet: [] }], [jellyfin]), true);
});
