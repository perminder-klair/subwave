// Delivery-boundary regression for issue #1707 and PR #1715 review.
//
// The helper tests proved stripSpeakerLabel() works; they could not prove the
// callers reach it. They did not: announce() stripped only when given an
// explicit persona, so POST /dj/say — which omits one — still handed
// "Iris : Bonsoir…" to TTS, the very example that reported the bug. These tests
// assert on the text that arrives at _speak, not on the helper.
//
// Run: npm test -- speech-label-boundary

import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-speech-label-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { config } = await import('../src/config.js');
const { enqueuePick, trimLinkToIntro } = await import('../src/broadcast/dj-agent/enqueue.js');
const { awaitIntroRender } = await import('../src/broadcast/queue/intro-render.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');
const { withTalkAir } = await import('../src/broadcast/talk-air.js');

const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;

const template = settings.get().personas[0];
const IRIS = { ...template, id: 'p_iris', name: 'Iris' };
const LUCIFER = { ...template, id: 'p_lucifer', name: 'Lucifer' };
const SOLENE = { ...template, id: 'p_solene', name: 'Solène' };
const SHOW = 's_label';

function week() {
  const out: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) out[day] = Array(24).fill(SHOW);
  return out;
}

function ctx() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Label Show', topic: 'tests' },
  } as any;
}

/** Captures what actually reaches TTS. */
let spoken: string[] = [];
let speakers: string[] = [];
const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

beforeEach(async () => {
  spoken = [];
  speakers = [];
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue._pendingVoice = null;
  (queue as any)._speak = async (text: string, opts: any) => {
    spoken.push(text);
    speakers.push(opts.persona?.id ?? 'implicit');
    return wav;
  };
  (queue as any)._airVoice = async () => true;
  await settings.update({
    personas: [IRIS], activePersonaId: IRIS.id,
    shows: [{ id: SHOW, name: 'Label Show', topic: 'tests', personaId: IRIS.id }],
    schedule: week(), scheduleOverride: null,
    tts: { enabled: true },
  } as never);
  session.start(ctx());
});

after(async () => {
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  rmSync(root, { recursive: true, force: true });
});

// ── announce() without a persona — the /dj/say path ──────────────────────────

test('announce strips the label when no persona is passed', async () => {
  await queue.announce('Iris : Bonsoir les auditeurs.', 'dj-speak');
  assert.equal(spoken.length, 1, 'the clip must reach TTS');
  assert.equal(spoken[0], 'Bonsoir les auditeurs.',
    'POST /dj/say supplies no persona, yet the on-air speaker is known');
});

test('announce strips the label when the persona is explicit', async () => {
  await queue.announce('Iris: Bonsoir.', 'dj-speak', { persona: IRIS as never });
  assert.equal(spoken[0], 'Bonsoir.');
});

test('announce leaves an unknown name alone', async () => {
  await queue.announce('Bob : hello there.', 'dj-speak');
  assert.equal(spoken[0], 'Bob : hello there.',
    'only a known cast name is a label — anything else is speech');
});

test('announce leaves ordinary colon-bearing speech alone', async () => {
  await queue.announce('Une seule règle : on ne coupe pas le silence.', 'dj-speak');
  assert.equal(spoken[0], 'Une seule règle : on ne coupe pas le silence.');
});

// ── announceAtNextTrack() — the scheduled path ───────────────────────────────

test('announceAtNextTrack strips the label too', async () => {
  await queue.announceAtNextTrack('Iris : et maintenant, la suite.', 'station-id');
  assert.equal(spoken.length, 1, 'the scheduled clip renders its WAV immediately');
  assert.equal(spoken[0], 'et maintenant, la suite.',
    'scheduled segments reach _speak through their own method, which also needs the guard');
});

test('announceAtNextTrack leaves ordinary speech alone', async () => {
  await queue.announceAtNextTrack('Radio Subwave : toute la nuit.', 'station-id');
  assert.equal(spoken[0], 'Radio Subwave : toute la nuit.',
    'a station name that is not a cast member must survive');
});

