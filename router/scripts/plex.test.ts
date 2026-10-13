// The Plex source against a stand-in server. A read that does not come back
// as JSON is not Plex talking — typically an SSO or proxy login page that
// fetch reached by following a redirect. It used to read as an empty
// container, so a misconfigured server looked healthy with 0 songs and a
// library walk could end early as if complete (#1827 review). Writes may
// still answer with nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '../src/host/loader.js';
import type { SourcePlugin } from '../src/sdk/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

async function plexAgainst(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ plex: SourcePlugin; seen: string[]; close(): void }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url!.split('?')[0]}`);
    handler(req, res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const loaded = await loadPlugin(resolve(here, '../src/sources/plex'), true);
  assert.equal(loaded.error, undefined);
  const plex = await loaded.factory!({ config: { url, token: 'x', section: '1' }, fetch, log: quiet, dataDir: '/tmp' });
  return { plex, seen, close: () => (server.closeAllConnections(), server.close()) };
}

test('a login page in place of Plex is an error, not an empty library', async () => {
  const { plex, close } = await plexAgainst((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>Please sign in</body></html>');
  });
  try {
    await assert.rejects(plex.stats!(), /did not answer JSON \(text\/html\)/);
    await assert.rejects(plex.albumList('alphabeticalByName', 50, 0), /did not answer JSON/);
  } finally {
    close();
  }
});

test('a write that answers nothing is still fine', async () => {
  const { plex, seen, close } = await plexAgainst((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    await plex.scrobble!('42', { submission: true });
    assert.deepEqual(seen, ['GET /:/scrobble']);
  } finally {
    close();
  }
});
