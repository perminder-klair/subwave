// The key alert on a Skills card. A key on file that the search provider refuses
// must not send the operator to .env, where nothing they set would take effect.
// The alert is rendered to static markup, because web has no DOM harness.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SkillKeyAlert from './SkillKeyAlert';

const render = (skill: Parameters<typeof SkillKeyAlert>[0]['skill']) =>
  renderToStaticMarkup(createElement(SkillKeyAlert, { skill }));

const keyProblem = 'The key on file is not a Firecrawl key (they start with fc-)';

test('a refused key says so and points at Settings, not .env', () => {
  const html = render({ name: 'web-search', ready: false, requiresKey: 'SEARCH_API_KEY', keyProblem });
  assert.match(html, /Wrong API key/);
  assert.match(html, /not a Firecrawl key/);
  assert.match(html, /href="\/admin\/settings\?section=search"/);
  assert.doesNotMatch(html, /API key not set/);
  assert.doesNotMatch(html, /\.env/);
  assert.doesNotMatch(html, /SEARCH_API_KEY/);
});

test('a skill with no key url still gets the refused-key alert', () => {
  const html = render({ name: 'now-playing-dig', ready: false, keyProblem });
  assert.match(html, /Wrong API key/);
  assert.doesNotMatch(html, /Get a key here/);
  assert.doesNotMatch(html, /required API key/);
});

test('both alerts keep the link to where a key comes from', () => {
  const keyUrl = 'https://www.firecrawl.dev/app/api-keys';
  assert.match(render({ name: 'web-search', keyProblem, keyUrl }), /Get a key here/);
  assert.match(render({ name: 'web-search', requiresKey: 'SEARCH_API_KEY', keyUrl }), /Get a key here/);
});

test('a missing key keeps the env var advice, and so does an older controller', () => {
  for (const problem of [null, undefined]) {
    const html = render({ name: 'web-search', ready: false, requiresKey: 'SEARCH_API_KEY', keyProblem: problem });
    assert.match(html, /API key not set/);
    assert.match(html, /<code>SEARCH_API_KEY<\/code>/);
    assert.match(html, /\.env/);
    assert.doesNotMatch(html, /Wrong API key/);
  }
});
