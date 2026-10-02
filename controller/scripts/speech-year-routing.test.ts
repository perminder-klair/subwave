// Date normalization must use the same speaker language on air, in previews
// and when budgeting a link. The remote engine is mocked at its HTTP boundary.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-speech-year-routing-'));
process.env.STATE_DIR = root;
process.env.PIPER_OUT = join(root, 'voice');
const realGoogleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'speech-year-test-key';
writeFileSync(join(root, 'settings.json'), JSON.stringify({
  tts: { defaultEngine: 'remote', remote: { url: 'https://speech-year.test' } },
}));

const settings = await import('../src/settings.js');
await settings.load();
const tts = await import('../src/audio/tts.js');
const remote = await import('../src/audio/remoteTts.js');
const { trimLinkToIntro, enqueuePick } = await import('../src/broadcast/dj-agent/enqueue.js');

const requests: string[] = [];
type GeminiRequest = {
  model: string;
  input: { content: { text: string; annotations: { style: string }[] }[] }[];
};
const geminiRequests: GeminiRequest[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url === 'https://generativelanguage.googleapis.com/v1beta/interactions') {
    geminiRequests.push(JSON.parse(String(init?.body)));
    return Response.json({ output_audio: { data: Buffer.from('mock audio').toString('base64') } });
  }
  assert.ok(url.startsWith('https://speech-year.test/'), `unexpected network request: ${url}`);
  if (url.endsWith('/health')) return Response.json({ ok: true });
  assert.ok(url.endsWith('/speak'));
  requests.push(JSON.parse(String(init?.body)).text);
  // The dispatcher accepts non-WAV results without trying to edit their edges.
  return new Response('mock audio', { headers: { 'content-type': 'audio/wav' } });
}) as typeof fetch;
await remote.refresh();

after(() => {
  globalThis.fetch = realFetch;
  if (realGoogleKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  else process.env.GOOGLE_GENERATIVE_AI_API_KEY = realGoogleKey;
  rmSync(root, { recursive: true, force: true });
});

const french = {
  ...settings.get().personas[0], id: 'p_french', name: 'French host',
  language: 'French', djMode: true,
  tts: { engine: 'remote', voice: 'french', speed: 1 },
};

test('on-air speech follows the explicit speaker language and keeps quantities numeric', async () => {
  const text = 'Sorti en 1967. Une durée de 1967 ms et un prix de ₹1967.';
  await tts.speak(text, { kind: 'link', persona: french, speedScale: 1 });
  assert.equal(requests.at(-1), text);
  await tts.speak('Released in 1967.', {
    kind: 'link', persona: { ...french, language: 'English' }, speedScale: 1,
  });
  assert.equal(requests.at(-1), 'Released in nineteen sixty-seven.');
});

test('voice previews use their requested language independently of the active host', async () => {
  await tts.synthesizeSample({ engine: 'remote', text: 'Sorti en 1967.', language: 'French' });
  assert.equal(requests.at(-1), 'Sorti en 1967.');
  await tts.synthesizeSample({ engine: 'remote', text: 'Released in 1967.', language: 'en-GB' });
  assert.equal(requests.at(-1), 'Released in nineteen sixty-seven.');
  await tts.synthesizeSample({
    engine: 'remote', text: 'Sorti en 1967.', language: 'French',
    corrections: [{ from: '1967', to: 'mille neuf cent soixante-sept' }],
  });
  assert.equal(requests.at(-1), 'Sorti en mille neuf cent soixante-sept.');
});

test('intro budgets and enqueue use the captured speaker language rather than the active host', async () => {
  // Engine × persona pace clamps to 2 at every daypart. A 2.5s runway fits
  // twelve words, so French fits while the sixteen-word English reading does not.
  await settings.update({ tts: { speed: { remote: 2 } } });
  const speaker = { ...french, tts: { ...french.tts, speed: 2 } };
  const song = { title: 'Song', artist: 'Artist', introMs: 2500 };
  const text = 'Sorti en 1967. Sorti en 1972. Sorti en 1984. Sorti en 1991.';
  assert.equal(trimLinkToIntro(text, song, speaker), text);
  const english = { ...speaker, language: 'English' };
  assert.equal(trimLinkToIntro(text, song, english),
    'Sorti en 1967. Sorti en 1972. Sorti en 1984.');

  let queued: { introScript: string | null; introPersona: unknown } | undefined;
  await enqueuePick({
    push: async (item) => { queued = item; return 0; },
    log: () => {},
  }, song, 'test', 'test', text, null, {}, { introPersona: speaker });
  assert.equal(queued?.introScript, text);
  assert.equal(queued?.introPersona, speaker);
});

test('Gemini previews retain the requested model and speech language together', async () => {
  await tts.synthesizeSample({
    engine: 'gemini', voice: 'Puck', geminiModel: 'gemini-3.8-flash-tts',
    text: 'Sorti en 1967.', language: 'French', speed: 1,
  });
  const request = geminiRequests.at(-1)!;
  assert.equal(request.model, 'gemini-3.8-flash-tts');
  assert.equal(request.input[0].content[0].text, 'Sorti en 1967.');
});

test('Gemini exchanges normalize each speaker in their own language and keep delivery styles', async () => {
  await tts.speakExchange([
    {
      persona: { ...french, voiceStyle: 'warm', tts: { engine: 'gemini', voice: 'Puck' } },
      text: 'Sorti en 1967.',
    },
    {
      persona: { ...french, language: 'English', voiceStyle: 'dry', tts: { engine: 'gemini', voice: 'Kore' } },
      text: 'Released in 1967. Measured at 1967 ms, 1967 g and ₹1967.',
    },
  ]);
  const turns = geminiRequests.at(-1)!.input[0].content;
  assert.deepEqual(turns.map((turn) => turn.text), [
    'Sorti en 1967.',
    'Released in nineteen sixty-seven. Measured at 1967 ms, 1967 g and ₹1967.',
  ]);
  assert.match(turns[0].annotations[0].style, /warm/);
  assert.match(turns[1].annotations[0].style, /dry/);
});
