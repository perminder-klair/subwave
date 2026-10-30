// A jingle created with a chosen voice is read in that voice; without one the
// station default reads. Drives jingles.create through the real speech dispatcher
// against a stubbed remote engine. Run: npm test -- jingle-voice

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(path.join(tmpdir(), 'jingle-voice-'));
process.env.STATE_DIR = stateDir;
writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({
  tts: { defaultEngine: 'remote', remote: { url: 'https://remote.test' } },
}));

const settings = await import('../src/settings.js');
await settings.load();
const remoteTts = await import('../src/audio/remoteTts.js');
const jingles = await import('../src/broadcast/jingles.js');
const tts = await import('../src/audio/tts.js');
const { jingleCreateBodySchema } = await import('../src/schemas/imaging-server.js');

const sent: Array<{ voice: unknown; text: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith('/health')) return Response.json({ ok: true });
  const body = JSON.parse(String(init?.body || '{}'));
  sent.push({ voice: body.voice, text: body.text });
  return new Response(Buffer.from('audio'), { status: 200, headers: { 'content-type': 'audio/wav' } });
}) as typeof fetch;
await remoteTts.refresh();

test.after(() => {
  globalThis.fetch = realFetch;
  rmSync(stateDir, { recursive: true, force: true });
});

test('a jingle with a voice slot is read in that voice, and without one in the station default', async () => {
  const { tts } = jingleCreateBodySchema.parse({
    text: 'x', tts: { engine: 'remote', voice: 'ident-voice', cloudProvider: 'openai' },
  });
  await jingles.create('Station ident.', { tts });
  await jingles.create('Station ident.');
  assert.deepEqual(sent.map(s => s.voice), ['ident-voice', '']);
});

test('a chosen voice changes nothing else about how a jingle is spoken', async () => {
  sent.length = 0;
  const text = 'こんにちは。 Hello.';
  const slot = { engine: 'remote', voice: 'ident-voice', cloudProvider: 'openai', gainDb: 6, speed: 2 };
  await jingles.create(text, { tts: slot });
  await jingles.create(text);
  assert.equal(sent[0].text, sent[1].text);
  assert.match(String(sent[0].text), /こんにちは/);
  // The slot's own pace and trim are a persona's dials, not a jingle's.
  assert.equal(tts.speechPaceScale('jingle', { tts: slot }), tts.speechPaceScale('jingle'));
  assert.equal(tts.voiceGainDb('jingle', { tts: slot }), tts.voiceGainDb('jingle'));
});

test('the create body takes no slot, the inherit slot, and refuses a bad one at tts', () => {
  assert.equal(jingleCreateBodySchema.parse({ text: 'x' }).tts, undefined);
  assert.equal(jingleCreateBodySchema.parse({ text: 'x', tts: { engine: 'inherit', cloudProvider: 'openai' } }).tts?.engine, 'inherit');
  const bad = jingleCreateBodySchema.safeParse({ text: 'x', tts: { engine: 'nope' } });
  assert.equal(bad.success, false);
  assert.equal(bad.error?.issues[0].path[0], 'tts');
});
