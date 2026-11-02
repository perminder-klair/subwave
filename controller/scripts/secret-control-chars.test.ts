// Every save path strips control characters from a secret (#2130). A key pasted
// across a line wrap through the API, or restored from a backup, is joined
// rather than refused, as the admin form's inputs already do for line breaks;
// stored with the break, it would fail every call with a fetch error quoting
// the whole key. The lenient load path leaves a stored value alone, so an
// upgrade is byte-identical. The rule is stripSecretControlChars in
// schemas/settings.ts.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the router mounts
// bare over real HTTP against a temp state dir.
//
// Run: `npm test -- secret-control-chars`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';
import { listen as listenHttp } from './test-utils/http.js';
import { coldLoadSettings } from './test-utils/settings.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-secret-control-chars-'));
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
for (const k of ['ELEVENLABS_API_KEY', 'SEARCH_API_KEY']) delete process.env[k];

const express = (await import('express')).default;
const { STATE_DIR } = await import('../src/config.js');
const settings = await import('../src/settings.js');
const { saveSecrets } = await import('../src/setup/secrets.js');
const { stripSecretControlChars } = await import('../src/schemas/settings.js');
const { router } = await import('../src/routes/settings/core.js');
await settings.load();

const app = express();
app.use(express.json());
app.use(router);
const { server, url: base } = await listenHttp(app);
server.unref();

test('stripSecretControlChars drops every C0 control and DEL, and nothing else', () => {
  assert.equal(stripSecretControlChars('sk-a\nb\rc\u0000d\te\u001ff\u007fg'), 'sk-abcdefg');
  assert.equal(stripSecretControlChars('Bearer sk-ok é…'), 'Bearer sk-ok é…');
});

test('settings.update strips each inline secret', async () => {
  await settings.update({
    llm: { provider: 'openai', model: 'gpt-x', apiKey: 'sk-llm\npart2' },
    tts: { cloud: { apiKey: 'el-tts\r\npart2', compatApiKey: 'compat\u0000part2' } },
    search: { apiKey: 'tvly-search\npart2' },
    embedding: { apiKey: 'emb\u007fpart2' },
    scrobble: {
      lastfm: { apiKey: 'lfm\nkey', apiSecret: 'lfm\nsecret', sessionKey: 'lfm\nsession' },
      listenbrainz: { userToken: 'lb\ntoken' },
    },
    webhooks: [{ url: 'https://example.com/hook', events: ['track.play'], authHeader: 'Bearer wh\npart2' }],
  });
  const s = settings.get();
  assert.equal(s.llm.keys.openai, 'sk-llmpart2');
  assert.equal(s.tts.cloud.apiKey, 'el-ttspart2');
  assert.equal(s.tts.cloud.compatApiKey, 'compatpart2');
  assert.equal(s.search.apiKey, 'tvly-searchpart2');
  assert.equal(s.embedding.apiKey, 'embpart2');
  assert.equal(s.scrobble.lastfm.apiKey, 'lfmkey');
  assert.equal(s.scrobble.lastfm.apiSecret, 'lfmsecret');
  assert.equal(s.scrobble.lastfm.sessionKey, 'lfmsession');
  assert.equal(s.scrobble.listenbrainz.userToken, 'lbtoken');
  assert.equal(s.webhooks[0].authHeader, 'Bearer whpart2');
});

// Backup restore replays a whole settings.json through update(), so a backup
// holding a broken key restores with it repaired instead of failing.
test('a backup-shaped update with a broken key restores, repaired', async () => {
  const backup = structuredClone(settings.get());
  backup.search.apiKey = 'tvly-restored\npart2';
  await settings.update(backup);
  assert.equal(settings.get().search.apiKey, 'tvly-restoredpart2');
});

test('the load path leaves a stored control character alone', async () => {
  const loaded = await coldLoadSettings({ search: { provider: 'tavily', apiKey: 'tvly-hand\u0001edited' } });
  assert.equal(loaded.search.apiKey, 'tvly-hand\u0001edited');
});

test('saveSecrets strips before writing the file and the live env', async () => {
  await saveSecrets({ ELEVENLABS_API_KEY: 'el-env\npart2' });
  assert.equal(process.env.ELEVENLABS_API_KEY, 'el-envpart2');
  assert.match(readFileSync(path.join(STATE_DIR, 'secrets.env'), 'utf8'), /^ELEVENLABS_API_KEY=el-envpart2$/m);
});

test('POST /settings/secrets: a broken key is saved joined; one of only control characters keeps the stored key', async () => {
  const post = async (body: Record<string, string>) => {
    const res = await fetch(`${base}/settings/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return await res.json() as { saved: string[] };
  };
  assert.deepEqual(await post({ SEARCH_API_KEY: 'tvly-route\npart2' }), { saved: ['SEARCH_API_KEY'] });
  assert.equal(process.env.SEARCH_API_KEY, 'tvly-routepart2');
  assert.deepEqual(await post({ SEARCH_API_KEY: '\u0001\u0002' }), { saved: [] });
  assert.equal(process.env.SEARCH_API_KEY, 'tvly-routepart2');
});
