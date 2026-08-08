// Pins the station clock switch (settings.djSpeakClock → broadcast/clock-policy.ts).
//
// The switch keeps the wall clock off air. Five properties are load-bearing and
// each one is a real way this regresses:
//
//  - OFF is opt-in only. A settings.json written before the key existed (and a
//    non-boolean written by hand) must read as ON, or an upgrade silently
//    changes how every existing station talks.
//  - The daypart TAGS survive. "after dark" and friends ride the same context
//    line as the numerals but are atmosphere, not a clock, and isDark is what
//    stops the DJ describing daylight after sunset. Dropping the field wholesale
//    is the obvious implementation and the wrong one.
//  - The heading moves with them. "Local time:" carrying no time reads as a bug.
//  - The switch stands down the hourly time check and NOTHING ELSE in dj-gate.
//    Idents and banter keep their slots; this is not the voice switch.
//  - The agent path is covered. It never calls buildContextLines, so the context
//    line alone leaves the commonest clock mention on air with llm.pickerAgent
//    at its default.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load()/update() touch nothing real — hence the dynamic imports.
// Same shape as scripts/voice-policy.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-clock-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { clockEnabled, speakClockAllowed, autoTimeCheckAllowed, clockStatus } =
  await import('../src/broadcast/clock-policy.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');
const { buildContextLines } = await import('../src/llm/internal/prompts/context.js');
const { pickSchemaBase } = await import('../src/broadcast/dj-agent/schemas.js');

// A moment carrying every tag at once, so one assertion covers all three.
const CTX = {
  clock: { display: '9:14 pm', hhmm: '21:14', isDark: true, isWeekend: true, isLateNight: true },
  time: { period: 'evening', vibe: 'wind down' },
};

function clockLine(): string | undefined {
  return buildContextLines(CTX, { contextFields: ['clock', 'time'] })
    .find((l: string) => l.startsWith('Local time:') || l.startsWith('Vibe:'));
}

function periodLine(): string | undefined {
  return buildContextLines(CTX, { contextFields: ['clock', 'time'] })
    .find((l: string) => l.startsWith('Period:'));
}

// pickSchemaBase() returns a plain ZodObject; keep the lookup tolerant of a
// future wrap, the same way voice-policy.test.ts does for requestSchema().
function sayDescription(): string {
  const schema: any = pickSchemaBase();
  const shape = schema?.def?.out?.shape ?? schema.shape;
  return String(shape.say.description ?? '');
}

const KINDS_UNAFFECTED = ['stationId', 'banter'];
const MINUTES = [0, 7, 15, 20, 30, 45, 50, 59];

function atMinute(m: number): Date {
  // Hour 10 is even, so the hourly gate's 'quiet' rung would fire here if the
  // clock switch allowed it — the OFF assertions can't pass for the wrong reason.
  return new Date(2026, 0, 15, 10, m, 0);
}

