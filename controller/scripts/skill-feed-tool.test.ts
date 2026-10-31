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
import { mkdirSync, writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

// config.ts and everything under it resolve state paths at module scope, so
// STATE_DIR and the fixtures must exist before the dynamic imports below.
const STATE_DIR = createTempDir(join(tmpdir(), 'skill-feed-tool-'));
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
  if (path === '/empty') {
    // A well-formed feed that simply has nothing in it.
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rss(0, 'Story'));
    return;
  }
  if (path === '/dated') {
    // Two fresh, one undated, two stale (a search feed ignoring its window).
    const day = 86_400_000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toUTCString();
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Dated</title>`
      + `<item><title>Old festival</title><pubDate>${at(90)}</pubDate></item>`
      + `<item><title>Tonight's talk</title><pubDate>${at(1)}</pubDate></item>`
      + `<item><title>Undated notice</title></item>`
      + `<item><title>Last spring</title><pubDate>${at(200)}</pubDate></item>`
      + `<item><title>Film festival</title><pubDate>${at(3)}</pubDate></item>`
      + `</channel></rss>`);
    return;
  }
  if (path === '/late') {
    // 22:30 UTC on the 30th is already the 31st in Athens (UTC+2).
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Late</title>`
      + `<item><title>Late story</title><pubDate>Fri, 30 Oct 2026 22:30:00 GMT</pubDate></item>`
      + `</channel></rss>`);
    return;
  }
  if (path === '/local') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    // "Story 2" repeats an item of /other: merged, it must appear once.
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Local</title>`
      + `<item><title>Local 1</title></item><item><title>Story 2</title></item><item><title>Local 2</title></item>`
      + `</channel></rss>`);
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

const toolConfig = {
  name: 'config-tool',
  label: 'Giveaway watch',
  cooldown: '30m',
  feed: 'https://example.test/giveaways.rss',
  feedMaxItems: '7',
  editorialNote: 'local prizes only',
};

