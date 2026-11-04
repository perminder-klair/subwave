// KOKORO_URL: the kokoro engine renders on a shared Kokoro server instead of
// its local worker (hosted boxes run one server per box). Pins that it sends
// the persona's own voice, the language and the composed speed; writes the WAV
// it gets back; reports availability from the server's /health; treats an
// empty or failed render as an error (so the dispatcher rescues); and never
// touches the local model. A fake server on 127.0.0.1 stands in for it.
//
// Run: `npm test -- kokoro-remote`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';

const seen: Record<string, unknown>[] = [];
const healthy = true;
let mode: 'ok' | 'empty' | 'error' = 'ok';

const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/health') {
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: healthy }));
  }
  if (req.url !== '/v1/speak') { res.writeHead(404); return res.end(); }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  seen.push(JSON.parse(raw));
  if (mode === 'error') { res.writeHead(500); return res.end('render failed'); }
  res.writeHead(200, { 'content-type': 'audio/wav' });
  res.end(mode === 'empty' ? '' : 'RIFF-fake-wav');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as AddressInfo;

// Before config.ts is imported: the URL is read once, at load.
process.env.KOKORO_URL = `http://127.0.0.1:${port}`;
process.env.KOKORO_SPEED = '1';
// Point the local worker at nothing: a test that reached it would fail loudly.
process.env.KOKORO_PYTHON = '/nonexistent/python';

const kokoro = await import('../src/audio/kokoro.js');

after(() => { kokoro.stop(); server.close(); });

test('renders on the shared server with the persona voice, language and speed', async () => {
  const out = await kokoro.speak('Coming up next, something loud.', { voice: 'bm_george', lang: 'en-gb', speedScale: 1.1 });
  assert.equal(await readFile(out, 'utf8'), 'RIFF-fake-wav');
  assert.deepEqual(seen.at(-1), { text: 'Coming up next, something loud.', voice: 'bm_george', lang: 'en-gb', speed: 1.1 });
});

test('falls back to the configured default voice when the persona has none', async () => {
  await kokoro.speak('Hello.');
  assert.equal(seen.at(-1)!.voice, 'bf_isabella');
});

test('availability follows the server /health, never the local model files', async () => {
  kokoro.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(kokoro.isAvailable(), true);
});

test('an empty body or a failed render is an error the dispatcher can rescue from', async () => {
  mode = 'empty';
  await assert.rejects(kokoro.speak('Silence?'), /empty response body/);
  mode = 'error';
  await assert.rejects(kokoro.speak('Broken?'), /kokoro server 500/);
  mode = 'ok';
});
