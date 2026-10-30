import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourcesTab } from './SourcesTab';
import type { MusicSourceView } from './queries';

function outageView(sources: MusicSourceView['sources']): MusicSourceView {
  return {
    mode: 'router',
    merge: sources.length > 1,
    sources,
    router: null,
    routerUrl: 'http://router.test',
    routerError: 'router unreachable',
    navidrome: { url: 'http://navidrome.test', user: 'radio', passSet: true, env: { url: false, user: false, pass: false } },
    failover: { active: false, eligible: sources.length === 1 && sources[0]?.plugin === 'navidrome', since: null, reason: null },
  };
}

const navidrome = { plugin: 'navidrome', config: {}, rawIds: true, secretsSet: [] };
const jellyfin = { plugin: 'jellyfin', config: {}, secretsSet: [] };

for (const [name, sources] of [
  ['default Navidrome', [navidrome]],
  ['merged library', [navidrome, jellyfin]],
  ['another source', [jellyfin]],
] satisfies Array<[string, MusicSourceView['sources']]>) {
  test(`${name}: a router outage keeps the direct escape hatch and connection form available`, () => {
    const html = renderToStaticMarkup(createElement(SourcesTab, {
      view: outageView(sources),
      adminFetch: async () => { throw new Error('rendering must not send a request'); },
      reload: async () => {},
    }));
    assert.match(html, />Play Navidrome directly<\/button>/);
    assert.doesNotMatch(html, /<button[^>]*\sdisabled(?:=|\s|>)[^>]*>Play Navidrome directly<\/button>/);
    assert.match(html, /id="nv-url"/);
    assert.match(html, /id="nv-pass"/);
  });
}

test('an outage keeps the direct action disabled until Navidrome credentials are complete', () => {
  const view = outageView([jellyfin]);
  view.navidrome.passSet = false;
  const html = renderToStaticMarkup(createElement(SourcesTab, {
    view,
    adminFetch: async () => { throw new Error('rendering must not send a request'); },
    reload: async () => {},
  }));
  assert.match(html, /<button[^>]*\sdisabled(?:=|\s|>)[^>]*>Play Navidrome directly<\/button>/);
  assert.match(html, /id="nv-pass"/);
});