try {
  // ── Default: absent key reads as ON ────────────────────────────────────────
  await settings.load();
  assert.equal(clockEnabled(), true, 'fresh install defaults to the clock ON');
  assert.equal(speakClockAllowed(), true, 'fresh install lets a line speak the clock');
  assert.equal(autoTimeCheckAllowed(), true, 'fresh install allows the hourly check');
  assert.deepEqual(clockStatus(), { enabled: true }, 'status snapshot mirrors the switch');

  // A persona loud enough that every slot is live, so the OFF assertions below
  // measure the switch rather than a quiet persona firing nothing anyway.
  await settings.update({
    personas: settings.get().personas.map((p: { id: string }, i: number) =>
      (i === 0 ? { ...p, frequency: 'aggressive', djMode: false } : p)),
  });

  assert.equal(clockLine(), 'Local time: 9:14 pm · after dark · weekend · late night',
    'clock on: the time and the tags share one line');
  const liveUnaffected = MINUTES.flatMap(m => KINDS_UNAFFECTED.map(k => ({ k, m })))
    .filter(({ k, m }) => shouldFire(k, atMinute(m)));
  assert.ok(liveUnaffected.length > 0,
    'baseline: idents/banter fire somewhere, else the "unaffected" check is vacuous');
  assert.ok(shouldFire('hourly', atMinute(0)), 'baseline: the hourly check fires');
  assert.match(sayDescription(), /unless the event message tells you/,
    'clock on: the say schema keeps its conditional clock rule');

  // ── OFF ────────────────────────────────────────────────────────────────────
  await settings.update({ djSpeakClock: false });
  assert.equal(clockEnabled(), false, 'update({djSpeakClock:false}) takes effect');
  assert.equal(speakClockAllowed(), false, 'spoken lines are refused the clock');
  assert.equal(autoTimeCheckAllowed(), false, 'the automatic time check is refused');
  assert.deepEqual(clockStatus(), { enabled: false }, 'status snapshot follows');

  // The tags survive, the numerals do not, and the heading moves with them.
  const off = clockLine();
  assert.equal(off, 'Vibe: after dark · weekend · late night',
    'clock off: tags kept, numerals gone, line relabelled');
  assert.ok(!/9:14|21:14/.test(String(off)), 'clock off: no time leaks in any form');
  assert.equal(periodLine(), 'Period: evening (wind down)',
    'clock off: daypart colour is untouched — it was never a clock reading');

  // The hourly check stands down at every minute.
  for (const m of MINUTES) {
    assert.equal(shouldFire('hourly', atMinute(m)), false,
      `clock off must stand down the hourly check at :${String(m).padStart(2, '0')}`);
  }

  // ...and nothing else does. This is not the voice switch.
  const stillLive = MINUTES.flatMap(m => KINDS_UNAFFECTED.map(k => ({ k, m })))
    .filter(({ k, m }) => shouldFire(k, atMinute(m)));
  assert.deepEqual(stillLive, liveUnaffected,
    'clock off must NOT gag idents or banter — they just stop mentioning the time');

  // The agent path carries its own clock rule and has to follow too.
  const offSay = sayDescription();
  assert.ok(!/unless the event message tells you/.test(offSay),
    'clock off: the say schema drops the escape hatch that can never be met');
  assert.match(offSay, /Never state a clock time/,
    'clock off: the say schema states a flat ban');

  // ── Back ON: everything resumes exactly ────────────────────────────────────
  await settings.update({ djSpeakClock: true });
  assert.equal(clockEnabled(), true, 'the switch is reversible');
  assert.equal(clockLine(), 'Local time: 9:14 pm · after dark · weekend · late night',
    'flipping back restores the original line byte for byte');
  assert.ok(shouldFire('hourly', atMinute(0)), 'flipping back restores the hourly check');

  // ── Validation: only a boolean is accepted ─────────────────────────────────
  await assert.rejects(
    () => settings.update({ djSpeakClock: 'no' } as never),
    /djSpeakClock must be a boolean/,
    'a non-boolean is rejected rather than coerced to falsy (an accidental mute)',
  );
  assert.equal(clockEnabled(), true, 'the rejected write left the switch untouched');

  // ── Migration: a settings.json with no key loads as ON ─────────────────────
  // The upgrade path. Written straight to disk, since update() would add the key.
  const stored = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
  delete stored.djSpeakClock;
  writeFileSync(join(root, 'settings.json'), JSON.stringify(stored));
  await settings.load();
  assert.equal(clockEnabled(), true, 'a pre-upgrade settings.json reads as clock ON');

  // Hand-edited garbage is coerced the same way, not treated as falsy.
  stored.djSpeakClock = 'false';
  writeFileSync(join(root, 'settings.json'), JSON.stringify(stored));
  await settings.load();
  assert.equal(clockEnabled(), true, 'a non-boolean on disk coerces to ON, never OFF');

  console.log('clock-policy.test.ts — all assertions passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
