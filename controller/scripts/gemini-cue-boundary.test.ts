// Exercise the dispatcher and authenticated HTTP preview, not just splitCues.
// Both HTTP servers and every WAV/state file belong to this test process.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const root = mkdtempSync(join(tmpdir(), 'subwave-gemini-cue-'));
process.env.STATE_DIR = root;
process.env.NODE_ENV = 'production';
process.env.ADMIN_USER = 'cue-test';
process.env.ADMIN_PASS = 'isolated-test';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'synthetic-key';

const settings = await import('../src/settings.js');
await settings.load();
const tts = await import('../src/audio/tts.js');
const remote = await import('../src/audio/remoteTts.js');
const { router } = await import('../src/routes/settings/tts.js');
const { normalizeForDisplay, normalizeForSpeech } = await import('../src/audio/speech-text.js');

// Genuine PCM WAV bytes keep file decoding/fades in the production path.
const wav = Buffer.alloc(44 + 48000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(48000, 40);
const audioReply = { output_audio: { data: wav.toString('base64') } };
const calls: { path: string; body: any }[] = [];
let geminiFailures = 0;
const provider = createServer(async (req, res) => {
  if (req.url === '/remote/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  calls.push({ path: req.url!, body: JSON.parse(raw) });
  if (req.url === '/remote/speak') {
    res.setHeader('Content-Type', 'audio/wav');
    res.end(wav);
  } else if (geminiFailures > 0) {
    geminiFailures--;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'synthetic outage' }));
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(audioReply));
  }
});
const app = express();
app.use(express.json());
app.use(router);
const api = createServer(app);
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const providerUrl = await listen(provider);
const apiUrl = await listen(api);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
    return realFetch(`${providerUrl}/interactions`, init);
  }
  if (url.startsWith(`${apiUrl}/`) || url.startsWith(`${providerUrl}/`)) {
    return realFetch(input, init);
  }
  throw new Error(`Unexpected external request: ${url}`);
}) as typeof fetch;
settings.get().tts.remote.url = `${providerUrl}/remote`;
await remote.refresh();

after(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([api, provider].map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  geminiFailures = 0;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'synthetic-key';
  settings.get().tts.defaultEngine = 'gemini';
  settings.get().tts.gemini = { model: '', voice: 'Kore', pronunciation: '' };
  settings.get().tts.fallback.enabled = false;
});

const auth = `Basic ${Buffer.from('cue-test:isolated-test').toString('base64')}`;
const persona = (engine = 'gemini') => ({
  name: 'Fixture', language: 'English', soul: '',
  tts: { engine, voice: engine === 'gemini' ? 'Puck' : 'remote-host' },
});
async function dispatch(text: string, engine = 'gemini') {
  const file = await tts.speak(text, {
    kind: 'link', persona: persona(engine), speedScale: 1,
    outPath: join(root, 'dispatch.wav'),
  });
  assert.equal((await readFile(file)).toString('ascii', 0, 4), 'RIFF');
  await unlink(file);
}
async function preview(text: string, engine = 'gemini', authorized = true) {
  const response = await fetch(`${apiUrl}/settings/tts/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: auth } : {}) },
    body: JSON.stringify({ engine, voice: 'Puck', speed: 1, text }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status === 200) {
    assert.match(response.headers.get('content-type')!, /audio\/wav/);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  }
  return response.status;
}
function turn(index = 0) {
  return calls.find(call => call.path === '/interactions')!.body.input[0].content[index];
}
for (const cue of ['short pause', 'medium pause', 'long pause', 'hisses']) {
  const tag = cue === 'hisses' ? 'hiss' : cue;
  test(`dispatcher carries ${cue} through display cleanup and speech policy`, async () => {
    await dispatch(normalizeForDisplay(`Wait. [${cue}] Continue.`));
    assert.equal(turn().text, `Wait. <${tag}> Continue.`);
    assert.equal(turn().annotations[0].style, '');
  });
  test(`authenticated preview carries ${cue} to Gemini`, async () => {
    assert.equal(await preview(`Wait. [${cue}] Continue.`), 200);
    assert.equal(turn().text, `Wait. <${tag}> Continue.`);
    assert.equal(turn().annotations[0].style, '');
  });
}

test('all other engines retain the pause-removal policy', () => {
  for (const engine of ['', 'piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote']) {
    for (const cue of ['short pause', 'medium pause', 'long pause']) {
      assert.equal(normalizeForSpeech(`Wait. [${cue}] Continue.`, [], '', engine), 'Wait. Continue.');
    }
  }
});
test('remote dispatcher and preview cannot receive Gemini pause instructions', async () => {
  await dispatch(normalizeForDisplay('Wait. [medium pause] Continue.'), 'remote');
  assert.equal(calls.at(-1)!.body.text, 'Wait. Continue.');
  assert.equal(await preview('Wait. [long pause] Continue.', 'remote'), 200);
  assert.equal(calls.at(-1)!.body.text, 'Wait. Continue.');
});
test('Gemini permits only supported pauses and keeps cue bounds and title protection', async () => {
  const text = normalizeForDisplay('Wait. [short pause] One. [medium pause] Two. [long pause] Three.');
  await dispatch(text);
  assert.equal(turn().text, 'Wait. <short pause> One. <medium pause> Two. Three.');
  calls.length = 0;
  assert.equal(await preview('Song [Live]. [ Long pause! ] Continue. [medium pause].'), 200);
  assert.equal(turn().text, 'Song Live. <long pause> Continue.');
});
test('Gemini still rejects bare, timed and compound production directions', async () => {
  for (const cue of ['pause', 'pausing briefly', 'pause 3 seconds', 'short pause fade out', '/short pause', '-long pause']) {
    calls.length = 0;
    assert.equal(await preview(`Wait. [${cue}] Continue.`), 200);
    assert.equal(turn().text, 'Wait. Continue.');
    assert.equal(turn().annotations[0].style, '');
  }
});
test('multi-speaker dispatcher preserves each Gemini turn pause', async () => {
  const file = await tts.speakExchange([
    { persona: persona(), text: 'Wait. [short pause] Continue.' },
    { persona: { ...persona(), tts: { engine: 'gemini', voice: 'Kore' } }, text: 'Yes. [medium pause] Indeed.' },
  ], { outPath: join(root, 'exchange.wav') });
  assert.equal(turn(0).text, 'Wait. <short pause> Continue.');
  assert.equal(turn(1).text, 'Yes. <medium pause> Indeed.');
  await unlink(file);
});
for (const preflight of [true, false]) {
  test(`${preflight ? 'preflight' : 'mid-render'} rescue removes Gemini cues`, async () => {
    settings.get().tts.fallback = { enabled: true, engine: 'remote', voice: 'rescue', cloudProvider: 'openai' };
    if (preflight) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else geminiFailures = 2;
    await dispatch('Wait. [medium pause] Continue. [sigh] Finish.');
    if (!preflight) {
      assert.equal(turn().text, 'Wait. <medium pause> Continue. <sigh> Finish.');
    }
    assert.equal(calls.at(-1)!.path, '/remote/speak');
    assert.equal(calls.at(-1)!.body.text, 'Wait. Continue. Finish.');
    assert.equal(calls.at(-1)!.body.voice, 'rescue');
  });
}
test('preview authentication is enforced before provider access', async () => {
  assert.equal(await preview('Wait. [medium pause] Continue.', 'gemini', false), 401);
  assert.equal(calls.length, 0);
});
