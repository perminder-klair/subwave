// Regression coverage for issue #1908: words the station aired that no model
// wrote never reach a later DJ prompt.
//
// A RAW POST /dj/say (the admin Say box, MCP's subwave_dj_announce and Connect
// agents all land there) was appended to the session as an ordinary `segment`
// turn, so the next generation read it back under "Already said on air
// recently" and "Recent opening words", and the pick/request agents saw it as
// their own assistant turn. Negative context is still context: a test emergency
// notice became the next banter's topic. The same held for a jingle's script,
// which the on-demand play exists to air as an announcement. Both must stay
// visible to the operator (booth log) and the listener booth (GET /session).
// STYLED says are the model's own words and keep their place in its memory.
//
// Run: npm test -- verbatim-prompt-memory

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatCompletionResponse } from './test-utils/llm.js';
import { listen } from './test-utils/http.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-verbatim-memory-'));
process.env.STATE_DIR = root;
// requireAdmin is a no-op with these unset, so the dj router mounts bare.
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { promptMemoryEntries, withheldFromPrompts, VERBATIM_META } = await import('../src/broadcast/prompt-memory.js');
const { shortlistConversation } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');
const { default: express } = await import('express');
const { router: djRouter } = await import('../src/routes/dj.js');
const { router: publicRouter } = await import('../src/routes/public.js');

const realFetch = globalThis.fetch;
const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;

const PICK_ASK = 'Track started — pick the next one.';
const EMERGENCY = 'Krisinformation test notice: shelter indoors near the harbour until further notice.';

const wav = join(root, 'clip.wav');
await writeSilentWav(wav, 100);

const app = express();
app.use(express.json());
app.use(djRouter);
app.use(publicRouter);
const http = await listen(app);

function context() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    activeShow: null,
  } as any;
}

