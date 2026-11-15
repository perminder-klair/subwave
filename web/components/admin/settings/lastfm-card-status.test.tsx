// The Listeners → Last.fm card's subtitle and tags banner (#2316). Both read the
// saved settings only, through lastfmCardStatus, so an unsaved edit moves
// neither and the two never disagree about Last.fm tags. The card is rendered to
// static markup, because web has no DOM harness.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScrobbleCards } from './ScrobbleSection';
import { settingsForm } from './form-state';
import { lastfmCardStatus } from './lastfm-card-status';
import { lastfmTagsEnabled } from './lastfm-track-tags';
import type { FormState, ScrobbleLastfmForm, SettingsData } from './shared';

type SavedLf = Partial<ScrobbleLastfmForm>;

// Every saved shape the card can see: each credential stored or not, Enabled
// on or off, and the tagger's switch Auto, On or Off.
function savedStates(): { lf: SavedLf; lastfmTags: boolean | null }[] {
  const out: { lf: SavedLf; lastfmTags: boolean | null }[] = [];
  for (const enabled of [false, true])
    for (const apiKey of ['', 'set'])
      for (const apiSecret of ['', 'set'])
        for (const sessionKey of ['', 'set'])
          for (const lastfmTags of [null, true, false])
            out.push({ lf: { enabled, apiKey, apiSecret, sessionKey, username: 'dj' }, lastfmTags });
  return out;
}

// Edits an operator can make without saving.
const drafts: { name: string; edit: (lf: ScrobbleLastfmForm) => ScrobbleLastfmForm }[] = [
  { name: 'typing a replacement key', edit: lf => ({ ...lf, apiKey: 'a-new-key-typed-in' }) },
  { name: 'clearing the key box', edit: lf => ({ ...lf, apiKey: '' }) },
  { name: 'flipping Enabled', edit: lf => ({ ...lf, enabled: !lf.enabled }) },
  { name: 'typing a secret and session key', edit: lf => ({ ...lf, apiSecret: 'sec', sessionKey: 'sess' }) },
];

const noop = () => {};

function render(lf: SavedLf, lastfmTags: boolean | null, draft?: (lf: ScrobbleLastfmForm) => ScrobbleLastfmForm) {
  const values = { scrobble: { lastfm: lf }, embedding: { enrichment: { lastfmTags } } } as NonNullable<SettingsData['values']>;
  const data = { values, env: {} } as SettingsData;
  const base = settingsForm(values);
  const form: FormState = draft
    ? { ...base, scrobble: { ...base.scrobble, lastfm: draft(base.scrobble.lastfm) } }
    : base;
  const html = renderToStaticMarkup(createElement(ScrobbleCards, {
    data, form, setForm: noop, busy: false, saveSettings: async () => true, fieldErrors: {},
    adminFetch: async () => new Response(), refresh: noop,
  }));
  // The Last.fm card is the first card, so the first subtitle is its own.
  const subtitle = /<span class="sub">([^<]*)<\/span>/.exec(html)?.[1];
  const banner = /Last\.fm tags · ([^<]*)</.exec(html)?.[1];
  return { subtitle, banner, html };
}

test('an unsaved edit changes neither the subtitle nor the tags banner', () => {
  for (const { lf, lastfmTags } of savedStates()) {
    const saved = render(lf, lastfmTags);
    for (const d of drafts) {
      const edited = render(lf, lastfmTags, d.edit);
      const at = `${JSON.stringify(lf)} tags=${lastfmTags}, ${d.name}`;
      assert.equal(edited.subtitle, saved.subtitle, `subtitle moved: ${at}`);
      assert.equal(edited.banner, saved.banner, `banner moved: ${at}`);
    }
  }
});

test('the subtitle and the banner agree on Last.fm tags in every saved state', () => {
  for (const { lf, lastfmTags } of savedStates()) {
    const { subtitle, banner, html } = render(lf, lastfmTags);
    const at = `${JSON.stringify(lf)} tags=${lastfmTags}`;
    assert.ok(subtitle && banner, `missing status line: ${at}`);
    const s = lastfmCardStatus(lf, {}, lastfmTags);
    assert.equal(subtitle, s.subtitle.replace(/&/g, '&amp;'), at);
    assert.equal(banner, s.bannerLabel, at);
    // Off in one line means off in the other, and the red warning with them.
    assert.equal(/tags is off/.test(subtitle), banner === 'off', at);
    assert.equal(html.includes('role="alert"'), banner === 'off', at);
    // Tags-only wording only when tags actually run on a saved key.
    if (/tags only/.test(subtitle)) assert.equal(banner, 'key set', at);
    if (banner === 'no key') assert.doesNotMatch(subtitle, /key set/, at);
  }
});

test('the status follows the tagger: null is Auto, false vetoes the key', () => {
  const key: SavedLf = { apiKey: 'set' };
  assert.equal(lastfmCardStatus(key, {}, null).tags, 'on');
  assert.equal(lastfmCardStatus(key, {}, undefined).tags, 'on');
  assert.equal(lastfmCardStatus(key, {}, true).tags, 'on');
  assert.equal(lastfmCardStatus(key, {}, false).tags, 'off');
  // No key: On falls back to Navidrome, so Last.fm itself is not being asked.
  assert.equal(lastfmCardStatus({}, {}, true).tags, 'no-key');
  // The env key counts as saved.
  assert.equal(lastfmCardStatus({}, { LASTFM_API_KEY: true }, null).subtitle, 'key set, tags only, not scrobbling');
  assert.equal(lastfmCardStatus({}, {}, null).subtitle, 'not set up');
  const full: SavedLf = { enabled: true, apiKey: 'set', apiSecret: 'set', sessionKey: 'set', username: 'dj' };
  assert.equal(lastfmCardStatus(full, {}, null).subtitle, 'scrobbling as dj');
  assert.equal(lastfmCardStatus(full, {}, false).subtitle, 'scrobbling as dj, but Last.fm tags is off');
});

// The card reads the tagger's switch through the Library section's own rule, so
// the two tabs can't drift apart on what Auto, On and Off do with a key.
test("the card's tags status is lastfmTagsEnabled on the saved key", () => {
  for (const keySet of [false, true])
    for (const v of [null, true, false]) {
      const s = lastfmCardStatus(keySet ? { apiKey: 'set' } : {}, {}, v);
      assert.equal(s.tags === 'on', keySet && lastfmTagsEnabled(v, keySet), `key=${keySet} v=${v}`);
      assert.equal(s.tags === 'off', keySet && !lastfmTagsEnabled(v, keySet), `key=${keySet} v=${v}`);
    }
});
