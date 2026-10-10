import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

const root = mkdtempSync(join(tmpdir(), 'subwave-gemini-style-'));
process.env.STATE_DIR = root;
process.env.PIPER_OUT = join(root, 'voice');
process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
process.env.ADMIN_USER = 'test';
process.env.ADMIN_PASS = 'test';
const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { personaSchema, PERSONA_VOICE_STYLE_MAX } = await import('../src/schemas/persona.js');
const tts = await import('../src/audio/tts.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('delivery style is validated, saved, and retained on a cold load', async () => {
  const persona = { ...settings.get().personas[0], voiceStyle: '  Warm and unhurried.  ',
    tts: { ...settings.get().personas[0].tts, engine: 'gemini', voice: 'Puck' } };
  await settings.update({ personas: [persona] });
  const saved = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
  assert.equal(saved.personas[0].voiceStyle, 'Warm and unhurried.');
  setCache(null);
  await settings.load();
  assert.equal(settings.get().personas[0].voiceStyle, 'Warm and unhurried.');
  assert.equal(personaSchema.safeParse({ ...persona, voiceStyle: 42 }).success, false);
  assert.equal(personaSchema.safeParse({ ...persona, voiceStyle: 'x'.repeat(PERSONA_VOICE_STYLE_MAX + 1) }).success, false);
  const { voiceStyle: _style, ...legacy } = persona;
  assert.equal(personaSchema.parse(legacy).voiceStyle, '');
});

test('load repairs bad styles without losing the persona', async () => {
  const stored = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
  for (const [raw, expected] of [[42, ''], ['x'.repeat(PERSONA_VOICE_STYLE_MAX + 1), 'x'.repeat(PERSONA_VOICE_STYLE_MAX)]] as const) {
    stored.personas[0].voiceStyle = raw;
    writeFileSync(join(root, 'settings.json'), JSON.stringify(stored));
    setCache(null);
    await settings.load();
    assert.equal(settings.get().personas[0].id, stored.personas[0].id);
    assert.equal(settings.get().personas[0].voiceStyle, expected);
  }
});

test('single-speaker dispatch and unsaved auditions deliver style outside the transcript', async t => {
  await settings.update({ tts: { defaultEngine: 'gemini' } });
  const styles: string[] = [];
  const texts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    const content = JSON.parse(String(init.body)).input[0].content[0];
    styles.push(content.annotations[0].style);
    texts.push(content.text);
    return Response.json({ output_audio: { data: Buffer.from('audio').toString('base64') } });
  });
  const persona = { ...settings.get().personas[0], voiceStyle: 'Warm and unhurried.' };
  await tts.speak('Hello.', { kind: 'link', persona, speedScale: 1 });
  await tts.synthesizeSample({ engine: 'gemini', voice: 'Puck', text: 'Hello.', voiceStyle: 'Dry and understated.' });
  await tts.speak('Station ident.', { kind: 'jingle', persona, speedScale: 1 });
  assert.match(styles[0], /^Warm and unhurried\./);
  assert.match(styles[1], /^Dry and understated\./);
  assert.doesNotMatch(styles[2], /Warm and unhurried/);
  assert.deepEqual(texts, ['Hello.', 'Hello.', 'Station ident.']);
});

test('the preview HTTP route forwards the unsaved delivery style to Google', async t => {
  const { router } = await import('../src/routes/settings/tts.js');
  const app = express();
  app.use(express.json(), router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const realFetch = globalThis.fetch;
  let style = '';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    style = JSON.parse(String(init?.body)).input[0].content[0].annotations[0].style;
    return Response.json({ output_audio: { data: Buffer.from('preview audio').toString('base64') } });
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/settings/tts/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic dGVzdDp0ZXN0' },
      body: JSON.stringify({ engine: 'gemini', voice: 'Puck', voiceStyle: 'Dry and understated.', speed: 1 }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'preview audio');
    assert.match(style, /^Dry and understated\./);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
