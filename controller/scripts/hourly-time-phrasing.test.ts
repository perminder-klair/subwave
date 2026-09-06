// The hourly time check's WORDING varies while the reading stays the code's
// (#1602). The clock is rounded into a minute band in time.ts, the band now
// carries several equivalent phrasings of that one rounded time, and this is
// the half that picks one and writes the clause the model is held to. The
// rounding itself is pinned by scripts/clock-phrase.test.ts; what is pinned
// here is that the clause never widens — it still names exactly ONE time, and
// that time is always one the band produced.
//
// Run: npx tsx scripts/hourly-time-phrasing.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-hourly-time-'));

const { spokenTimePhrase, spokenTimePhrases } = await import('../src/time.js');
const { getClockContext } = await import('../src/context.js');
const { hourlyTimeClause } = await import('../src/llm/internal/prompts/scripts.js');

const clockAt = (hour: number, minute: number) => ({
  spokenHour: 'six in the evening',
  spokenTime: spokenTimePhrase(hour, minute),
  spokenTimeOptions: spokenTimePhrases(hour, minute),
});

// The clause quotes the time; this is the only thing the model is told to say.
const quoted = (clause: string) => clause.match(/"([^"]+)"/)?.[1] ?? null;

test('the clause announces one wording from the band, never a list of them', () => {
  const clock = clockAt(18, 2);
  for (let i = 0; i < 50; i++) {
    const clause = hourlyTimeClause(clock);
    const said = quoted(clause);
    assert.ok(said && clock.spokenTimeOptions.includes(said), clause);
    // One quoted string, and the dictate-don't-offer wording of #1282 intact.
    assert.equal(clause.match(/"/g)?.length, 2, clause);
    assert.ok(clause.includes('say exactly that time'), clause);
    assert.ok(clause.includes('never a different time'), clause);
  }
});

test('consecutive checks never open with the same words', () => {
  const clock = clockAt(18, 0);
  let last: string | null = null;
  for (let i = 0; i < 60; i++) {
    const said = quoted(hourlyTimeClause(clock));
    assert.notEqual(said, last, 'the same wording twice running');
    last = said;
  }
});

test('the variation is real — every wording in the band gets used', () => {
  const clock = clockAt(18, 55);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(quoted(hourlyTimeClause(clock))!);
  assert.deepEqual([...seen].sort(), [...clock.spokenTimeOptions].sort());
});

test('a wording is never borrowed from another band', () => {
  // The rotation state is shared across calls; a band change must not leak the
  // previous band's phrasing (or its hour) into the next clause.
  const bands = [0, 8, 17, 31, 45, 55];
  for (let i = 0; i < 200; i++) {
    const m = bands[i % bands.length];
    const clock = clockAt(18, m);
    assert.ok(clock.spokenTimeOptions.includes(quoted(hourlyTimeClause(clock))!), `minute ${m}`);
  }
});

test('a context that predates the options still dictates spokenTime, byte for byte', () => {
  const clause = hourlyTimeClause({ spokenHour: 'six in the evening', spokenTime: 'half past six in the evening' });
  assert.equal(clause,
    'The time to announce is "half past six in the evening" — say exactly that time, in natural spoken words — never digits or 24-hour form, never a different time.');
});

test('the hour-only and bare fallbacks are untouched', () => {
  const hourOnly = hourlyTimeClause({ spokenHour: 'six in the evening' });
  assert.ok(hourOnly.startsWith('The hour to announce is six in the evening'), hourOnly);
  const bare = hourlyTimeClause(null);
  assert.ok(bare.startsWith('Say the time in natural spoken words'), bare);
});

test('the clock context carries the band, canonical wording first', () => {
  const clock: any = getClockContext();
  assert.ok(Array.isArray(clock.spokenTimeOptions));
  assert.equal(clock.spokenTimeOptions[0], clock.spokenTime);
  assert.ok(clock.spokenTimeOptions.length >= 2);
});
