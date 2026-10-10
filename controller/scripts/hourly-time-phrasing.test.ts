// The hourly time check's WORDING varies while the reading stays the code's
// (#1602): the band carries several phrasings of one rounded time and this
// half picks one. The rounding is pinned by clock-phrase.test.ts; here the
// clause must never widen past exactly one time the band produced.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const originalStateDir = process.env.STATE_DIR;
const stateDir = mkdtempSync(join(tmpdir(), 'subwave-hourly-time-'));
process.env.STATE_DIR = stateDir;

const { spokenTimePhrase, spokenTimePhrases } = await import('../src/time.js');
const { getClockContext } = await import('../src/context.js');
const { nextHourlyTimeClause } = await import('../src/llm/internal/prompts/scripts.js');
const settings = await import('../src/settings.js');
const { generateHourlyTime, buildContextLines } = await import('../src/llm/dj.js');

const clockAt = (hour: number, minute: number) => ({
  spokenHour: 'six in the evening',
  spokenTime: spokenTimePhrase(hour, minute),
  spokenTimeOptions: spokenTimePhrases(hour, minute),
});

// The clause quotes the time; the only thing the model is told to say.
const quoted = (clause: string) => clause.match(/"([^"]+)"/)?.[1] ?? null;

test('the clause announces one wording from the band, never a list of them', () => {
  const clock = clockAt(18, 2);
  for (let i = 0; i < 50; i++) {
    const clause = nextHourlyTimeClause(clock);
    const said = quoted(clause);
    assert.ok(said && clock.spokenTimeOptions.includes(said), clause);
    // One quoted string, and #1282's dictate-don't-offer wording intact.
    assert.equal(clause.match(/"/g)?.length, 2, clause);
    assert.ok(clause.includes('say exactly that time'), clause);
    assert.ok(clause.includes('never a different time'), clause);
  }
});

test('consecutive checks never open with the same words', () => {
  const clock = clockAt(18, 0);
  let last: string | null = null;
  for (let i = 0; i < 60; i++) {
    const said = quoted(nextHourlyTimeClause(clock));
    assert.notEqual(said, last, 'the same wording twice running');
    last = said;
  }
});

test('the variation is real — every wording in the band gets used', () => {
  const clock = clockAt(18, 55);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(quoted(nextHourlyTimeClause(clock))!);
  assert.deepEqual([...seen].sort(), [...clock.spokenTimeOptions].sort());
});

test('a wording is never borrowed from another band', () => {
  // Rotation state is shared across calls, so a band change must not leak the
  // previous band's phrasing or hour.
  const bands = [0, 8, 17, 31, 45, 55];
  for (let i = 0; i < 200; i++) {
    const m = bands[i % bands.length];
    const clock = clockAt(18, m);
    assert.ok(clock.spokenTimeOptions.includes(quoted(nextHourlyTimeClause(clock))!), `minute ${m}`);
  }
});

test('a context that predates the options still dictates spokenTime, byte for byte', () => {
  const clause = nextHourlyTimeClause({ spokenHour: 'six in the evening', spokenTime: 'half past six in the evening' });
  assert.equal(clause,
    'The time to announce is "half past six in the evening" — say exactly that time, in natural spoken words — never digits or 24-hour form, never a different time.');
});

// Byte-for-byte: the tail a prefix check skips is #1282's instruction.
test('the hour-only and bare fallbacks are untouched, byte for byte', () => {
  assert.equal(nextHourlyTimeClause({ spokenHour: 'six in the evening' }),
    'The hour to announce is six in the evening — say exactly that hour, in natural spoken words ("just gone six in the evening", or similar) — never digits or 24-hour form, never a different hour.');
  assert.equal(nextHourlyTimeClause(null),
    'Say the time in natural spoken words ("two in the afternoon", "just gone eight") — never digits or 24-hour form.');
});

test('the clock context carries the band, canonical wording first', () => {
  const clock: any = getClockContext();
  assert.ok(Array.isArray(clock.spokenTimeOptions));
  assert.equal(clock.spokenTimeOptions[0], clock.spokenTime);
  assert.ok(clock.spokenTimeOptions.length >= 3);
});

async function captureHourly(context: unknown, showWelcome = false) {
  const originalLlm = structuredClone(settings.get().llm);
  const realFetch = globalThis.fetch;
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  try {
    await settings.update({ llm: {
      provider: 'openai-compatible', model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:9/v1', fallback: { enabled: false },
    } });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      assert.ok(url.startsWith('http://127.0.0.1:9/'), `unexpected external request: ${url}`);
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        id: 'chatcmpl-hourly', object: 'chat.completion', created: 1, model: 'fixture-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A fixture time check.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await generateHourlyTime({
      context, showWelcome,
      persona: { name: 'Tom', soul: "Reads the weather like he's looked out the window", scriptLength: 'extended' },
      recap: 'Earlier: a sunny spring Saturday.', recentOpeners: ['Just gone noon'],
    });
    assert.equal(requests.length, 1);
    const messages = requests[0].messages;
    return {
      system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
      user: messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
    };
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm });
  }
}

