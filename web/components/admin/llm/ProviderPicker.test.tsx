// The grouped provider picker. groupProviders is what both the cards and the
// grouped Selects render from, so its contract is pinned directly: the
// catalogue's three groups in order, each keeping the server's order, empty
// groups dropped, and an id the catalogue doesn't know shown as a vendor. The
// picker itself is rendered to static markup (web has no DOM harness): one
// labelled radiogroup, one radio per provider, gateways as rows and the rest
// as cards. Click handling is not exercised here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EMBEDDING_PROVIDER_IDS, LLM_PROVIDER_IDS, PROVIDER_GROUPS } from '../../../lib/schemas.generated';
import { PROVIDER_GROUP_LABELS, groupProviders } from './providerMeta';
import { ProviderPicker } from './ProviderPicker';
import { groupSearchProviders } from '../settings/SearchSection';

const shape = (ids: readonly string[]) =>
  groupProviders(ids).map(g => [g.group, g.ids] as const);

test('the LLM list splits into network, vendors and gateways, each in server order', () => {
  assert.deepEqual(shape(LLM_PROVIDER_IDS), [
    ['network', ['ollama', 'openai-compatible', 'locca']],
    ['vendor', ['anthropic', 'openai', 'google', 'deepseek']],
    ['gateway', ['openrouter', 'requesty', 'gateway']],
  ]);
});

test('the embedding list keeps only the groups it has members in', () => {
  assert.deepEqual(shape(EMBEDDING_PROVIDER_IDS), [
    ['network', ['ollama', 'openai-compatible', 'locca']],
    ['vendor', ['openai', 'google']],
    ['gateway', ['openrouter', 'requesty']],
  ]);
  assert.deepEqual(shape(['requesty', 'openrouter']), [['gateway', ['requesty', 'openrouter']]]);
});

test('an id the catalogue does not know is shown as a vendor, not dropped', () => {
  assert.deepEqual(shape(['ollama', 'brand-new', 'openai']), [
    ['network', ['ollama']],
    ['vendor', ['brand-new', 'openai']],
  ]);
});

test('every group has a heading', () => {
  for (const group of PROVIDER_GROUPS) assert.ok(PROVIDER_GROUP_LABELS[group], group);
});

test('the picker renders one labelled radiogroup, gateways as rows', () => {
  const html = renderToStaticMarkup(createElement(ProviderPicker, {
    value: 'requesty', providerIds: [...LLM_PROVIDER_IDS], label: 'LLM provider', env: {}, onChange: () => {},
  }));
  assert.equal(html.match(/role="radiogroup"/g)?.length, 1);
  assert.match(html, /role="radiogroup" aria-label="LLM provider"/);
  assert.equal(html.match(/role="radio"/g)?.length, LLM_PROVIDER_IDS.length);
  assert.equal(html.match(/aria-checked="true"/g)?.length, 1);

  // Headings in group order, each before its own options.
  const at = (s: string) => html.indexOf(s);
  assert.ok(at('On your network') < at('Model vendors') && at('Model vendors') < at('Gateways: one key, many vendors'));

  // The markup from each group's data-group attribute to the next one's.
  const parts = Object.fromEntries(html.split('data-group="').slice(1).map(s => [s.slice(0, s.indexOf('"')), s]));
  const section = (group: string) => parts[group] ?? '';
  assert.match(section('network'), /data-layout="cards"/);
  assert.match(section('vendor'), /data-layout="cards"/);
  assert.match(section('gateway'), /data-layout="rows"/);
  assert.match(section('gateway'), /aria-checked="true"[^>]*>[\s\S]*?Requesty/);
});

// Columns follow each card group's size against the picker's own width, so no
// row strands one card: the LLM picker's four vendors go two by two, then four
// across, and the embedding picker's two fill their row (#2130).
test('card columns follow the group size, measured against the picker', () => {
  const columns = (providerIds: readonly string[]) => {
    const html = renderToStaticMarkup(createElement(ProviderPicker, {
      value: '', providerIds: [...providerIds], label: 'p', env: {}, onChange: () => {},
    }));
    assert.match(html, /role="radiogroup"[^>]*class="[^"]*@container/);
    return Object.fromEntries(
      [...html.matchAll(/data-group="([^"]+)"[\s\S]*?<div class="([^"]*)" data-layout="cards"/g)].map(m => [m[1], m[2]]),
    );
  };
  const llm = columns(LLM_PROVIDER_IDS);
  assert.equal(llm.network, 'grid gap-2.5 grid-cols-2 @md:grid-cols-3');
  assert.equal(llm.vendor, 'grid gap-2.5 grid-cols-2 @2xl:grid-cols-4');
  assert.equal(columns(EMBEDDING_PROVIDER_IDS).vendor, 'grid gap-2.5 grid-cols-2');
  assert.equal(columns(['anthropic', 'openai', 'google', 'deepseek', 'brand-new']).vendor, 'grid gap-2.5 grid-cols-2 @md:grid-cols-3');
});

test('the search Select groups keyless, keyed and self-hosted backends', () => {
  assert.deepEqual(groupSearchProviders(['duckduckgo', 'tavily', 'brave', 'searxng', 'keenable']), [
    { label: 'No key needed', ids: ['duckduckgo', 'keenable'] },
    { label: 'Needs an API key', ids: ['tavily', 'brave'] },
    { label: 'Self-hosted', ids: ['searxng'] },
  ]);
  assert.deepEqual(groupSearchProviders(['duckduckgo', 'brand-new']).map(g => g.label), ['No key needed', 'Other']);
});
