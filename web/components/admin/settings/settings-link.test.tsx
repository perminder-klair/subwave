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

// The Listeners cards, rendered from saved settings with no unsaved edits.
function renderLastfmCard(lastfm: Record<string, unknown>, lastfmTags: boolean | null): string {
  const values = { scrobble: { lastfm }, embedding: { enrichment: { lastfmTags } } } as NonNullable<SettingsData['values']>;
  return renderToStaticMarkup(createElement(ScrobbleCards, {
    data: { values, env: {} } as SettingsData, form: settingsForm(values),
    setForm: () => {}, busy: false, saveSettings: async () => true, fieldErrors: {},
    adminFetch: async () => new Response(), refresh: () => {},
  }));
}

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

test('the Last.fm card links straight to the Enrichment card, once', () => {
  for (const lastfmTags of [null, false]) {
    const html = renderLastfmCard({ apiKey: 'set' }, lastfmTags);
    const hrefs = [...html.matchAll(/href="(\/admin\/settings[^"]*)"/g)].map(m => m[1]);
    // The Library tagger breadcrumb appears once: in the banner, or in the
    // red warning when tags are off.
    assert.equal(hrefs.length, 1, `settings links (tags=${lastfmTags}): ${hrefs.length}`);
    for (const h of hrefs) assert.equal(h, '/admin/settings?section=library&amp;card=enrichment');
  }
});

test('the Last.fm card copy has no em dashes and no stale Advanced breadcrumb', () => {
  for (const lastfmTags of [null, false]) {
    const html = renderLastfmCard({ apiKey: 'set', apiSecret: 'set' }, lastfmTags);
    // Only the Last.fm card, up to the ListenBrainz card.
    const card = html.slice(0, html.indexOf('ListenBrainz'));
    assert.doesNotMatch(card, /\u2014/, `em dash (tags=${lastfmTags})`);
    assert.doesNotMatch(card, /Advanced → Enrichment/, `breadcrumb (tags=${lastfmTags})`);
    assert.doesNotMatch(card, /to only enable tagging/);
  }
});