test('valid long and quoted persona labels reach TTS without the name', async () => {
  const long = { ...IRIS, name: 'A'.repeat(40) };
  await settings.update({ personas: [long] } as never);
  await queue.announce(`${long.name}: Hello.`, 'dj-speak', { persona: long as never });
  await queue.announce('«Iris»: Bonsoir.', 'dj-speak', { persona: IRIS as never });
  assert.deepEqual(spoken, ['Hello.', 'Bonsoir.']);
});

test('a pick budgets cleaned speech before storage and pre-render', async () => {
  const host = { ...IRIS, djMode: true };
  await settings.update({ personas: [host] } as never);
  const song = { id: 'budget-song', title: 'Budget Song', artist: 'Artist', introMs: 4000 };
  const words = 'One two three four five six seven eight nine ten.';
  assert.equal(trimLinkToIntro('Iris : ' + words, song, host as never), words);
  await enqueuePick(queue, song, 'tests', 'tests', 'Iris : ' + words, null, {}, { introPersona: host as never });
  const item = queue.upcoming[0];
  assert.equal(item.introScript, words);
  await queue.startIntroRender(item);
  assert.deepEqual(spoken, [words]);
  assert.deepEqual(speakers, [IRIS.id]);
  await new Promise(resolve => setTimeout(resolve, 1_100));
  const stored = JSON.parse(readFileSync(config.queue.file, 'utf8'));
  assert.equal(stored.upcoming[0].introScript, words);
});

test('a queued request strips once and keeps its author for missing-WAV fallback', async () => {
  await queue.push({
    track: { id: 'request-song', title: 'Request Song', artist: 'Artist' },
    requestedBy: 'alice', introScript: 'Iris: Iris: a title with a colon.',
    introPersona: IRIS as never,
  });
  const item = queue.upcoming[0];
  assert.equal(item.introScript, 'Iris: a title with a colon.');
  await settings.update({ personas: [IRIS, LUCIFER], shows: [{ id: SHOW, name: 'Label Show', personaId: LUCIFER.id }] } as never);
  item.introWav = join(root, 'reaped.wav');
  await queue.airIntro(item);
  assert.deepEqual(spoken, ['Iris: a title with a colon.']);
  assert.deepEqual(speakers, [IRIS.id]);
  assert.equal(item.requestedBy, 'alice');
});

test('a recovered unchecked script is cleaned before the render identity is captured', async () => {
  const item = {
    track: { id: 'legacy-song', title: 'Legacy Song', artist: 'Artist' },
    introScript: '«Iris»: Bonsoir.', introPersona: IRIS, introKind: 'link',
  } as any;
  await queue.startIntroRender(item);
  assert.deepEqual(spoken, ['Bonsoir.']);
  assert.equal(item.introScript, 'Bonsoir.');
  assert.equal(item.introWav, wav, 'the cleaned render is still accepted by the identity guard');
});

test('a legacy script rendered only at air time is cleaned using its original speaker', async () => {
  const item = {
    track: { id: 'fallback-song', title: 'Fallback Song', artist: 'Artist' },
    introScript: 'Iris : Bonsoir.', introPersona: IRIS, introKind: 'dj-speak',
    introWav: join(root, 'missing.wav'),
  } as any;
  await queue.airIntro(item);
  assert.deepEqual(spoken, ['Bonsoir.']);
  assert.deepEqual(speakers, [IRIS.id]);
  assert.equal(item.introScript, 'Bonsoir.');
});

