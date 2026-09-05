// On-disk test for writeSkillFile's preserve pass (skills/scaffold.ts).
//
// writeSkillFile REWRITES SKILL.md from typed form fields, so every line it does
// not emit is a line it deletes. That is the half of #1300 the operator hit
// second: a `feed:` added by hand vanished on the first save from the admin
// form. Declaring knobs in tool.mjs fixes the form, but not this — a rewrite
// still needs to carry through what the form doesn't own:
//
//   - a hand-authored knob a tool reads straight off `config` (never declared),
//   - `toolDescription`, which the loader reads and the form never emitted,
//   - and, load-bearingly, a DECLARED knob at a moment when the declaration
//     isn't visible: a tool.mjs that fails to import loads prompt-only, so the
//     route sees no fields, and a save then would take the values with it.
//
// The opposite must hold too: a declared knob the operator CLEARED stays
// cleared, or the form could never delete a line.
//
// Run: `tsx scripts/skill-scaffold-preserve.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR must be set before config.js resolves it at import time — scaffold.ts
// derives SKILLS_DIR from it at module scope.
const stateDir = mkdtempSync(join(tmpdir(), 'skill-scaffold-test-'));
process.env.STATE_DIR = stateDir;

const { writeSkillFile } = await import('../src/skills/scaffold.js');

const dir = join(stateDir, 'skills', 'tech-news');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'SKILL.md');

// A duplicated News skill: declared knobs (feed/feedMaxItems), one hand-added
// knob its tool reads off `config`, and a hand-added toolDescription.
const SEEDED = `---
name: tech-news
label: Tech headlines
cooldown: 45m
feed: https://example.com/tech.xml
feedMaxItems: 6
apiBase: https://api.example.com
toolDescription: Fetch tech headlines.
tags: factual
---
Read one fresh headline.
`;

const form = {
  kind: 'tech-news',
  label: 'Tech headlines',
  cooldown: '45m',
  tags: ['factual'],
  brief: 'Read one fresh headline.',
};

// ── the tool.mjs is currently unloadable: nothing is declared ────────────────
{
  writeFileSync(file, SEEDED, 'utf8');
  await writeSkillFile({ ...form, config: {}, configKeys: [] });
  const md = readFileSync(file, 'utf8');

  assert.match(md, /^feed: https:\/\/example\.com\/tech\.xml$/m, 'feed survives a save made while tool.mjs is unloadable');
  assert.match(md, /^feedMaxItems: 6$/m, 'so does the second knob');
  assert.match(md, /^apiBase: https:\/\/api\.example\.com$/m, 'an undeclared, hand-authored knob survives');
  assert.match(md, /^toolDescription: Fetch tech headlines\.$/m, 'toolDescription survives');
  assert.equal((md.match(/^label:/gm) || []).length, 1, 'a form-owned key is written exactly once');
  assert.equal((md.match(/^tags:/gm) || []).length, 1, 'and never duplicated by the preserve pass');
}

// ── the declaration is visible: the form is authoritative for its own keys ───
{
  writeFileSync(file, SEEDED, 'utf8');
  await writeSkillFile({
    ...form,
    config: { feed: 'https://example.com/other.xml' },   // feedMaxItems cleared
    configKeys: ['feed', 'feedMaxItems'],
  });
  const md = readFileSync(file, 'utf8');

  assert.match(md, /^feed: https:\/\/example\.com\/other\.xml$/m, 'a declared knob takes the submitted value');
  assert.doesNotMatch(md, /feedMaxItems/, 'a declared knob the operator cleared stays cleared');
  assert.match(md, /^apiBase: https:\/\/api\.example\.com$/m, 'the undeclared knob is still carried');
  assert.match(md, /^Read one fresh headline\.$/m, 'the brief is still the body');
}

// ── a brand-new skill has nothing to preserve ────────────────────────────────
{
  await writeSkillFile({ kind: 'brand-new', brief: 'Say something.', config: {}, configKeys: [] });
  const md = readFileSync(join(stateDir, 'skills', 'brand-new', 'SKILL.md'), 'utf8');
  assert.equal(md, '---\nname: brand-new\n---\nSay something.\n', 'no existing file → no carry, no crash');
}

