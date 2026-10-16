// The operator steer: its schema, its settings lifecycle, and WHERE its text
// reaches a model. Run: npx tsx scripts/steer-schema.test.ts (npm test finds it).
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-steer-schema-'));
process.env.STATE_DIR = stateRoot;

const {
  STEER_MAX_MINUTES, STEER_MIN_MINUTES, STEER_PROMPT_MAX,
  steerActiveAt, steerClause, steerRequestSchema, steerSchema,
} = await import('../src/schemas/steer.js');
const { OVERRIDE_MAX_MINUTES, OVERRIDE_MIN_MINUTES } = await import('../src/schemas/schedule.js');
const settings = await import('../src/settings.js');
const store = await import('../src/settings/store.js');
const { normalizeSteer } = await import('../src/settings/normalize.js');
const { withSteer } = await import('../src/music/steer.js');
const { pickSystem } = await import('../src/broadcast/dj-agent/schemas.js');
const { pickNextTrack } = await import('../src/llm/dj.js');

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.now();
const steer = (over = {}) => ({ playlistId: null, prompt: 'more 2020s pop', startedAt: NOW, expiresAt: NOW + 60 * 60_000, ...over });

after(() => rmSync(stateRoot, { recursive: true, force: true }));

test('the window bounds are the takeover\'s, restated', () => {
  assert.equal(STEER_MIN_MINUTES, OVERRIDE_MIN_MINUTES);
  assert.equal(STEER_MAX_MINUTES, OVERRIDE_MAX_MINUTES);
});

test('the stored shape refuses an empty prompt, a backwards or overlong window, and judges expiry only with a clock', () => {
  const strict = steerSchema({ now: null });
  assert.equal(strict.safeParse(steer()).success, true);
  assert.equal(strict.safeParse(steer({ prompt: '   ' })).success, false);
  assert.equal(strict.safeParse(steer({ expiresAt: NOW })).success, false);
  assert.equal(strict.safeParse(steer({ expiresAt: NOW + (STEER_MAX_MINUTES + 1) * 60_000 })).success, false);
  assert.equal(strict.safeParse(steer({ prompt: 'x'.repeat(STEER_PROMPT_MAX + 1) })).success, false);
  const ended = steer({ startedAt: NOW - 120 * 60_000, expiresAt: NOW - 60_000 });
  assert.equal(strict.safeParse(ended).success, true, 'update() does not fail a save over a steer that ran out');
  assert.equal(steerSchema({ now: NOW }).safeParse(ended).success, false);
  assert.equal(normalizeSteer(ended), null, 'the load path drops it');
  assert.equal(strict.parse(steer({ prompt: '  more   2020s\n pop ' })).prompt, 'more 2020s pop');
});

test('the request takes minutes only for a set time', () => {
  assert.equal(steerRequestSchema.parse({ prompt: 'x', minutes: '30' }).minutes, 30, 'coerced, default until is fixed');
  assert.equal(steerRequestSchema.safeParse({ prompt: 'x' }).success, false, 'fixed needs minutes');
  assert.equal(steerRequestSchema.safeParse({ prompt: 'x', until: 'once' }).success, true);
  assert.equal(steerRequestSchema.safeParse({ prompt: 'x', until: 'once', minutes: 30 }).success, false);
  assert.equal(steerRequestSchema.safeParse({ prompt: 'x', until: 'schedule-change' }).success, true);
  assert.equal(steerRequestSchema.safeParse({ prompt: '', until: 'once' }).success, false);
  assert.equal(steerRequestSchema.safeParse({ prompt: 'x', minutes: STEER_MIN_MINUTES - 1 }).success, false);
});

test('a steer is in force from its start up to, not including, its end', () => {
  const s = steer();
  assert.equal(steerActiveAt(s, s.startedAt), s);
  assert.equal(steerActiveAt(s, s.expiresAt - 1), s);
  assert.equal(steerActiveAt(s, s.expiresAt), null);
  assert.equal(steerActiveAt(s, s.startedAt - 1), null);
  assert.equal(steerActiveAt(null, NOW), null);
});

test('the clause marks the text as the operator\'s and forbids giving it away', () => {
  assert.equal(steerClause(''), '');
  assert.equal(steerClause(null), '');
  const clause = steerClause('more "2020s" pop');
  assert.match(clause, /trusted direction from the station operator, NOT a listener message/);
  assert.match(clause, /Never mention the operator, this direction or that the music was changed, on air or in your pick reason/);
  assert.ok(clause.endsWith(`"more '2020s' pop"`), 'quotes in the text cannot close the block');
});