writeSkill('config-tool', `---
name: config-tool
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

const { queue } = await import('../src/broadcast/queue.js');
const logged: string[] = [];
const realLog = queue.log.bind(queue);
(queue as any).log = (level: string, msg: string) => { logged.push(`${level}: ${msg}`); return realLog(level, msg); };

const { loadSkills, readTemplate } = await import('../src/skills/loader.js');
const { buildSegmentTools, fetchSegmentData } = await import('../src/llm/internal/tools/segment-tools.js');
const { resolveFeedConfig, makeFeedTool, FEED_ITEMS_PER_FIRE } = await import('../src/skills/feed.js');
const { requiresGrounding, standDownReason } = await import('../src/skills/abstain-policy.js');
const { setStationTimezone } = await import('../src/time.js');

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
  assert.deepEqual(cap.configFields.map((f: any) => f.key), ['feed', 'feedMaxItems', 'feedMaxAgeDays', 'feed2', 'feed3']);
  const age = cap.configFields.find((f: any) => f.key === 'feedMaxAgeDays');
  assert.deepEqual({ type: age.type, min: age.min, max: age.max, integer: age.integer },
    { type: 'number', min: 1, max: 365, integer: true });
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

  // A drained feed is NOT an empty list (#1830): that read as usable data, so a
  // forced run was ordered to speak with no items and invented a headline.
  const third: any = await cap.toolFn({}, state);
  assert.equal(third.available, false, 'nothing fresh left is available:false');
  assert.equal(third.headlines, undefined, 'and carries no headlines key to read as data');
  assert.match(third.reason, /already aired/);
});

test('a feed that fetched fine but was empty from the start is the same answer', async () => {
  const empty = makeFeedTool('empty-feed', { url: feedUrl('/empty'), maxItems: 5 });
  const state: any = {};
  const result: any = await empty({}, state);
  assert.equal(result.available, false);
  assert.match(result.reason, /no items/);
  assert.equal(result.headlines, undefined);
});

test('a drained or empty feed stands a grounded run down through the one chokepoint', async () => {
  // The forced paths (Run now, skill cron, programme beat) and the pool
  // director all ask standDownReason; none of them knows the feed's shape.
  const cap = capOf('giveaway');
  const state: any = {};
  // Two fires spend the 10-item feed; a third has nothing left.
  await cap.toolFn({}, state);
  await cap.toolFn({}, state);
  const drained = await fetchSegmentData(cap, {}, state);
  assert.match(String(standDownReason(cap, drained)), /nothing fresh/);

  const empty = { ...cap, toolFn: makeFeedTool('empty-feed', { url: feedUrl('/empty'), maxItems: 5 }) };
  const none = await fetchSegmentData(empty, {}, {});
  assert.match(String(standDownReason(empty, none)), /nothing fresh/);

  // A fresh fire is still usable data — the change only touches the empty case.
  const fresh = await fetchSegmentData(cap, {}, {});
  assert.equal(standDownReason(cap, fresh), null);

  // An operator who opts the skill out of grounding still gets a run: the
  // shape tells the model why there are no items, it does not silence it.
  const writesAnyway = { ...cap, config: { ...cap.config, requiresData: 'false' } };
  assert.equal(standDownReason(writesAnyway, drained), null);
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
  const broken = { ...cap, toolFn: makeFeedTool('broken', { url: feedUrl('/boom'), maxItems: 5 }) };
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

// tool.mjs frontmatter forwarding (#1526) and prompt-only skills.
const configTool = caps.find(cap => cap.kind === 'config-tool');
const briefOnly = caps.find(cap => cap.kind === 'brief-only');

assert.ok(configTool, 'custom skill with tool.mjs loaded');
assert.ok(briefOnly, 'prompt-only skill loaded');

test('a non-News custom tool is named and receives all frontmatter as config', async () => {
  assert.equal(configTool.toolName, 'skill_config_tool');
  assert.equal(typeof configTool.toolFn, 'function');
  assert.deepEqual(configTool.config, toolConfig);

  const tools = buildSegmentTools({ time: {} }, {}, caps);
  assert.ok(tools['skill_config_tool'], 'custom tool is registered in the segment tool set');

  const result = await tools['skill_config_tool'].execute({});
  assert.deepEqual(result, { receivedConfig: toolConfig });
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
  assert.deepEqual(briefOnly.configFields.map((f: any) => f.key), ['feed', 'feedMaxItems', 'feedMaxAgeDays', 'feed2', 'feed3']);
});

// ---------------------------------------------------------------------------
// Item age and further feeds (fork: a Google News search ignored its own
// `when:7d` on a long query, 47 of 65 items were older, and an old event could
// air as upcoming; one local feed alone was too thin).
// ---------------------------------------------------------------------------

test('feedMaxAgeDays drops stale items before the cap, keeps undated ones, and hands the date on', async () => {
  const tool = makeFeedTool('dated', { url: feedUrl('/dated'), maxItems: 3, maxAgeDays: 7 });
  const result: any = await tool({}, {});
  // The cap of 3 counts only what survives the age filter.
  assert.deepEqual(result.headlines.map((h: any) => h.title), ["Tonight's talk", 'Undated notice', 'Film festival']);
  assert.match(result.headlines[0].published, /^\d{4}-\d{2}-\d{2}$/, 'a dated item carries its day');
  assert.equal('published' in result.headlines[1], false, 'an undated item carries no date key');
});

test('without feedMaxAgeDays every item is offered, as before', async () => {
  const tool = makeFeedTool('dated-all', { url: feedUrl('/dated'), maxItems: 10 });
  const result: any = await tool({}, {});
  assert.equal(result.headlines.length, 5);
});

test('a tighter window keeps only what is inside it, plus the undated item', async () => {
  const tool = makeFeedTool('dated-two', { url: feedUrl('/dated'), maxItems: 10, maxAgeDays: 2 });
  const result: any = await tool({}, {});
  assert.deepEqual(result.headlines.map((h: any) => h.title), ["Tonight's talk", 'Undated notice']);
});

test('the merged list is capped at feedMaxItems in total', async () => {
  const tool = makeFeedTool('merged-cap', { url: feedUrl('/other'), maxItems: 3, extraUrls: [feedUrl('/local')] });
  const result: any = await tool({}, {});
  assert.deepEqual(result.headlines.map((h: any) => h.title), ['Story 1', 'Local 1', 'Story 2']);
});

test("an item's day is the station's, not UTC's", async () => {
  try {
    setStationTimezone('Europe/Athens');
    const athens: any = await makeFeedTool('late-athens', { url: feedUrl('/late'), maxItems: 5 })({}, {});
    assert.equal(athens.headlines[0].published, '2026-10-31');
    setStationTimezone('UTC');
    const utc: any = await makeFeedTool('late-utc', { url: feedUrl('/late'), maxItems: 5 })({}, {});
    assert.equal(utc.headlines[0].published, '2026-10-30');
  } finally {
    setStationTimezone('');
  }
});

test('further feeds merge round-robin, a repeated headline appears once', async () => {
  const tool = makeFeedTool('merged', { url: feedUrl('/other'), maxItems: 10, extraUrls: [feedUrl('/local')] });
  const result: any = await tool({}, {});
  assert.deepEqual(result.headlines.map((h: any) => h.title), ['Story 1', 'Local 1', 'Story 2', 'Story 3', 'Local 2']);
});

test('one failing feed is skipped while another answers, and is reported once until it recovers', async () => {
  const warnings: string[] = [];
  const some = makeFeedTool('half', { url: feedUrl('/boom'), maxItems: 10, extraUrls: [feedUrl('/local')] }, m => warnings.push(m));
  const ok: any = await some({}, {});
  assert.deepEqual(ok.headlines.map((h: any) => h.title), ['Local 1', 'Story 2', 'Local 2']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /127\.0\.0\.1:\d+\/boom failed and was skipped.*HTTP 500/);
  await some({}, {});
  assert.equal(warnings.length, 1, 'the same failure is not repeated on every fire');
});

test('a failing feed is the answer when the feeds that answered have none', async () => {
  const tool = makeFeedTool('hidden', { url: feedUrl('/boom'), maxItems: 10, extraUrls: [feedUrl('/empty')] });
  await assert.rejects(() => tool({}, {}), /HTTP 500/, 'not { available: false, reason: "the feed has no items" }');
});

test('all feeds failing is the fetch error', async () => {
  const none = makeFeedTool('none', { url: feedUrl('/boom'), maxItems: 10, extraUrls: [feedUrl('/boom')] });
  await assert.rejects(() => none({}, {}), /HTTP 500/);
});

test('resolveFeedConfig reads the age cap and further feeds, warning on bad values', () => {
  const ok = resolveFeedConfig({ feed: 'https://a.test/rss', feed2: 'https://b.test/rss', feed3: 'https://a.test/rss', feedMaxAgeDays: '7' });
  assert.deepEqual(ok.feed, { url: 'https://a.test/rss', maxItems: 10, extraUrls: ['https://b.test/rss'], maxAgeDays: 7 });
  assert.deepEqual(ok.warnings, []);

  const bad = resolveFeedConfig({ feed: 'https://a.test/rss', feed2: 'ftp://b.test/x', feedMaxAgeDays: '0' });
  assert.deepEqual(bad.feed, { url: 'https://a.test/rss', maxItems: 10 }, 'bad extras and age fall back to the old shape');
  assert.equal(bad.warnings.length, 2);
  assert.match(bad.warnings.join(' '), /feed2: .* skipped/);
  assert.match(bad.warnings.join(' '), /feedMaxAgeDays: .* no age limit/);

  const orphan = resolveFeedConfig({ feed2: 'https://b.test/rss' });
  assert.equal(orphan.feed, null, 'a further feed without a first one is no feed');
  assert.match(orphan.warnings[0], /feed2: set, but "feed" is empty/);
});
