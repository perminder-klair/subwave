// The wizard's music step against the station's saved selection (#1827
// review): choosing Navidrome on a station playing another source used to
// store credentials and leave it there, while Review said "Navidrome".

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

test('choosing Navidrome on a station playing another source sends it back to the default', () => {
  const m = musicFromSaved(fresh, { mode: 'router', merge: false, sources: [jf] }, 'Jellyfin');
  const chosen: WizardMusic = { ...m, mode: 'navidrome', label: '' };
  // Its Navidrome, through the music router — not the direct escape hatch.
  assert.deepEqual(musicSaveBody(chosen, creds), {
    navidrome: creds,
    music: { mode: 'router', merge: false, sources: [{ plugin: 'navidrome', config: {} }] },
  });
});

test('a station on its own Navidrome opens on Navidrome and sends credentials only', () => {
  // The default: its Navidrome behind the router.
  const dflt = musicFromSaved(fresh, { mode: 'router', merge: false, sources: [{ plugin: 'navidrome', config: {}, rawIds: true, secretsSet: [] }] }, 'Navidrome');
  assert.equal(dflt.mode, 'navidrome');
  assert.equal(dflt.saved, 'navidrome');
  assert.deepEqual(musicSaveBody(dflt, creds), { navidrome: creds });
  // Direct mode keeps its mode too.
  const direct = musicFromSaved(fresh, { mode: 'navidrome', merge: false, sources: [] }, '');
  assert.equal(direct.saved, 'navidrome');
  assert.deepEqual(musicSaveBody(direct, creds), { navidrome: creds });
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