test('a timed-out clean render is reused at air time without stripping or rendering twice', async () => {
  await queue.push({ track: { id: 'slow', title: 'Slow', artist: 'Artist' }, introScript: 'Iris: Iris: Hello.', introPersona: IRIS as never });
  const item = queue.upcoming[0];
  let finish!: (path: string) => void;
  (queue as any)._speak = async (text: string) => {
    spoken.push(text);
    return new Promise<string>(resolve => { finish = resolve; });
  };
  const pending = queue.startIntroRender(item);
  assert.deepEqual(await awaitIntroRender(pending, 5), { status: 'timed-out' });
  const air = queue.airIntro(item);
  finish(wav);
  await air;
  assert.deepEqual(spoken, ['Iris: Hello.']);
  assert.equal(item.introScript, 'Iris: Hello.');
});

test('exchange delivery uses the generation cast even when a member has no speaking turn', async () => {
  const castNames = [IRIS, LUCIFER, SOLENE].map(p => p.name);
  // The live roster can change after the model was given its cast.
  await queue.announceExchange([
    { persona: IRIS as never, text: 'Solene : Bonsoir.' },
    { persona: LUCIFER as never, text: 'Iris: Oui.' },
    { persona: IRIS as never, text: 'Bob: still ordinary speech.' },
  ], 'banter', { castNames });
  assert.deepEqual(spoken, ['Bonsoir.', 'Oui.', 'Bob: still ordinary speech.']);
  assert.deepEqual(speakers, [IRIS.id, LUCIFER.id, IRIS.id]);
});

async function geminiExchange(t: TestContext) {
  const originalKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'isolated-label-test';
  t.after(() => {
    if (originalKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalKey;
  });
  await settings.update({ tts: { gainDb: { gemini: 2 } } });
  const host = { ...IRIS, tts: { engine: 'gemini', voice: 'Puck', cloudProvider: 'openai', gainDb: 3, speed: 1 } };
  const guest = { ...LUCIFER, tts: { ...host.tts, voice: 'Charon', gainDb: -4 } };
  return [
    { persona: host as never, text: 'Solene: Iris: a title with a colon.' },
    { persona: guest as never, text: 'Iris: Attention : voici la suite.' },
    { persona: host as never, text: 'Bob: still ordinary speech.' },
  ];
}

const cleanedExchange = ['Iris: a title with a colon.', 'Attention : voici la suite.', 'Bob: still ordinary speech.'];
const displayedExchange = cleanedExchange.map((text, i) => `${i === 1 ? LUCIFER.name : IRIS.name}: ${text}`).join('\n');

for (const placement of ['immediate', 'next-track'] as const) {
  test(`Gemini batch receives once-cleaned cast labels and stores the same text (${placement})`, async (t) => {
    const lines = await geminiExchange(t);
    const requests: string[][] = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.match(String(url), /\/interactions$/);
      const request = JSON.parse(String(init?.body));
      requests.push(request.input[0].content.map((item: { text: string }) => item.text));
      assert.deepEqual(request.input[0].content.map((item: { annotations: { speaker: string }[] }) => item.annotations[0].speaker), ['Puck', 'Charon', 'Puck']);
      return Response.json({ output_audio: { data: readFileSync(wav).toString('base64') } });
    });
    const aired: { text: string; gain: number }[] = [];
    (queue as any)._airVoice = async (_channel: string, _path: string, text: string, gain: number) => {
      aired.push({ text, gain });
      return { voiceId: 'batch-test', clipMs: 100, aired: Promise.resolve(null) };
    };
    const kind = placement === 'next-track' ? 'handoff' : 'banter';
    assert.equal(await withTalkAir(placement, () => queue.announceExchange(lines, kind, { castNames: [SOLENE.name] })), true);
    assert.deepEqual(requests, [cleanedExchange]);
    assert.deepEqual(spoken, [], 'a successful batch does not use the per-line renderer');
    if (placement === 'next-track') {
      const pending = queue._pendingVoice;
      assert.ok(pending);
      assert.equal(pending.clips.length, 1);
      assert.equal(pending.clips[0].text, displayedExchange);
      assert.equal(pending.clips[0].persona?.id, IRIS.id);
      assert.equal(pending.clips[0].settlesHandoff, true, 'the aggregate carries the final-line settlement flag');
      assert.deepEqual(aired, []);
      queue._pendingVoice = null;
    } else {
      await Promise.resolve();
      // Preserve the author's aggregate receipt. This is NOT per-speaker gain
      // or attribution: the single WAV takes its first persona's trim/metadata.
      assert.deepEqual(aired, [{ text: displayedExchange, gain: 5 }]);
      const turns = session.getSession()?.messages.filter(turn => turn.role === 'segment');
      assert.equal(turns?.length, 1);
      assert.equal(turns?.[0].text, displayedExchange.replaceAll('\n', ' '), 'post-air display normalization keeps the cleaned words');
      assert.equal(turns?.[0].meta.personaId, IRIS.id);
    }
  });
}

