// A skill held back by a search key the provider refuses. searchReady() going
// false reaches the Skills page and a Run now as a plain "not ready", and the
// advice that follows (set SEARCH_API_KEY) can't work, because a saved key shadows
// env. This pins what those two surfaces say instead, for every skill that gates
// on search: the two built-ins load from their real seeded files, and the custom
// pair shows the note follows what ready() asks, not the skill's name.
// Nothing here searches, so nothing reaches any provider.
// Run: `npm test -- skill-search-key`.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-skill-search-key-'));
process.env.STATE_DIR = stateDir;
delete process.env.SEARCH_API_KEY;
delete process.env.SKILL_SEARCH_KEY_TEST;
after(() => removeTempDir(stateDir));

function customSkill(slug: string, frontmatter: string, tool?: string) {
  const dir = join(stateDir, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\n${frontmatter}---\nSay something about ${slug}.\n`);
  if (tool) writeFileSync(join(dir, 'tool.mjs'), tool);
}

const toolWith = (ready: string) =>
  `export const ready = ${ready};\nexport default async function tool() { return { available: false }; }\n`;

// The line the manual hands an operator writing a search skill.
customSkill('custom-search', '', toolWith('(services) => services.searchReady()'));
// Search first, so a false search is what stops it.
customSkill('custom-search-and-more', '', toolWith('(services) => services.searchReady() && !!process.env.NOPE'));
// Stopped before it ever asks about search.
customSkill('custom-env-first', '', toolWith('(services) => !!process.env.NOPE && services.searchReady()'));
// Never asks about search at all.
customSkill('custom-always-off', '', toolWith('() => false'));
customSkill('custom-keyed', 'requiresKey: SKILL_SEARCH_KEY_TEST\n');

const settings = await import('../src/settings.js');
const { seedBuiltinSkills } = await import('../src/skills/scaffold.js');
const { loadSkills } = await import('../src/skills/loader.js');
const { runCapability, skillCatalog } = await import('../src/skills/_agent.js');
const { buildStationServices } = await import('../src/llm/internal/tools/station-services.js');
const { searchKeyProblem, searchReady } = await import('../src/skills/web-search.js');

before(async () => {
  await settings.load();
  await seedBuiltinSkills();
  await loadSkills();
});

function setSearch(t: TestContext, search: Record<string, unknown>) {
  const original = structuredClone(settings.get().search);
  t.after(async () => {
    delete process.env.SEARCH_API_KEY;
    await settings.update({ search: original });
  });
  return settings.update({ search });
}

const row = (name: string) => {
  const found = skillCatalog().find((s: any) => s.name === name);
  assert.ok(found, `${name} is in the catalog`);
  return found as any;
};

const SEARCH_GATED = ['web-search', 'now-playing-dig', 'custom-search', 'custom-search-and-more'];
const FOREIGN = /not a Firecrawl key/;

test('a refused key is named on every skill that gates on search', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: 'tvly-left-over' });
  for (const name of SEARCH_GATED) {
    const skill = row(name);
    assert.equal(skill.ready, false, name);
    assert.match(skill.keyProblem, FOREIGN, name);
  }
});

test('an env key the provider refuses is named too', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: '' });
  process.env.SEARCH_API_KEY = 'tvly-from-env';
  assert.match(row('web-search').keyProblem, FOREIGN);
});

test('a skill stopped by something other than search is not blamed on the key', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: 'tvly-left-over' });
  for (const name of ['custom-env-first', 'custom-always-off', 'custom-keyed']) {
    const skill = row(name);
    assert.equal(skill.ready, false, name);
    assert.equal(skill.keyProblem, null, name);
  }
});

test('a missing key stays a missing key', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: '' });
  for (const name of SEARCH_GATED) {
    const skill = row(name);
    assert.equal(skill.ready, false, name);
    assert.equal(skill.keyProblem, null, name);
  }
  assert.equal(row('web-search').requiresKey, 'SEARCH_API_KEY');
});

test('a Firecrawl key clears it', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: 'fc-a-real-one' });
  assert.equal(searchKeyProblem(), null);
  for (const name of ['web-search', 'now-playing-dig', 'custom-search']) {
    assert.equal(row(name).ready, true, name);
    assert.equal(row(name).keyProblem, null, name);
  }
});

// Tavily and Brave refuse only a key carrying another provider's prefix (#2223),
// so a key in a format nobody claims still clears them.
test("Tavily and Brave name another provider's key too, and pass any other", async (t) => {
  await setSearch(t, { provider: 'tavily', apiKey: 'fc-left-over' });
  assert.equal(searchKeyProblem(), 'The key on file is a Firecrawl key, not a Tavily key');
  assert.equal(row('web-search').ready, false);
  assert.equal(row('web-search').keyProblem, 'The key on file is a Firecrawl key, not a Tavily key');

  await settings.update({ search: { provider: 'brave', apiKey: 'tvly-left-over' } });
  assert.equal(row('web-search').keyProblem, 'The key on file is a Tavily key, not a Brave Search key');

  await settings.update({ search: { provider: 'brave', apiKey: 'BSA-a-real-one' } });
  assert.equal(searchKeyProblem(), null);
  assert.equal(row('web-search').ready, true);
  assert.equal(row('web-search').keyProblem, null);
});

test('Keenable never has a key problem: a foreign key just runs it keyless', async (t) => {
  await setSearch(t, { provider: 'keenable', apiKey: 'fc-left-over' });
  assert.equal(searchKeyProblem(), null);
  assert.equal(row('web-search').keyProblem, null);
});

test('Run now names the refused key instead of asking for SEARCH_API_KEY', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: 'tvly-left-over' });
  for (const name of ['web-search', 'now-playing-dig']) {
    await assert.rejects(runCapability(name, {}), (err: Error) => {
      assert.match(err.message, FOREIGN, name);
      assert.match(err.message, /Settings → Web search/, name);
      assert.doesNotMatch(err.message, /SEARCH_API_KEY/, name);
      return true;
    });
  }
});

test('Run now keeps its existing hints for a missing key and an unrelated gate', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: '' });
  await assert.rejects(runCapability('web-search', {}), /set SEARCH_API_KEY or paste a Firecrawl key/);
  await assert.rejects(runCapability('custom-keyed', {}), /set SKILL_SEARCH_KEY_TEST/);
  await settings.update({ search: { provider: 'firecrawl', apiKey: 'tvly-left-over' } });
  await assert.rejects(runCapability('custom-keyed', {}), /set SKILL_SEARCH_KEY_TEST/);
});

test('watching ready() leaves the shared services object alone', async (t) => {
  await setSearch(t, { provider: 'firecrawl', apiKey: 'tvly-left-over' });
  skillCatalog();
  assert.equal(buildStationServices().searchReady, searchReady);
});

test('Outcrawl names a refused key the same way, and an ock_ key clears it', async (t) => {
  await setSearch(t, { provider: 'outcrawl', apiKey: 'fc-left-over' });
  for (const name of SEARCH_GATED) {
    const skill = row(name);
    assert.equal(skill.ready, false, name);
    assert.match(skill.keyProblem, /not an Outcrawl key/, name);
  }
  await assert.rejects(runCapability('web-search', {}), /not an Outcrawl key.*Settings → Web search/);

  await settings.update({ search: { provider: 'outcrawl', apiKey: 'ock_a-real.one' } });
  assert.equal(searchKeyProblem(), null);
  assert.equal(row('web-search').ready, true);
  assert.equal(row('web-search').keyUrl, 'https://outcrawl.ai/console');
});

test('Run now asks for an Outcrawl key when none is set', async (t) => {
  await setSearch(t, { provider: 'outcrawl', apiKey: '' });
  await assert.rejects(runCapability('web-search', {}), /set SEARCH_API_KEY or paste an Outcrawl key/);
  assert.equal(row('web-search').requiresKey, 'SEARCH_API_KEY');
});

test('SpecStream names a refused key the same way, and an ss_ key clears it', async (t) => {
  await setSearch(t, { provider: 'specstream', apiKey: 'ock_left.over' });
  for (const name of SEARCH_GATED) {
    const skill = row(name);
    assert.equal(skill.ready, false, name);
    assert.match(skill.keyProblem, /not a SpecStream key/, name);
  }
  await assert.rejects(runCapability('web-search', {}), /not a SpecStream key.*Settings → Web search/);

  await settings.update({ search: { provider: 'specstream', apiKey: 'ss_live_real' } });
  assert.equal(searchKeyProblem(), null);
  assert.equal(row('web-search').ready, true);
  assert.equal(row('web-search').keyUrl, 'https://specstream.ai/workspace');
});

// Run now's hint and the catalog's key link come from the search catalogue
// (keyName, keyUrl, one article rule). These are the strings the per-provider
// chains wrote before, so moving onto the catalogue changed none of them.
test('a missing key names each keyed provider and links its key page, from the catalogue', async (t) => {
  const cases: Array<[provider: string, hint: string, keyUrl: string]> = [
    ['tavily', 'set SEARCH_API_KEY or paste a Tavily key into the admin UI', 'https://app.tavily.com/home'],
    ['brave', 'set SEARCH_API_KEY or paste a Brave Search key into the admin UI', 'https://api-dashboard.search.brave.com/app/keys'],
    ['firecrawl', 'set SEARCH_API_KEY or paste a Firecrawl key into the admin UI', 'https://www.firecrawl.dev/app/api-keys'],
    ['outcrawl', 'set SEARCH_API_KEY or paste an Outcrawl key into the admin UI', 'https://outcrawl.ai/console'],
    ['specstream', 'set SEARCH_API_KEY or paste a SpecStream key into the admin UI', 'https://specstream.ai/workspace'],
  ];
  await setSearch(t, { provider: 'duckduckgo', apiKey: '' });
  for (const [provider, hint, keyUrl] of cases) {
    await settings.update({ search: { provider, apiKey: '' } });
    await assert.rejects(runCapability('web-search', {}), { message: `skill "web-search" is not ready — ${hint}` });
    assert.equal(row('web-search').requiresKey, 'SEARCH_API_KEY', provider);
    assert.equal(row('web-search').keyUrl, keyUrl, provider);
  }
  for (const provider of ['duckduckgo', 'keenable', 'searxng']) {
    await settings.update({ search: { provider, apiKey: '' } });
    assert.equal(row('web-search').requiresKey, null, provider);
    assert.equal(row('web-search').keyUrl, null, provider);
  }
});
