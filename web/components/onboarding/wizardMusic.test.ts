// The wizard's music step against the station's saved selection (#1827
// review): choosing Navidrome on a router station used to store credentials
// and leave the station on the router, while Review said "Navidrome".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { musicFromSaved, musicSaveBody, type WizardMusic } from './wizardMusic';

const fresh: WizardMusic = { mode: 'navidrome', sources: [], label: '', saved: null };
const creds = { url: 'http://nd:4533', user: 'u', pass: 'p' };
const jf = { plugin: 'jellyfin', config: { url: 'http://jf' }, secretsSet: ['apiKey'] };

test('a station on one router source opens on it', () => {
  const m = musicFromSaved(fresh, { mode: 'router', merge: false, sources: [jf] }, 'Jellyfin');
  assert.deepEqual(m, { mode: 'router', sources: [jf], label: 'Jellyfin', saved: 'router' });
  // Clicking through re-sends that selection; its stored key stays on the server side.
  assert.deepEqual(musicSaveBody(m, creds), { music: { mode: 'router', merge: false, sources: [{ plugin: 'jellyfin', config: { url: 'http://jf' } }] } });
});

test('choosing Navidrome on a router station switches it back', () => {
  const m = musicFromSaved(fresh, { mode: 'router', merge: false, sources: [jf] }, 'Jellyfin');
  const chosen: WizardMusic = { ...m, mode: 'navidrome', label: '' };
  assert.deepEqual(musicSaveBody(chosen, creds), { navidrome: creds, music: { mode: 'navidrome' } });
});

test('a Navidrome station sends credentials only, exactly as before', () => {
  const m = musicFromSaved(fresh, { mode: 'navidrome', merge: false, sources: [] }, '');
  assert.equal(m.saved, 'navidrome');
  assert.deepEqual(musicSaveBody(m, creds), { navidrome: creds });
  // And when the saved selection could not be read.
  assert.deepEqual(musicSaveBody(fresh, creds), { navidrome: creds });
});

test('a merged station is not collapsed into one source, and an edited wizard is left alone', () => {
  const merged = musicFromSaved(fresh, { mode: 'router', merge: true, sources: [jf, { plugin: 'mock', config: {}, secretsSet: [] }] }, 'Jellyfin');
  assert.equal(merged.mode, 'navidrome');
  assert.equal(merged.saved, 'router');
  const edited: WizardMusic = { mode: 'router', sources: [{ plugin: 'plex', config: {}, secretsSet: [] }], label: 'Plex', saved: null };
  assert.deepEqual(musicFromSaved(edited, { mode: 'router', merge: false, sources: [jf] }, 'Jellyfin'), { ...edited, saved: 'router' });
});
