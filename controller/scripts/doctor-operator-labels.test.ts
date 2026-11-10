// DJ Doc tells operators where to click, so what it says must name controls
// that exist: an admin section from the settings registry, never an internal
// property path (#1883). A develop merge into #1687 restored both a retired tab
// ("Danger zone") and the raw keys with nothing failing — these pin the result.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { DJ_DOC_KNOWLEDGE } from '../src/doctor-knowledge.js';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const sections = [...read('../../web/components/admin/settings/registry.ts')
  .matchAll(/^\s+id: '[^']+', group: '[^']+', label: '([^']+)'/gm)].map(m => m[1]);

const checkSources = readdirSync(new URL('../src/doctor/', import.meta.url))
  .filter(name => name.endsWith('.ts'))
  .map(name => ({ name, text: read(`../src/doctor/${name}`) }));

// The knowledge base states the rule itself, naming settings.llm.* as the
// example of what not to say; every other line is advice.
const advice = DJ_DOC_KNOWLEDGE.split('\n').filter(line => !/^Do not give internal property paths/.test(line));
const operatorLines = [
  ...advice.map(line => ({ where: 'doctor-knowledge.ts', line })),
  ...checkSources.flatMap(({ name, text }) => text.split('\n')
    .filter(line => /\b(hint|detail):/.test(line))
    .map(line => ({ where: `doctor/${name}`, line }))),
];

test('the settings registry yields the admin section labels', () => {
  assert.ok(sections.length >= 10, `parsed ${sections.length} sections — has the registry shape changed?`);
  for (const label of ['Music selection', 'LLM provider', 'Broadcast & mixer']) assert.ok(sections.includes(label), label);
});

test('every "Settings →" path DJ Doc gives starts at a real admin section', () => {
  const sources = [DJ_DOC_KNOWLEDGE, ...checkSources.map(({ text }) => text)];
  const stale = sources.flatMap(text => [...text.matchAll(/Settings → ([^\n]+)/g)].map(m => m[1]))
    .filter(rest => !sections.some(label => rest.startsWith(label)));
  assert.deepEqual(stale, []);
});

test('DJ Doc never names an internal settings key to the operator', () => {
  const key = /\bsettings\.[a-z]|\b(numCtx|maxOutputTokens|agentTimeoutMs|dailyTokenCap|budgetSoftPct|trackSelection|pickerAgent|exemptRequests|requestWebResolve)\b/;
  const leaks = operatorLines.filter(({ line }) => key.test(line)).map(({ where, line }) => `${where}: ${line.trim()}`);
  assert.deepEqual(leaks, []);
});
