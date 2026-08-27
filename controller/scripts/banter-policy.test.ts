// Pins the banter WINDOW's NUMBERS (broadcast/banter-policy.ts) and the rung
// that reads them (dj-gate's 'banter' branch).
//
// The bug behind them (#1419): the gap was evaluated at exactly two instants an
// hour, so a station ident scheduled at :15 but boundary-deferred to :19:35
// left 25s of quiet at the :20 tick, the tick stood down, and the next chance
// was 30 minutes away — on `moderate`, which owns only the :20 slot, the whole
// hour was gone. Hours of eligible guest shows aired no banter at all, silently.
//
// The machinery those numbers feed — the window arithmetic, the slot claim, the
// gap check, the logged-once stand-down — was generalised to every talk kind in
// #1500 and lives in broadcast/talk-scheduler.ts, pinned by
// scripts/talk-scheduler.test.ts. What stays here is what stayed in the module:
//
//  - The GAP is 5 minutes and the WINDOW is twice it. That relationship is why
//    a talk break landing anywhere in the 5 minutes before the slot opens
//    clears by the halfway point, leaving room to render a multi-voice exchange
//    and still finish clear of the next slot. Changing one without the other is
//    the silent way to break it.
//  - The gap COUNTS IDENTS. "Classify short idents as not-real-talk" is the
//    tempting fix and the wrong one: it lets banter stack right behind one,
//    which is what the gap is for.
//  - The RUNG asks which slot a minute belongs to, never which minute it is, so
//    a retry at :24 is still `moderate`'s one exchange rather than a second one
//    — and never no chance at all.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// settings.load()/update() touch nothing real — hence the dynamic imports. Same
// shape as scripts/clock-policy.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-banter-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS,
} = await import('../src/broadcast/banter-policy.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');

// The default roster's first persona, re-fadered to the frequency under test —
// the only settings the 'banter' rung reads. Patching the seeded persona (rather
// than writing one from scratch) keeps the strict TTS/soul validators happy;
// same trick as scripts/clock-policy.test.ts.
async function station(frequency: string) {
  await settings.update({
    tts: { enabled: true },
    personas: settings.get().personas.map((p: any, i: number) =>
      (i === 0 ? { ...p, frequency, djMode: false } : p)),
  } as any);
}

const at = (minute: number) => new Date(2026, 7, 19, 9, minute, 0);

test('the quiet gap is 5 minutes, and the window is deliberately twice it', () => {
  assert.equal(BANTER_MIN_GAP_MS, 5 * 60_000);
  // A talk break landing anywhere in the 5 minutes before the slot opens clears
  // by the halfway point, leaving the rest of the window to render a
  // multi-voice exchange and still finish clear of the next slot.
  assert.equal(BANTER_WINDOW_MINUTES, 2 * (BANTER_MIN_GAP_MS / 60_000));
  // Both windows close before the hour does, which is what lets a slot be keyed
  // by wall-clock hour rather than by a rolling timer.
  for (const slot of BANTER_SLOTS) assert.ok(slot + BANTER_WINDOW_MINUTES <= 60);
});

test('the frequency ladder is unchanged, and reads the slot rather than the minute', async () => {
  await station('quiet');
  // Quiet never auto-banters — anywhere in either window.
  for (const m of [20, 24, 29, 50, 59]) assert.equal(shouldFire('banter', at(m)), false);

  await station('moderate');
  // One an hour: the :20 slot only — but now with its full retry tail.
  for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
    assert.equal(shouldFire('banter', at(20 + i)), true, `moderate should retry at :${20 + i}`);
  }
  for (const m of [50, 55, 59]) assert.equal(shouldFire('banter', at(m)), false);

  for (const f of ['chatty', 'aggressive']) {
    await station(f);
    for (const m of [20, 25, 29, 50, 55, 59]) {
      assert.equal(shouldFire('banter', at(m)), true, `${f} should fire at :${m}`);
    }
    // Outside the windows nothing fires, whatever the rung — :00 stays the
    // hourly check's and :15/:30/:45 stay the idents' opening minutes (#310).
    for (const m of [0, 15, 19, 30, 45, 49]) {
      assert.equal(shouldFire('banter', at(m)), false, `${f} must not fire at :${m}`);
    }
  }
});

test('the station voice switch still sits above the whole window', async () => {
  await station('aggressive');
  await settings.update({ tts: { enabled: false } } as any);
  for (const m of [20, 25, 50, 59]) assert.equal(shouldFire('banter', at(m)), false);
  await settings.update({ tts: { enabled: true } } as any);
  assert.equal(shouldFire('banter', at(25)), true);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
