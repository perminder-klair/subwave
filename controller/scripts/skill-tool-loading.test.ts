// Regression coverage for issue #1526: frontmatter is configuration for a
// sibling tool.mjs, not an instruction for the loader to fetch a URL or invent a
// tool for a prompt-only skill.
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

writeSkill('feed-notes', `---
name: feed-notes
label: Feed notes
feed: https://example.test/notes.rss
feedMaxItems: 4
---
Write a timeless line from this brief alone.
`);

const { loadSkills } = await import('../src/skills/loader.js');
const { buildSegmentTools } = await import('../src/llm/internal/tools/segment-tools.js');
const caps = await loadSkills();

const giveaway = caps.find(cap => cap.kind === 'giveaway');
const feedNotes = caps.find(cap => cap.kind === 'feed-notes');

assert.ok(giveaway, 'custom skill with tool.mjs loaded');
assert.ok(feedNotes, 'prompt-only skill loaded');

test('a non-News custom tool is named and receives all frontmatter as config', async () => {
  assert.equal(giveaway.toolName, 'skill_giveaway');
  assert.equal(typeof giveaway.toolFn, 'function');
  assert.deepEqual(giveaway.config, giveawayConfig);

  const tools = buildSegmentTools({ time: {} }, {}, caps);
  assert.ok(tools.skill_giveaway, 'custom tool is registered in the segment tool set');

  const result = await tools.skill_giveaway.execute({});
  assert.deepEqual(result, { receivedConfig: giveawayConfig });
});

test('feed frontmatter without tool.mjs stays prompt-only', () => {
  assert.deepEqual(feedNotes.config, {
    name: 'feed-notes',
    label: 'Feed notes',
    feed: 'https://example.test/notes.rss',
    feedMaxItems: '4',
  });
  assert.equal(feedNotes.toolFn, undefined);
  assert.equal(feedNotes.toolName, undefined);

  const tools = buildSegmentTools({ time: {} }, {}, [feedNotes]);
  assert.equal(tools.skill_feed_notes, undefined);
  assert.deepEqual(Object.keys(tools), []);
});