async function say(body: Record<string, unknown>) {
  const res = await realFetch(`${http.url}/dj/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json() as Promise<{ spoken: string }>;
}

async function boothFeedTexts(): Promise<string[]> {
  const body = await (await realFetch(`${http.url}/session`)).json() as any;
  return body.messages.map((m: any) => m.text);
}

function windowText(): string {
  return session.windowMessages().map(m => m.content).join('\n');
}

beforeEach(() => {
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.djLog = [];
  queue._pendingVoice = null;
  (queue as any)._speak = async () => wav;
  (queue as any)._airVoice = async () => ({ voiceId: 'voice-test', clipMs: 1000, aired: Promise.resolve(null) });
  session.start(context());
  // windowMessages() drops leading assistant turns, so without an ask on the
  // user side every "not in the window" check below would pass on an empty one.
  session.appendTurn({ role: 'event', kind: 'pick', text: PICK_ASK });
});

after(async () => {
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
  queue.senderBusy = false;
  await http.close();
  // Let the session's debounced persist land before its directory goes.
  await new Promise(resolve => setTimeout(resolve, 1_100));
  rmSync(root, { recursive: true, force: true });
});

test('the policy withholds only an explicit verbatim stamp', () => {
  assert.equal(withheldFromPrompts({ meta: { ...VERBATIM_META } }), true);
  assert.equal(withheldFromPrompts({ meta: {} }), false);
  assert.equal(withheldFromPrompts({}), false);
  assert.equal(withheldFromPrompts(null), false);
  // A hand-edited session.json is read, not trusted: only a real boolean counts,
  // and a stray value keeps the pre-#1908 behaviour rather than hiding speech.
  assert.equal(withheldFromPrompts({ meta: { verbatim: 'true' } }), false);

  const t = new Date().toISOString();
  const entries = promptMemoryEntries([
    { t, role: 'segment', kind: 'dj-speak', text: 'Operator words.', meta: { ...VERBATIM_META } },
    { t, role: 'segment', kind: 'dj-speak', text: 'DJ words.', meta: {} },
  ]);
  assert.deepEqual(entries.map(e => e.message), ['DJ words.']);
});

test('a RAW /dj/say airs and is logged, but no prompt reads it back', async () => {
  const res = await say({ text: EMERGENCY, mode: 'raw' });
  assert.equal(res.spoken, EMERGENCY, 'raw is spoken verbatim');

  const turn = session.getSession()!.messages.at(-1)!;
  assert.equal(turn.role, 'segment');
  assert.equal(turn.text, EMERGENCY);
  assert.equal(turn.meta.verbatim, true);

  // The operator's booth log and the listener booth both keep the line.
  assert.ok(queue.djLog.some(e => e.message === EMERGENCY), 'booth log keeps the raw line');
  assert.ok((await boothFeedTexts()).includes(EMERGENCY), 'GET /session keeps the raw line');

  // Every prompt reader of the session is blind to it.
  assert.equal(queue.getDjRecap(), null, 'no "Already said on air recently" entry');
  assert.deepEqual(queue.getRecentOpeners(), [], 'no "Recent opening words" entry');
  assert.deepEqual(shortlistConversation(session.promptMemory()), {}, 'no Shortlist conversation entry');
  const window = windowText();
  assert.match(window, /pick the next one/, 'the window itself is not empty');
  assert.doesNotMatch(window, /Krisinformation|harbour/, 'not in the agent chat window');
});

test('a RAW say after the pick ask leaves the pick window ending on that ask', async () => {
  await say({ text: EMERGENCY, mode: 'raw', kind: 'link' });

  const window = session.pickWindowMessages();
  const last = window.at(-1)!;
  assert.equal(last.role, 'user');
  assert.match(last.content, /pick the next one/);
  assert.doesNotMatch(last.content, /aired after the pick request/,
    'a withheld line is not an aired turn the ask has to be handed back over');
  assert.doesNotMatch(window.map(m => m.content).join('\n'), /Krisinformation/);
});

test('a STYLED say keeps the model\'s own line in memory, and its prompt never sees an earlier RAW one', async (t) => {
  await settings.update({
    llm: { provider: 'openai-compatible', baseUrl: 'http://review.invalid/v1', model: 'test', fallback: { enabled: false } },
  } as never);
  await say({ text: EMERGENCY, mode: 'raw' });

  const prompts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith('/chat/completions')) return new Response('offline', { status: 503 });
    prompts.push(String(init?.body));
    return chatCompletionResponse('Quick one from the desk: the coffee machine has finally been fixed.');
  });

  const res = await say({ text: 'tell them the coffee machine works again', mode: 'styled' });
  assert.equal(res.spoken, 'Quick one from the desk: the coffee machine has finally been fixed.');

  assert.equal(prompts.length, 1, 'styled mode makes exactly one model call');
  assert.match(prompts[0], /coffee machine works again/, 'the instruction reaches the model');
  assert.doesNotMatch(prompts[0], /Krisinformation|harbour/, 'the earlier RAW line does not');

  // The styled line is ordinary DJ speech: it anti-repeats like any segment.
  assert.match(queue.getDjRecap() || '', /coffee machine has finally been fixed/);
  assert.deepEqual(queue.getRecentOpeners(), ['Quick one from the desk:']);
  assert.match(windowText(), /coffee machine has finally been fixed/);
  assert.doesNotMatch(queue.getDjRecap() || '', /Krisinformation/);
});

test('a jingle\'s script reaches the booth but not the agent chat window', async () => {
  const filename = 'jingle_0f0f0f0f.wav';
  mkdirSync(join(root, 'jingles'), { recursive: true });
  writeFileSync(join(root, 'jingles', filename), 'audio');
  writeFileSync(join(root, 'jingles.json'), JSON.stringify({ items: { [filename]: { text: EMERGENCY } } }));

  assert.deepEqual(await queue.playJingle(filename), { ok: true });

  const turn = session.getSession()!.messages.at(-1)!;
  assert.equal(turn.kind, 'jingle');
  assert.equal(turn.meta.verbatim, true);
  assert.ok((await boothFeedTexts()).includes(EMERGENCY), 'GET /session keeps the script');
  const window = windowText();
  assert.match(window, /pick the next one/, 'the window itself is not empty');
  assert.doesNotMatch(window, /Krisinformation/);
  rmSync(join(root, 'jingle-now.txt'), { force: true });
});
