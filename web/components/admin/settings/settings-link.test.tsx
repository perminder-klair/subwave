// Settings deep links that land on one card (#2316). The Last.fm card links to
// Library tagger → Enrichment, which sits behind the Advanced disclosure, so the
// link has to name the card and the jump has to open Advanced to reach it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScrobbleCards } from './ScrobbleSection';
import { settingsForm } from './form-state';
import { deepLinkJump, settingsHref, settingsJumpFromQuery } from './settings-link';
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

// SettingsPanel renders no card until the first settings read lands, and jumpTo
// gives up after about a second, so a jump fired on mount was lost on a cold
// load with a slow read.
test('a deep link waits for the cards, then jumps once and drops the card', () => {
  const known = (id: string) => id === 'library' || id === 'listeners';
  const first = new URLSearchParams('section=library&card=enrichment');
  const enrichment = { section: 'library', anchor: 'enrichment', advanced: true };

  assert.equal(deepLinkJump(first, false, known, null), null, 'no cards yet: wait');
  assert.deepEqual(deepLinkJump(first, true, known, null), { jump: enrichment, search: '?section=library' });
  assert.equal(deepLinkJump(first, true, known, first), null, 'a re-render, or Strict Mode running the effect twice');
  // Other params survive; only the card goes.
  assert.equal(deepLinkJump(new URLSearchParams('card=enrichment&section=library&x=1'), true, known, null)?.search,
    '?section=library&x=1');

  assert.equal(deepLinkJump(new URLSearchParams('section=brain&card=enrichment'), true, known, null), null);
  assert.equal(deepLinkJump(new URLSearchParams('section=library'), true, known, null), null);
});

// Next's useSearchParams, as a production build behaves: the object is memoised
// on the URL string (app-router.js, `useMemo(..., [canonicalUrl])`), so a
// navigation to the URL already in the address bar hands back the same object.
// The rail never writes ?section, so without the panel dropping the card after
// a jump, a second click on the link would find the same object and do nothing.
test('a second click on the link jumps again in a production build', () => {
  const known = (id: string) => id === 'library' || id === 'listeners';
  // useMemo keeps one slot: the object for the last URL it saw.
  let memo: { search: string; params: URLSearchParams } | null = null;
  const paramsFor = (search: string) => {
    if (memo?.search !== search) memo = { search, params: new URLSearchParams(search) };
    return memo.params;
  };
  const link = settingsHref('library', 'enrichment').slice('/admin/settings'.length);
  let address = link;
  let last: URLSearchParams | null = null;
  // What SettingsPanel's effect does with a step: remember it, replace the URL.
  const effect = () => {
    const query = paramsFor(address);
    const step = deepLinkJump(query, true, known, last);
    if (!step) return false;
    last = query;
    address = step.search;
    return true;
  };

  assert.equal(effect(), true, 'the first click jumps');
  assert.equal(effect(), false, 'the URL replace re-runs the effect and finds no card');
  assert.equal(effect(), false, 'a refetch or refresh does not scroll again');
  // The operator goes back to Listeners through the rail (no URL change), then
  // clicks the same link.
  address = link;
  assert.equal(effect(), true, 'a second click on the same link');
});
