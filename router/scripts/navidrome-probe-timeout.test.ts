import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { configWith, startRouter } from './helpers.js';

test('an oversized extensions timeout cannot reject the Navidrome library', async () => {
  const payloads: Record<string, Record<string, unknown>> = {
    getArtists: { artists: { index: [] } },
    getGenres: { genres: { genre: [] } },
    getScanStatus: { scanStatus: { scanning: false, count: 0 } },
    getStarred2: { starred2: { song: [] } },
  };
  const upstream = createServer((req, res) => {
    const endpoint = new URL(req.url ?? '/', 'http://test').pathname.replace('/rest/', '').replace(/\.view$/, '');
    if (endpoint === 'getOpenSubsonicExtensions') return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...payloads[endpoint] } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const router = await startRouter({ env: { ROUTER_NAVIDROME_PROBE_MS: '20000', ROUTER_POLL_MS: '60000' } });
  try {
    router.writeConfig(configWith([{ plugin: 'navidrome', rawIds: true, config: {
      url: `http://127.0.0.1:${address.port}`, user: 'radio', password: 'test-password',
    } }]));
    const response = await router.internal('/reload', { method: 'POST' });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.configError, null);
    assert.deepEqual(status.active.map((entry: { plugin: string }) => entry.plugin), ['navidrome']);
    assert.equal(status.serving.capabilities.sonicSimilarity, false);
    assert.equal((await router.rest('ping')).status, 'ok');
  } finally {
    await router.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