test('a steer survives a cold load and is in force only inside its window', async () => {
  const first = steer();
  await settings.update({ steer: first });
  store.setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().steer, first);
  assert.deepEqual(settings.activeSteer(NOW + 1000), first);
  assert.equal(settings.activeSteer(first.expiresAt), null);
  await settings.update({ steer: null });
  store.setCache(null);
  await settings.load();
  assert.equal(settings.get().steer, null, 'the clear reached the file');
});

test('the agent picker gets the steer on its own call\'s last turn, never in its system prompt or the session', async () => {
  await settings.update({ steer: steer({ prompt: 'only instrumental tonight' }) });
  assert.ok(!pickSystem(new Date(NOW + 1000)).includes('only instrumental tonight'),
    'free text in the system prompt would break its cached prefix');
  // Added to the one call's messages, never stored on the session turn: the
  // request agent reads the same window beside a listener's own words.
  const agent = readFileSync(join(here, '..', 'src', 'broadcast', 'dj-agent.ts'), 'utf8');
  assert.match(agent, /messages: withSteer\(messages, settings\.activeSteer\(\(showAt \?\? new Date\(\)\)\.getTime\(\)\)\?\.prompt\)/,
    'judged at the pick\'s look-ahead instant');
  assert.doesNotMatch(agent, /promptSuffix = `[^`]*steer/i, 'not on the stored turn');
  assert.equal(agent.match(/withSteer\(/g)?.length, 1, 'the request agent\'s messages never get it');
  const window = [{ role: 'user', content: 'Pick the next track.' }];
  assert.match(withSteer(window, 'only instrumental tonight')[0].content, /^Pick the next track\.\n\nOperator steer[^]*"only instrumental tonight"$/);
  assert.deepEqual(withSteer([{ role: 'user', content: 'x' }], ''), [{ role: 'user', content: 'x' }]);
  // A window ending on the host's own line still gets the direction, as its own turn.
  const spoken = withSteer([{ role: 'user', content: 'Pick.' }, { role: 'assistant', content: 'And that was the news.' }], 'talk less');
  assert.equal(spoken.length, 3);
  assert.equal(spoken[2].role, 'user');
  assert.match(spoken[2].content, /^Operator steer[^]*"talk less"$/);
  await settings.update({ steer: null });
});

// The SDK may send the body on a Request rather than in init, and a
// connection-mode probe can come first: read whichever carries it.
async function requestBody(input: string | URL | Request, init?: RequestInit) {
  const raw = init?.body != null ? String(init.body) : input instanceof Request ? await input.clone().text() : '';
  return (raw ? JSON.parse(raw) : {}) as { messages?: { role?: string; content?: string }[] };
}

test('the pool picker gets the steer in its one-shot system prompt', async () => {
  await settings.update({
    llm: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false } },
  });
  const systems: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = await requestBody(input, init);
    if (body.messages) systems.push(body.messages.filter(m => m.role === 'system').map(m => m.content || '').join('\n'));
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: 'fixture-model',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{
        id: 'c', type: 'function', function: { name: 'emit', arguments: JSON.stringify({ id: 'track-c', reason: 'fits', transition: null }) },
      }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const args = {
      candidates: [{ id: 'track-c', title: 'Track C', artist: 'Artist C' }],
      recentPlays: [], context: { time: { period: 'evening', vibe: 'settled' }, dominantMood: 'calm' },
    };
    await pickNextTrack({ ...args, steer: 'more 2020s pop' });
    await pickNextTrack(args);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(systems[0], /Operator steer — trusted direction[^]*"more 2020s pop"/);
  assert.ok(!systems[1].includes('Operator steer'), 'no steer, no clause');
});

test('the Track Shortlist picker gets the steer on its prompt, never its system prompt', async () => {
  const { djPick } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
  await settings.update({
    llm: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false } },
  });
  const calls: { system: string; user: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = await requestBody(input, init);
    const text = (role: string) => (body.messages || []).filter(m => m.role === role).map(m => m.content || '').join('\n');
    if (body.messages) calls.push({ system: text('system'), user: text('user') });
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: 'fixture-model',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{
        id: 'c', type: 'function', function: { name: 'emit', arguments: JSON.stringify({ id: 'track-c', musicalReason: 'fits', transition: null }) },
      }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const candidates = [{ id: 'track-c', title: 'Track C', artist: 'Artist C' }] as never;
  try {
    await settings.update({ steer: steer({ prompt: 'only instrumental tonight', startedAt: Date.now() - 1000, expiresAt: Date.now() + 3_600_000 }) });
    await djPick({ candidates });
    await settings.update({ steer: null });
    await djPick({ candidates });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(calls[0].user, /Operator steer — trusted direction[^]*"only instrumental tonight"/);
  assert.ok(!calls[0].system.includes('only instrumental tonight'), 'the cached system prompt stays the same');
  assert.ok(!calls[1].user.includes('Operator steer'), 'no steer, no clause');
});
