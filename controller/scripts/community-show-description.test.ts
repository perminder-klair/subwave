// A community catalog show can carry a listener description (#2358).
//
// The catalog index may name a show's `description`, the blurb listeners read
// on the schedule. Install writes it as the show's own description, so a
// template's blurb survives the trip from the index to settings, and an entry
// without one installs with the field empty, as a hand-made show does.
//
// The catalog is served from a loopback server, and requireAdmin is a no-op
// with ADMIN_USER/ADMIN_PASS unset, so the shows router mounts bare.
//
// Run: `npm test -- community-show-description`.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const STATE_DIR = createTempDir(join(tmpdir(), 'community-show-description-'));
process.env.STATE_DIR = STATE_DIR;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const BLURB = 'Ambient and downtempo to see you through the small hours.';

const catalog = {
  shows: [
    { slug: 'late-shift', name: 'Late Shift', topic: 'Keep the energy low.', description: BLURB },
    { slug: 'no-blurb', name: 'No Blurb', topic: 'A brief and nothing else.' },
  ],
};
const fixtures = createServer((req, res) => {
  if ((req.url || '').split('?')[0] === '/catalog.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(catalog));
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>(r => { fixtures.listen(0, '127.0.0.1', () => r()); });
fixtures.unref();

// Read at config load, so it has to be set before the dynamic imports below.
process.env.COMMUNITY_CATALOG_URL = `http://127.0.0.1:${(fixtures.address() as AddressInfo).port}/catalog.json`;

const express = (await import('express')).default;
const { router } = await import('../src/routes/shows.js');
const settings = await import('../src/settings.js');

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(r => { server.listen(0, '127.0.0.1', () => r()); });
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  server.close();
  fixtures.close();
  const db = await import('../src/music/library-db.js'); db.close();
  await removeTempDir(STATE_DIR);
});

async function install(slug: string) {
  const res = await fetch(`${base}/shows/community/${slug}/install`, { method: 'POST' });
  assert.equal(res.status, 200, await res.clone().text());
  await settings.load();
  const want = catalog.shows.find(s => s.slug === slug)!.name;
  return (settings.get().shows as any[]).find(s => s.name === want);
}

test('installing a catalog show keeps its listener description', async () => {
  const show = await install('late-shift');
  assert.equal(show.description, BLURB);
  assert.equal(show.topic, 'Keep the energy low.');
});

test('a catalog show without a description installs with it empty', async () => {
  const show = await install('no-blurb');
  assert.equal(show.description, '');
});