// ── what writeSkillFile emits must survive parseFrontmatter unchanged ───────
// The loader parses SKILL.md as real YAML, so the writer and the reader are now
// two halves of one round trip: a value the writer emits bare that YAML reads
// back as something else is silent data loss on the operator's next save.
{
  const { parseFrontmatter } = await import('../src/skills/loader.js');

  const awkward = {
    plain: 'Tech headlines',
    colon: 'Headlines: today',                       // bare → a YAML parse error
    hash: 'sharp # not a comment',                   // bare → truncated at the #
    leadingZeros: '007',                             // bare → the number 7
    numberish: '6',                                  // bare → 6 → "6". No quotes needed.
    boolish: 'true',                                 // bare → true → "true". Ditto.
    commaList: 'factual, late-night',                // the flattened-list form
    url: 'https://example.com/a.xml?x=1&y=2#top',
    brace: 'Returns { available, city }. Use it.',   // the real moon-phase/meanwhile shape
    dash: '- leading dash',                          // bare → a list
    quote: `it's "quoted"`,
    empty: '',
  };

  await writeSkillFile({
    kind: 'awkward',
    label: awkward.colon,
    config: awkward,
    configKeys: Object.keys(awkward),
    brief: 'Say something.',
  });
  const md = readFileSync(join(stateDir, 'skills', 'awkward', 'SKILL.md'), 'utf8');
  const { data, malformed } = parseFrontmatter(md);

  assert.equal(malformed, undefined, `emitted file is not valid YAML:\n${md}`);
  assert.equal(data.label, awkward.colon, 'a colon in a label survives the round trip');
  for (const [key, value] of Object.entries(awkward)) {
    if (value === '') {
      assert.equal(data[key], undefined, 'an empty knob is omitted, not written blank');
      continue;
    }
    assert.equal(data[key], value, `knob "${key}" did not round-trip`);
  }
  // Minimality: the ordinary values must not have picked up quotes, or every
  // existing SKILL.md churns on its first save after the upgrade.
  assert.match(md, /^plain: Tech headlines$/m, 'an ordinary value stays bare');
  assert.match(md, /^numberish: 6$/m, 'a number that round-trips stays bare');
  assert.match(md, /^commaList: factual, late-night$/m, 'the comma-list form stays bare');
  assert.match(md, /^url: https:\/\/example\.com\/a\.xml\?x=1&y=2#top$/m, 'a URL stays bare');
}

// ── cron/cronOnly are OWNED, not preserved: a re-save must not duplicate them ─
// Regression for a bug where cron/cronOnly were emitted by writeSkillFile but
// missing from OWNED_FRONTMATTER_KEYS, so the preserve pass carried the OLD
// values through alongside the newly-written ones — two `cron:` lines, which
// breaks YAML parsing and pins the stale value via the legacy line-parser
// fallback (parseFrontmatter's `malformed` path).
{
  await writeSkillFile({ kind: 'dabbers', brief: 'Say something.', cron: '0 8 * * *', cronOnly: true });
  const cronFile = join(stateDir, 'skills', 'dabbers', 'SKILL.md');

  await writeSkillFile({ kind: 'dabbers', brief: 'Say something.', cron: '0 9 * * *', cronOnly: true });
  let md = readFileSync(cronFile, 'utf8');
  const { parseFrontmatter } = await import('../src/skills/loader.js');
  let { data, malformed } = parseFrontmatter(md);

  assert.equal(malformed, undefined, `re-saved cron file is not valid YAML:\n${md}`);
  assert.equal((md.match(/^cron:/gm) || []).length, 1, 'cron is written exactly once on a changed re-save');
  assert.equal((md.match(/^cronOnly:/gm) || []).length, 1, 'cronOnly is written exactly once on a changed re-save');
  assert.equal(data.cron, '0 9 * * *', 'the new cron expression wins, not the stale carried one');

  // Operator clears both fields — they must actually disappear, not persist
  // via the preserve pass reading them back out of the file being replaced.
  await writeSkillFile({ kind: 'dabbers', brief: 'Say something.' });
  md = readFileSync(cronFile, 'utf8');
  ({ data, malformed } = parseFrontmatter(md));

  assert.equal(malformed, undefined, `cleared cron file is not valid YAML:\n${md}`);
  assert.doesNotMatch(md, /cron/, 'cron and cronOnly are both gone once cleared');
  assert.equal(data.cron, undefined, 'cron cannot be resurrected from a stale carried line');
}

// ── cohosts is OWNED and omitted when false ──────────────────────────────────
{
  await writeSkillFile({ kind: 'case-discussion', brief: 'Discuss one case.', cohosts: true });
  const cohostFile = join(stateDir, 'skills', 'case-discussion', 'SKILL.md');
  let md = readFileSync(cohostFile, 'utf8');
  assert.match(md, /^cohosts: true$/m, 'the opt-in is persisted when enabled');
  const { loadSkills } = await import('../src/skills/loader.js');
  let loaded = await loadSkills();
  assert.equal(loaded.find(c => c.kind === 'case-discussion')?.cohosts, true, 'rescan reloads the opt-in');

  await writeSkillFile({ kind: 'case-discussion', brief: 'Discuss one case.', cohosts: false });
  md = readFileSync(cohostFile, 'utf8');
  assert.doesNotMatch(md, /cohosts/, 'clearing the opt-in removes the owned frontmatter line');
  loaded = await loadSkills();
  assert.equal(loaded.find(c => c.kind === 'case-discussion')?.cohosts, false, 'rescan returns the skill to solo mode');
}


console.log('skill-scaffold-preserve.test.ts — all assertions passed');
