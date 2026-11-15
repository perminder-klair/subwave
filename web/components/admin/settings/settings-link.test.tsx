// Settings deep links that land on one card (#2316). The Last.fm card links to
// Library tagger → Enrichment, which sits behind the Advanced disclosure, so the
// link has to name the card and the jump has to open Advanced to reach it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScrobbleCards } from './ScrobbleSection';
import { settingsForm } from './form-state';
import { settingsHref, settingsJumpFromQuery } from './settings-link';
import { cardAnchor } from '../ui';
import type { SettingsData } from './shared';

test('a card link names the section and the card', () => {
  assert.equal(settingsHref('library'), '/admin/settings?section=library');
  assert.equal(settingsHref('library', 'enrichment'), '/admin/settings?section=library&card=enrichment');
});

test('the Enrichment link opens Advanced on the way', () => {
  assert.equal(cardAnchor('Enrichment'), 'enrichment');
  assert.deepEqual(settingsJumpFromQuery('library', 'enrichment'),
    { section: 'library', anchor: 'enrichment', advanced: true });
  assert.deepEqual(settingsJumpFromQuery('listeners', 'last-fm'),
    { section: 'listeners', anchor: 'last-fm', advanced: false });
});

test('a URL without a usable card asks for no jump', () => {
  assert.equal(settingsJumpFromQuery('library', null), null);
  assert.equal(settingsJumpFromQuery(null, 'enrichment'), null);
  assert.equal(settingsJumpFromQuery('library', ''), null);
  // It lands in a CSS attribute selector, so only a cardAnchor slug passes.
  assert.equal(settingsJumpFromQuery('library', 'x"],body[x="'), null);
  assert.equal(settingsJumpFromQuery('library', 'Enrichment'), null);
});

test('the Last.fm card links straight to the Enrichment card', () => {
  for (const lastfmTags of [null, false]) {
    const values = { scrobble: { lastfm: { apiKey: 'set' } }, embedding: { enrichment: { lastfmTags } } } as NonNullable<SettingsData['values']>;
    const html = renderToStaticMarkup(createElement(ScrobbleCards, {
      data: { values, env: {} } as SettingsData, form: settingsForm(values),
      setForm: () => {}, busy: false, saveSettings: () => {}, fieldErrors: {},
      adminFetch: async () => new Response(), refresh: () => {},
    } as Parameters<typeof ScrobbleCards>[0]));
    const hrefs = [...html.matchAll(/href="(\/admin\/settings[^"]*)"/g)].map(m => m[1]);
    assert.ok(hrefs.length > 0, `no settings link (tags=${lastfmTags})`);
    for (const h of hrefs) assert.equal(h, '/admin/settings?section=library&amp;card=enrichment');
  }
});