test('a rejected Gemini batch falls back without stripping the cleaned lines again', async (t) => {
  const lines = await geminiExchange(t);
  const requests: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /\/interactions$/);
    const request = JSON.parse(String(init?.body));
    requests.push(request.input[0].content.map((item: { text: string }) => item.text));
    return new Response('batch rejected', { status: 400 });
  });
  const aired: { text: string; gain: number }[] = [];
  (queue as any)._airVoice = async (_channel: string, _path: string, text: string, gain: number) => {
    aired.push({ text, gain });
    return { voiceId: `line-${aired.length}`, clipMs: 100, aired: Promise.resolve(null) };
  };
  assert.equal(await queue.announceExchange(lines, 'handoff', { castNames: [SOLENE.name] }), true);
  await Promise.resolve();
  assert.deepEqual(requests, [cleanedExchange]);
  assert.deepEqual(spoken, cleanedExchange);
  assert.deepEqual(speakers, [IRIS.id, LUCIFER.id, IRIS.id]);
  assert.deepEqual(aired, cleanedExchange.map((text, i) => ({ text, gain: i === 1 ? -2 : 5 })));
  const turns = session.getSession()?.messages.filter(turn => turn.role === 'segment');
  assert.deepEqual(turns?.map(turn => turn.text), cleanedExchange);
  assert.deepEqual(turns?.map(turn => turn.meta.personaId), [IRIS.id, LUCIFER.id, IRIS.id]);
});

test('the banter runner carries its complete captured cast through generation into delivery', async () => {
  const { runBanter } = await import('../src/broadcast/scheduler.js');
  await settings.update({
    personas: [IRIS, LUCIFER, SOLENE],
    shows: [{ id: SHOW, name: 'Label Show', topic: 'tests', personaId: IRIS.id, guestPersonaIds: [LUCIFER.id, SOLENE.id] }],
    llm: { provider: 'openai-compatible', baseUrl: 'http://review.invalid/v1', model: 'test', fallback: { enabled: false } },
  } as never);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/chat/completions')) throw new Error('external network disabled in speech regression');
    calls += 1;
    const request = JSON.parse(String(init?.body));
    assert.match(JSON.stringify(request.messages), /Solène/);
    // Change the live cast while the model is in flight. Delivery must keep
    // the prompt's known names and each returned line's original voice.
    await settings.update({ shows: [{ id: SHOW, name: 'Label Show', personaId: IRIS.id }] } as never);
    return new Response(JSON.stringify({
      id: 'speech-test', object: 'chat.completion', created: 1, model: 'test',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'emit-test', type: 'function', function: {
          name: request.tools[0].function.name,
          arguments: JSON.stringify({ lines: [
            { speaker: IRIS.id, text: 'Solène: Bonsoir.' },
            { speaker: LUCIFER.id, text: 'Iris : Oui.' },
            { speaker: IRIS.id, text: 'Et la suite.' },
          ] }),
        } }],
      } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await runBanter();
    assert.equal(calls, 1);
    assert.deepEqual(spoken, ['Bonsoir.', 'Oui.', 'Et la suite.']);
    assert.deepEqual(speakers, [IRIS.id, LUCIFER.id, IRIS.id]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