const hourlyContext = {
  clock: { ...clockAt(12, 0), spokenHour: 'noon', display: '12:00 pm', isWeekend: true },
  date: { dayLabel: 'Saturday', dayOfMonth: 3, monthLabel: 'October', season: 'spring' },
  activeShow: { name: 'Equinox Top 100 UK & Australia Tunes' },
};

test('production hourly checks override weather-inviting persona instructions', async () => {
  const { system } = await captureHourly({ ...hourlyContext,
    weather: { condition: 'stormy', temp: 13, location: 'Melbourne' },
  });
  assert.match(system, /For this hourly time check, do not mention weather or outdoor conditions/);
  assert.ok(system.includes("Reads the weather like he's looked out the window"));
  assert.ok(system.indexOf('For this hourly time check') > system.indexOf("Reads the weather like he's looked out the window"));
});

// The same ban applies whether weather is known, unavailable, or missing entirely.
for (const condition of ['stormy', 'rainy', 'clear', 'unknown', 'absent', 'null']) {
  test(`hourly ${condition} context keeps weather off the prompt and preserves continuity`, async () => {
    const context = condition === 'null' ? null : {
      ...hourlyContext,
      ...(condition === 'absent' ? {} : { weather: { condition, temp: 13, location: 'Melbourne' } }),
    };
    const { system, user } = await captureHourly(context, true);
    assert.match(system, /For this hourly time check, do not mention weather or outdoor conditions/);
    assert.match(system, /Do not infer them from persona instructions, the day, season, daypart, daylight or darkness, or recent speech\/recap/);
    assert.match(system, /overrides persona and tone instructions/);
    assert.match(system, /dedicated weather segment/);
    assert.doesNotMatch(user, /Weather in |stormy|rainy|clear|unknown|13 degrees|Melbourne/);
    assert.match(user, /2-3 sentences/);
    assert.match(user, /do not repeat phrasing or topics/);
    assert.match(user, /Earlier: a sunny spring Saturday/);
    assert.match(user, /Do not start your line with any of these openers/);
    assert.match(user, /"Just gone noon…"/);
    if (context) {
      const said = user.match(/The time to announce is "([^"]+)"/)?.[1];
      assert.ok(said && hourlyContext.clock.spokenTimeOptions.includes(said));
      assert.match(user, /say exactly that time/);
      assert.match(user, /never a different time/);
      assert.match(user, /The schedule is now in "Equinox Top 100 UK & Australia Tunes"/);
      assert.match(user, /you may add one short, natural welcome/);
      assert.match(user, /Do not .*claim the show began at a particular time/);
      assert.doesNotMatch(user, /first spoken segment|newly started show/);
    } else {
      assert.match(user, /Say the time in natural spoken words/);
      assert.doesNotMatch(user, /first spoken segment/);
    }
  });
}

test('hourly show welcome requires both the flag and a named active show', async () => {
  const ordinary = await captureHourly(hourlyContext);
  assert.doesNotMatch(ordinary.user, /The schedule is now in|natural welcome/);
  const unnamed = await captureHourly({ ...hourlyContext, activeShow: {} }, true);
  assert.doesNotMatch(unnamed.user, /The schedule is now in|natural welcome/);
});

test('dedicated weather context still includes known conditions and excludes unknown', () => {
  assert.deepEqual(buildContextLines({ weather: { condition: 'stormy', temp: 13, location: 'Melbourne' } },
    { contextFields: ['weather'] }), ['Weather in Melbourne: stormy, 13 degrees Celsius']);
  assert.deepEqual(buildContextLines({ weather: { condition: 'unknown', temp: 13, location: 'Melbourne' } },
    { contextFields: ['weather'] }), []);
});

after(() => {
  rmSync(stateDir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = originalStateDir;
});
