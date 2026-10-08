// A community catalog skill can carry a feed.
//
// Catalog skills are prompt-only by policy: the catalog never ships code, so a
// skill installed from it had no data tool and could only write from its brief.
// The `feed:` mechanism (#1616) is data, not code — the loader generates the
// fetch tool from one URL — so a catalog entry may declare one, and install
// writes it as the skill's own `feed:` knob. This pins the whole route from the
// fetched index to a working tool: the normaliser keeps a good feed, drops an
// entry whose declared feed the loader would refuse (a brief written to report
// fetched items must not install with nothing to fetch), and install produces
// the same `skill_<name>` tool a hand-set feed does.
//
// The catalog and the feed are both served from one loopback server, and
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the dj router
// mounts bare.
//
// Run: `npm test -- community-skill-feed`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir } from './test-utils/temp-dir.js';

const STATE_DIR = createTempDir(join(tmpdir(), 'community-skill-feed-'));
process.env.STATE_DIR = STATE_DIR;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

let catalog: unknown = { skills: [] };
const fixtures = createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/catalog.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(catalog));
    return;
  }
  if (path === '/feed.xml') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>'
      + '<item><title>Band announces reunion</title><description>Dates in May.</description></item>'
      + '</channel></rss>');
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>(r => { fixtures.listen(0, '127.0.0.1', () => r()); });
fixtures.unref();
const fixtureBase = `http://127.0.0.1:${(fixtures.address() as AddressInfo).port}`;

// The catalog URL is read at config load, so it has to be set before the
// dynamic imports below.
process.env.COMMUNITY_CATALOG_URL = `${fixtureBase}/catalog.json`;

catalog = {
  skills: [
    { slug: 'press-bulletin', label: 'Press bulletin', brief: 'One headline from the feed.', feed: `${fixtureBase}/feed.xml`, feedMaxItems: 8 },
    { slug: 'plain-aside', label: 'Plain aside', brief: 'A brief with no feed.' },
    // The loader refuses a non-http(s) feed, so the entry must not install at all.
    { slug: 'ftp-feed', label: 'FTP feed', brief: 'From the feed.', feed: 'ftp://example.com/rss' },
    // A broken count is dropped; the feed and the entry survive.
    { slug: 'bad-count', label: 'Bad count', brief: 'From the feed.', feed: `${fixtureBase}/feed.xml`, feedMaxItems: 500 },
  ],
};

const express = (await import('express')).default;
const { router } = await import('../src/routes/dj.js');
const { discoverSeededKinds, loadedCapabilities } = await import('../src/skills/loader.js');
await discoverSeededKinds();

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(r => { server.listen(0, '127.0.0.1', () => r()); });
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function skillFile(slug: string): string {
  return readFileSync(join(STATE_DIR, 'skills', slug, 'SKILL.md'), 'utf8');
}

async function install(slug: string): Promise<Response> {
  return fetch(`${base}/dj/skills/community/${slug}/install`, { method: 'POST' });
}

test('the community listing carries a feed and drops an entry whose feed the loader would refuse', async () => {
  const res = await fetch(`${base}/dj/skills/community`);
  assert.equal(res.status, 200);
  const { community } = await res.json() as { community: any[] };
  const bySlug = Object.fromEntries(community.map(c => [c.slug, c]));

  assert.equal(bySlug['press-bulletin']?.feed, `${fixtureBase}/feed.xml`);
  assert.equal(bySlug['press-bulletin']?.feedMaxItems, 8);
  assert.ok(bySlug['plain-aside'], 'a prompt-only entry is unaffected');
  assert.equal(bySlug['plain-aside'].feed, undefined);
  assert.equal(bySlug['ftp-feed'], undefined, 'a declared feed the loader refuses drops the entry');
  assert.ok(bySlug['bad-count'], 'a bad count costs the count, not the entry');
  assert.equal(bySlug['bad-count'].feedMaxItems, undefined);
});

test('installing a feed skill writes the feed knob and the loader generates its tool', async () => {
  const res = await install('press-bulletin');
  assert.equal(res.status, 200);

  const file = skillFile('press-bulletin');
  assert.match(file, new RegExp(`^feed: ${fixtureBase}/feed.xml$`, 'm'));
  assert.match(file, /^feedMaxItems: 8$/m);

  const cap = loadedCapabilities().find(c => c.kind === 'press-bulletin');
  assert.ok(cap, 'the installed skill loads');
  assert.equal(typeof cap.toolFn, 'function', 'a catalog feed must reach the model as a tool');
  assert.equal(cap.toolName, 'skill_press_bulletin');

  const data = await cap.toolFn({}, {});
  assert.deepEqual(data, { headlines: [{ title: 'Band announces reunion', detail: 'Dates in May.' }] });
});

test('installing a prompt-only skill writes the same SKILL.md it always did', async () => {
  const res = await install('plain-aside');
  assert.equal(res.status, 200);

  const file = skillFile('plain-aside');
  assert.doesNotMatch(file, /^feed:/m);
  assert.doesNotMatch(file, /^feedMaxItems:/m);
  const cap = loadedCapabilities().find(c => c.kind === 'plain-aside');
  assert.ok(cap);
  assert.equal(cap.toolFn, undefined);
});

test('a dropped count installs the feed alone, on the station default', async () => {
  const res = await install('bad-count');
  assert.equal(res.status, 200);

  const file = skillFile('bad-count');
  assert.match(file, /^feed: /m);
  assert.doesNotMatch(file, /^feedMaxItems:/m);
});

test('an entry dropped from the catalog cannot be installed', async () => {
  const res = await install('ftp-feed');
  assert.equal(res.status, 404);
});
