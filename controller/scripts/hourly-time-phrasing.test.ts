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
const { nextHourlyTimeClause } = await import('../src/llm/internal/prompts/scripts.js');

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
    const clause = nextHourlyTimeClause(clock);
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
  // The rotation state is shared across calls; a band change must not leak the
  // previous band's phrasing (or its hour) into the next clause.
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

// Byte-for-byte, like the case above and for the same reason: the tail a
// prefix check skips is the #1282 instruction ("never digits or 24-hour form,
// never a different hour") that this whole feature exists to leave intact.
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
