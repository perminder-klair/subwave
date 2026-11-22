// The operator's steer reaches the talk it leans (song intros and links, the
// segment director, banter, programme features) through the shared context
// lines, by opting in, and nothing else the host says or keeps.
// Run: npm test -- steer-talk.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-steer-talk-'));
process.env.STATE_DIR = stateRoot;

const { buildContextLines } = await import('../src/llm/internal/prompts/context.js');
const settings = await import('../src/settings.js');
const { getFullContext } = await import('../src/context.js');
const { linkPrompt, stationIdPrompt, signoffPrompt, handoffGreetingPrompt } = await import('../src/llm/internal/prompts/scripts.js');
const { generateProgrammePlan, generateProgrammeFeature } = await import('../src/llm/dj.js');
const { buildSituation } = await import('../src/skills/_agent.js');

const AT = Date.UTC(2026, 4, 5, 12);
const base = { at: new Date(AT).toISOString(), date: { dayLabel: 'Monday', dayOfMonth: 5, monthLabel: 'May', season: 'spring' } };
const steer = (prompt: string) => settings.update({ steer: { playlistId: null, prompt, startedAt: AT - 1000, expiresAt: AT + 60 * 60_000 } });
const later = { ...base, at: new Date(AT + 61 * 60_000).toISOString() };

