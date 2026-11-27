// The music-source form rules (#692): what counts as unsaved, what changes the
// station's track ids (and so earns the warning), and the body that is sent.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MusicPluginInfo } from '../../../lib/schemas.generated';
import {
  ADVANCED,
  blankSource,
  changesTrackIds,
  choiceOf,
  draftDirty,
  missingFields,
  seedableSources,
  selectionLabel,
  selectionPayload,
  sourceOptions,
  type SavedSelectionView,
} from './sourceDraft';

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

// ── the source picker ──

const plugin = (name: string, over: Partial<MusicPluginInfo> = {}): MusicPluginInfo => ({ ...jellyfin, name, label: name[0]!.toUpperCase() + name.slice(1), config: [], ...over });

test('the picker lists direct Navidrome first, the router twin nowhere, and the demo last', () => {
  const opts = sourceOptions(
    [plugin('mock', { label: 'Demo library' }), plugin('folder', { builtin: false, description: 'Files in a folder' }), plugin('plex'), plugin('navidrome'), plugin('jellyfin'), plugin('broken', { error: 'bad manifest' })],
    null,
  );
  assert.deepEqual(opts.map((o) => o.id), ['navidrome', 'jellyfin', 'plex', 'folder', 'mock']);
  assert.equal(opts[0]!.tag, 'recommended');
  assert.deepEqual([opts[3]!.tag, opts[3]!.blurb], ['installed', 'Files in a folder']);
  assert.equal(opts[4]!.tag, 'no setup');
  assert.ok(opts.every((o) => !o.disabled));
});

test('with the router down its sources still show, disabled with the reason', () => {
  const opts = sourceOptions(null, 'connect ECONNREFUSED');
  assert.deepEqual(opts.map((o) => o.id), ['navidrome', 'jellyfin', 'plex', 'mock']);
  assert.equal(opts[0]!.disabled, undefined);
  assert.match(opts[1]!.disabled ?? '', /not answering \(connect ECONNREFUSED\)/);
});

test('a selection is its card: direct, one router source, or Advanced for a merge or routed Navidrome', () => {
  const src = (p: string) => ({ plugin: p, config: {}, secretsSet: [] });
  assert.equal(choiceOf({ mode: 'navidrome', merge: false, sources: [src('jellyfin')] }), 'navidrome');
  assert.equal(choiceOf({ mode: 'router', merge: false, sources: [src('jellyfin')] }), 'jellyfin');
  assert.equal(choiceOf({ mode: 'router', merge: false, sources: [src('navidrome')] }), ADVANCED);
  assert.equal(choiceOf({ mode: 'router', merge: true, sources: [src('jellyfin'), src('plex')] }), ADVANCED);
  assert.equal(selectionLabel({ mode: 'router', sources: [src('jellyfin'), src('mock')] }, [jellyfin]), 'Jellyfin + Demo library');
  assert.equal(selectionLabel({ mode: 'navidrome', sources: [] }, null), 'Navidrome');
});
