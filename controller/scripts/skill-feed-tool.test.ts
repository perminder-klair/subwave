// The generic feed tool — issue #1616.
//
// `feed:` / `feedMaxItems:` used to be config for ONE hand-written tool.mjs (the
// built-in news skill's). A custom skill could declare both, have them validate,
// save and read back through every route, and still reach the model with no feed
// content and no `skill_<name>` tool at all — a config field that did nothing,
// discoverable only by diffing an exported LLM prompt against the SKILL.md's own
// claims. This pins the mechanism the declaration now drives.
//
// The feed is served from a loopback HTTP server rather than stubbed, so the
// fetch/parse/dedupe path is exercised end to end without reaching the network.
//
// Run: `npm test -- skill-feed-tool`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

// config.ts and everything under it resolve state paths at module scope, so
// STATE_DIR and the fixtures must exist before the dynamic imports below.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'skill-feed-tool-'));
process.env.STATE_DIR = STATE_DIR;

// ---------------------------------------------------------------------------
// A loopback feed. `/rss` serves `items` RSS 2.0 entries; `/atom` the same
// content as Atom, so the generated tool is pinned against both dialects.
// ---------------------------------------------------------------------------
function rss(count: number, prefix: string): string {
  const items = Array.from({ length: count }, (_, i) =>
    `<item><title>${prefix} ${i + 1}</title><description>Blurb ${i + 1}</description></item>`).join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>${items}</channel></rss>`;
}

function atom(count: number, prefix: string): string {
  const entries = Array.from({ length: count }, (_, i) =>
    `<entry><title>${prefix} ${i + 1}</title><summary>Blurb ${i + 1}</summary></entry>`).join('');
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
}

let requests = 0;
const server: Server = createServer((req, res) => {
  requests++;
  const path = (req.url || '').split('?')[0];
  if (path === '/atom') {
    res.writeHead(200, { 'content-type': 'application/atom+xml' });
    res.end(atom(4, 'Atom'));
    return;
  }
  if (path === '/other') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rss(3, 'Story'));
    return;
  }
  if (path === '/boom') {
    res.writeHead(500);
    res.end('nope');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/rss+xml' });
  res.end(rss(10, 'Story'));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const feedUrl = (path: string) => `http://127.0.0.1:${port}${path}`;

function writeSkill(slug: string, skillMd: string, tool?: string) {
  const dir = join(STATE_DIR, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd);
  if (tool) writeFileSync(join(dir, 'tool.mjs'), tool);
}

// The reported shape: a custom skill declaring a feed and nothing else.
writeSkill('giveaway', `---
name: giveaway
label: Giveaway watch
feed: ${feedUrl('/rss')}
---
Report on the contest the feed describes.
`);

// A second feed skill — its dedup memory must not be the first one's.
writeSkill('scoreboard', `---
name: scoreboard
label: Scoreboard
feed: ${feedUrl('/other')}
---
Read the scoreboard.
`);

// feedMaxItems truncates the read, and Atom is one of the dialects the parser
// collapses (a feed: line is operator input, not a promise of RSS 2.0).
writeSkill('atom-two', `---
name: atom-two
label: Atom two
feed: ${feedUrl('/atom')}
feedMaxItems: 2
---
Two at a time.
`);

// A tool.mjs still owns its skill — the generic path must not displace it.
writeSkill('own-tool', `---
name: own-tool
label: Own tool
feed: ${feedUrl('/rss')}
---
Has its own fetcher.
`, `export default async function (_ctx, _state, _services, config) {
  return { mine: true, feed: config.feed };
}
`);

// A feed: line the loader cannot fetch must say so rather than silently
// behaving as if the field were absent — the "fail loudly" half of #1616.
writeSkill('bad-feed', `---
name: bad-feed
label: Bad feed
feed: ftp://example.test/feed.xml
---
Never gets a tool.
`);

const { queue } = await import('../src/broadcast/queue.js');
const logged: string[] = [];
const realLog = queue.log.bind(queue);
(queue as any).log = (level: string, msg: string) => { logged.push(`${level}: ${msg}`); return realLog(level, msg); };

const { loadSkills, readTemplate } = await import('../src/skills/loader.js');
const { buildSegmentTools, fetchSegmentData } = await import('../src/llm/internal/tools/segment-tools.js');
const { resolveFeedConfig, FEED_ITEMS_PER_FIRE } = await import('../src/skills/feed.js');
const { requiresGrounding } = await import('../src/skills/abstain-policy.js');

const caps = await loadSkills();
const capOf = (kind: string) => caps.find(c => c.kind === kind);

test.after(() => { server.close(); });

test('a feed: line alone earns the skill a skill_<name> fetch tool', async () => {
  const cap = capOf('giveaway');
  assert.ok(cap, 'the skill loaded');
  assert.equal(cap.toolName, 'skill_giveaway');
  assert.equal(typeof cap.toolFn, 'function');

  const tools = buildSegmentTools({ time: {} }, {}, [cap]);
  assert.ok(tools.skill_giveaway, 'the generated tool reaches the agent tool set');

  const result: any = await tools.skill_giveaway.execute({});
  assert.equal(result.headlines[0].title, 'Story 1');
  assert.equal(result.headlines[0].detail, 'Blurb 1');
});

test('the operator knobs are offered even before a value exists', () => {
  const cap = capOf('giveaway');
  assert.deepEqual(cap.configFields.map((f: any) => f.key), ['feed', 'feedMaxItems']);
  const max = cap.configFields.find((f: any) => f.key === 'feedMaxItems');
  assert.deepEqual({ type: max.type, min: max.min, max: max.max, integer: max.integer },
    { type: 'number', min: 1, max: 50, integer: true });
});

test('items are burned on read, so a second fire offers the rest', async () => {
  // Its own state object, so this test does not depend on the one above.
  const state: any = {};
  const cap = capOf('giveaway');
  const first: any = await cap.toolFn({}, state);
  assert.equal(first.headlines.length, FEED_ITEMS_PER_FIRE, 'one fire spends at most the per-fire cap');
  assert.deepEqual(first.headlines.map((h: any) => h.title),
    ['Story 1', 'Story 2', 'Story 3', 'Story 4', 'Story 5', 'Story 6']);

  const second: any = await cap.toolFn({}, state);
  assert.deepEqual(second.headlines.map((h: any) => h.title), ['Story 7', 'Story 8', 'Story 9', 'Story 10']);

  const third: any = await cap.toolFn({}, state);
  assert.deepEqual(third.headlines, [], 'nothing fresh left is an empty list, not an error');
});

test('two feed skills keep separate dedup memory', async () => {
  const state: any = {};
  const giveaway = capOf('giveaway');
  const scoreboard = capOf('scoreboard');
  await giveaway.toolFn({}, state);
  // Same server, different path — the scoreboard's own items are untouched by
  // the giveaway's burn even though both wrote to the same state object.
  const board: any = await scoreboard.toolFn({}, state);
  assert.deepEqual(board.headlines.map((h: any) => h.title), ['Story 1', 'Story 2', 'Story 3']);
});

test('feedMaxItems truncates the read, and Atom parses like RSS', async () => {
  const cap = capOf('atom-two');
  const result: any = await cap.toolFn({}, {});
  assert.deepEqual(result.headlines.map((h: any) => h.title), ['Atom 1', 'Atom 2']);
});

test('a skill with its own tool.mjs keeps it', async () => {
  const cap = capOf('own-tool');
  const before = requests;
  const result: any = await fetchSegmentData(cap, {}, {});
  assert.deepEqual(result, { mine: true, feed: feedUrl('/rss') });
  assert.equal(requests, before, 'the generic tool never ran');
});

test('an unusable feed: line warns instead of silently doing nothing', () => {
  const cap = capOf('bad-feed');
  assert.ok(cap, 'the skill still loads — a bad knob is not a reason to vanish');
  assert.equal(cap.toolFn, undefined);
  assert.equal(cap.toolName, undefined);
  assert.ok(
    logged.some(l => l.startsWith('warn:') && l.includes('bad-feed') && l.includes('http(s)')),
    `expected a warn naming the skill, got: ${logged.filter(l => l.startsWith('warn:')).join(' | ')}`,
  );
});

test('a feed skill stands down when the fetch fails', async () => {
  const cap = capOf('giveaway');
  assert.equal(requiresGrounding(cap), true, 'a skill speaking from a feed is grounded by default');
  // The segment-tools wrapper turns a throw into the { error } shape the
  // abstain policy reads, rather than letting it escape into the tick.
  const broken = { ...cap, toolFn: (await import('../src/skills/feed.js')).makeFeedTool('broken', { url: feedUrl('/boom'), maxItems: 5 }) };
  const data: any = await fetchSegmentData(broken, {}, {});
  assert.match(String(data.error), /500/);
});

test('resolveFeedConfig: absent and cleared are ordinary, unusable is loud', () => {
  assert.deepEqual(resolveFeedConfig({}), { feed: null, warnings: [] });
  assert.deepEqual(resolveFeedConfig({ feed: '   ' }), { feed: null, warnings: [] });
  assert.deepEqual(resolveFeedConfig(null), { feed: null, warnings: [] });

  const notAUrl = resolveFeedConfig({ feed: 'feeds.example.test/rss' });
  assert.equal(notAUrl.feed, null);
  assert.equal(notAUrl.warnings.length, 1);

  const wrongScheme = resolveFeedConfig({ feed: 'file:///etc/passwd' });
  assert.equal(wrongScheme.feed, null);
  assert.match(wrongScheme.warnings[0], /http\(s\)/);
});

test('resolveFeedConfig: feedMaxItems is lenient where the URL is strict', () => {
  const ok = resolveFeedConfig({ feed: 'https://example.test/rss', feedMaxItems: '7' });
  assert.deepEqual(ok, { feed: { url: 'https://example.test/rss', maxItems: 7 }, warnings: [] });

  // Frontmatter arrives as strings; a broken count still has an obvious right
  // answer, so it falls back to the station default and says so.
  for (const bad of ['abc', '0', '51', '2.5']) {
    const res = resolveFeedConfig({ feed: 'https://example.test/rss', feedMaxItems: bad });
    assert.equal(res.feed?.maxItems, 10, `${bad} falls back to the station default`);
    assert.equal(res.warnings.length, 1, `${bad} warns`);
  }

  // An absent count is not a broken one.
  assert.deepEqual(resolveFeedConfig({ feed: 'https://example.test/rss' }).warnings, []);
});

test('news ships no tool.mjs — it takes the generic path like everything else', async () => {
  const tpl = await readTemplate('news');
  assert.ok(tpl, 'the news template exists');
  assert.equal(tpl.toolPath, null, 'a second copy of the feed fetch must not come back');
});