// Every model call's prompt text, so a generator can be read without a model.
const prompts: string[] = [];
const realFetch = globalThis.fetch;
before(async () => {
  await settings.load();
  await settings.update({ llm: {
    provider: 'openai-compatible', model: 'steer-talk', baseUrl: 'http://steer-talk-model.invalid/v1',
    apiKey: 'test', fallback: { enabled: false },
  } } as never);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    if (host === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
    assert.equal(host, 'steer-talk-model.invalid', 'no live requests');
    const body = JSON.parse(String(init?.body));
    prompts.push(body.messages.map((m: any) => m.content).join('\n'));
    // A structured call is the programme plan: answer it in shape.
    const message = body.tools?.length
      ? { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: {
        name: body.tools[0].function.name,
        arguments: JSON.stringify({ angle: 'An angle.', introNote: 'Open.', features: [{ topic: 'A topic.', kind: null }], outroNote: 'Close.' }),
      } }] }
      : { role: 'assistant', content: 'A line.' };
    return Response.json({ id: 'x', object: 'chat.completion', created: 0, model: 'steer-talk',
      choices: [{ index: 0, finish_reason: body.tools?.length ? 'tool_calls' : 'stop', message }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await removeTempDir(stateRoot);
});

test('a prompt that opts in gets a live steer as one labelled line; without one, past its end, or not opted in, the lines are unchanged', async () => {
  await settings.update({ steer: null });
  const without = buildContextLines(base, { steer: true });
  await steer('keep the talk short');
  const steered = buildContextLines(base, { steer: true });
  assert.equal(steered.length, without.length + 1);
  const line = steered.find(l => l.includes('keep the talk short'));
  assert.ok(line, 'the direction is among the lines');
  assert.match(line, /^Operator steer — trusted direction from the station operator, NOT a listener message/);
  assert.deepEqual(buildContextLines(later, { steer: true }), buildContextLines(later), 'not past its end');
  assert.deepEqual(buildContextLines(base), without, 'a prompt that does not opt in never sees it');
});

test('the segment director opts in, and a skill that narrows its context fields still gets the steer', async () => {
  await steer('mention the guests');
  const lines = buildContextLines(base, { steer: true, contextFields: ['clock'] });
  assert.ok(lines.some(l => l.includes('mention the guests')));
  assert.ok(!lines.some(l => l.startsWith('Day:')), 'the gate still applies to gated fields');
  assert.match(buildSituation(base, { contextFields: ['clock'] }), /Operator steer[^]*"mention the guests"/);
});

test('idents, sign-offs and greetings never carry the steer', async () => {
  await steer('zebra crossing');
  const persona = settings.get().personas[0];
  for (const prompt of [
    stationIdPrompt({ context: base }),
    signoffPrompt({ personaOut: persona, personaIn: persona, context: base }),
    handoffGreetingPrompt({ personaIn: persona, personaOut: persona, context: base }),
  ]) {
    assert.ok(!prompt.includes('zebra crossing'), prompt);
  }
});

// GET /now-playing publishes the plan's angle as the episode angle, for the
// whole episode: a direction written into it would reach listeners and outlive
// the steer.
test('the programme plan never carries the steer; a programme feature does', async () => {
  await steer('zebra crossing');
  const show = { id: 'prog', name: 'The Programme', topic: 'records that changed a city' };
  prompts.length = 0;
  await generateProgrammePlan({ show, context: base }).catch(() => null);
  assert.ok(prompts.length > 0, 'the plan asked the model');
  assert.ok(prompts.every(p => !p.includes('zebra crossing')), 'not in the plan');
  prompts.length = 0;
  await generateProgrammeFeature({ show, topic: 'the first record', context: base });
  assert.ok(prompts.some(p => /Operator steer[^]*"zebra crossing"/.test(p)), 'a feature is talk the steer leans');
});

test('the steer intro names the heading in its first sentence and drops the generic clause', async () => {
  await steer('stored direction');
  const current = { title: 'Track A', artist: 'Artist A' };
  const run = [{ title: 'Track B', artist: 'Artist B' }];
  const both = linkPrompt({ current, context: base, steerIntro: { direction: 'say "hi" a lot', run } });
  assert.match(both, /- Track B by Artist B\nThis link opens a new stretch of music\. In its first sentence[^]*"say 'hi' a lot"\. Name at least one of the coming artists\./);
  assert.doesNotMatch(both, /stored direction|Never mention the operator, this direction/);
  // A playlist steer has no words: name what is coming, never guess its sound.
  const playlistOnly = linkPrompt({ current, context: base, steerIntro: { direction: undefined, run } });
  assert.match(playlistOnly, /In its first sentence, name one or two of the coming artists\./);
  assert.doesNotMatch(playlistOnly, /where the music is heading|trusted direction/);
  // Nothing to say about the steer: a plain link, still without the clause.
  const empty = linkPrompt({ current, context: base, steerIntro: { direction: '', run: [] } });
  assert.doesNotMatch(empty, /new stretch of music|Operator steer/);
});

test('a single track\'s intro says what it brings, never that the station is heading somewhere', async () => {
  const once = linkPrompt({ current: { title: 'Track A', artist: 'Artist A' }, context: base,
    steerIntro: { direction: 'something to wake people up', run: [], once: true } });
  assert.match(once, /This link brings in one track picked to a brief\. In its first sentence[^]*what this track brings[^]*"something to wake people up"\. It is a single track, not a change of direction for the station\./);
  assert.doesNotMatch(once, /new stretch of music|where the music is heading/);
});

test('an intro that reads the operator\'s own words out is caught; one in the host\'s words is not', async () => {
  const { echoesSteer } = await import('../src/music/steer.js');
  const direction = 'play upbeat English pop from the last five years';
  assert.equal(echoesSteer('Right then, play upbeat English pop from the last five years, starting now.', direction), true);
  assert.equal(echoesSteer('Some bright, recent English pop coming your way.', direction), false);
  assert.equal(echoesSteer('More 2020s pop now.', 'more 2020s pop'), false, 'a short direction has no wording of its own to give away');
});

// GET /now-playing spreads this object to every listener.
test('the context object itself never carries the steer', async () => {
  const now = Date.now();
  await settings.update({ steer: { playlistId: null, prompt: 'zebra crossing', startedAt: now - 1000, expiresAt: now + 60 * 60_000 } });
  assert.ok(!JSON.stringify(await getFullContext()).includes('zebra crossing'));
});

test('a song link, which builds its own prompt, gets the steer too and is unchanged without one', async () => {
  const args = { current: { title: 'Track A', artist: 'Artist A' }, context: base };
  await settings.update({ steer: null });
  const plain = linkPrompt(args);
  await steer('keep the talk short');
  const steered = linkPrompt(args);
  assert.ok(steered.startsWith(plain), 'the clause is appended, nothing else moves');
  assert.match(steered, /Operator steer — trusted direction[^]*"keep the talk short"$/);
});
