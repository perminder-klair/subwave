// Regression coverage for the skill tool.mjs contract: a sibling tool.mjs is
// wrapped as `skill_<slug>` and receives the skill's whole frontmatter as its
// `config` argument (issue #1526).
//
// The other half of that original pin — "a feed: line without a tool.mjs stays
// prompt-only" — was the bug reported as #1616 and is gone: the generic feed
// tool now covers it, and scripts/skill-feed-tool.test.ts pins the new
// behaviour. What survives here is the boundary that still holds: a skill
// declaring NO feed and shipping no tool.mjs gets no tool at all.
//
// Run: `npm test -- skill-tool-loading`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts and the modules pulled in by segment-tools.ts resolve state paths at
// module scope, so fixtures and STATE_DIR must exist before dynamic imports.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'skill-tool-loading-'));
process.env.STATE_DIR = STATE_DIR;

function writeSkill(slug: string, skillMd: string, tool?: string) {
  const dir = join(STATE_DIR, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd);
  if (tool) writeFileSync(join(dir, 'tool.mjs'), tool);
}

const giveawayConfig = {
  name: 'giveaway',
  label: 'Giveaway watch',
  cooldown: '30m',
  feed: 'https://example.test/giveaways.rss',
  feedMaxItems: '7',
  editorialNote: 'local prizes only',
};

writeSkill('giveaway', `---
name: giveaway
label: Giveaway watch
cooldown: 30m
feed: https://example.test/giveaways.rss
feedMaxItems: 7
editorialNote: local prizes only
---
Share one worthwhile local giveaway when the feed has one.
`, `export default async function (_ctx, _state, _services, config) {
  return { receivedConfig: config };
}
`);

writeSkill('brief-only', `---
name: brief-only
label: Brief only
editorialNote: nothing to fetch
---
Write a timeless line from this brief alone.
`);

const { loadSkills } = await import('../src/skills/loader.js');
const { buildSegmentTools } = await import('../src/llm/internal/tools/segment-tools.js');
const caps = await loadSkills();

const giveaway = caps.find(cap => cap.kind === 'giveaway');
const briefOnly = caps.find(cap => cap.kind === 'brief-only');

assert.ok(giveaway, 'custom skill with tool.mjs loaded');
assert.ok(briefOnly, 'prompt-only skill loaded');

test('a non-News custom tool is named and receives all frontmatter as config', async () => {
  assert.equal(giveaway.toolName, 'skill_giveaway');
  assert.equal(typeof giveaway.toolFn, 'function');
  assert.deepEqual(giveaway.config, giveawayConfig);

  const tools = buildSegmentTools({ time: {} }, {}, caps);
  assert.ok(tools.skill_giveaway, 'custom tool is registered in the segment tool set');

  const result = await tools.skill_giveaway.execute({});
  assert.deepEqual(result, { receivedConfig: giveawayConfig });
});

test('a skill with no tool.mjs and no feed: stays prompt-only', () => {
  assert.deepEqual(briefOnly.config, {
    name: 'brief-only',
    label: 'Brief only',
    editorialNote: 'nothing to fetch',
  });
  assert.equal(briefOnly.toolFn, undefined);
  assert.equal(briefOnly.toolName, undefined);

  const tools = buildSegmentTools({ time: {} }, {}, [briefOnly]);
  assert.equal(tools.skill_brief_only, undefined);
  assert.deepEqual(Object.keys(tools), []);

  // It is still OFFERED the feed knobs: the edit sheet is where an operator
  // sets the first feed, so a form that appears only once a value exists is a
  // form nobody can use to create one.
  assert.deepEqual(briefOnly.configFields.map((f: any) => f.key), ['feed', 'feedMaxItems']);
});
