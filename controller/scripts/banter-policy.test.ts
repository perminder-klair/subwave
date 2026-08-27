// Pins the banter WINDOW's NUMBERS (broadcast/banter-policy.ts) and the rung
// that reads them (dj-gate's 'banter' branch).
//
// The bug behind them (#1419): the gap was evaluated at exactly two instants an
// hour, so a station ident scheduled at :15 but boundary-deferred to :19:35
// left 25s of quiet at the :20 tick, the tick stood down, and the next chance
// was 30 minutes away — on `moderate`, which owns only the :20 slot, the whole
// hour was gone. Hours of eligible guest shows aired no banter at all, silently.
//
// The state machine those numbers feed was generalised to every talk kind in
// #1500 and now lives in broadcast/talk-scheduler.ts — the slot claim, the
// logged-once stand-down and the reporter's own hour are pinned in
// scripts/talk-scheduler.test.ts. What stays here is the policy this file kept:
//
//  - The window has a TAIL. If a minute inside :20–:29 stops reading as the :20
//    slot, the retry is gone and we are back to a single instant.
//  - The retry minute keeps its slot's IDENTITY. dj-gate's rungs are keyed on
//    the slot, so if :24 resolved to anything but 20 a `moderate` station would
//    either lose its retry or gain a second exchange it never had.
//  - The gap itself is UNCHANGED at 5 minutes, and idents still count toward it.
//    "Classify short idents as not-real-talk" is the tempting fix and the wrong
//    one: it lets banter stack right behind an ident, which is what the gap is for.
//  - The windows never REACH an ident slot (:30/:45) or the hourly check (:00),
//    so an exchange is never SCHEDULED against another talker (issue #310).
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
  BANTER_SLOTS, BANTER_WINDOW_MINUTES, BANTER_MIN_GAP_MS, banterSlot,
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

test('every minute of a window resolves to the slot that opened it', () => {
  for (const slot of BANTER_SLOTS) {
    for (let i = 0; i < BANTER_WINDOW_MINUTES; i++) {
      assert.equal(banterSlot(slot + i), slot, `:${slot + i} should belong to slot :${slot}`);
    }
    assert.equal(banterSlot(slot + BANTER_WINDOW_MINUTES), null, 'the window ends where it says it does');
  }
  // The reporter's own case: an ident deferred to :19:35 pushes the exchange to
  // :24:35, which has to still be the :20 slot or there is no retry at all.
  assert.equal(banterSlot(24), 20);
});

test('minutes outside both windows are not a slot', () => {
  for (const m of [0, 15, 19, 30, 45, 49]) {
    assert.equal(banterSlot(m), null, `:${m} must not open a banter window`);
  }
  // The ident slots specifically — a window must never REACH one, or the
  // exchange and the ident are scheduled against each other (issue #310).
  assert.ok(banterSlot(30) === null && banterSlot(45) === null);
  assert.ok(banterSlot(0) === null, 'nor the hourly check at :00');
});

test('the quiet gap is 5 minutes — twice over, since the window is built on it', () => {
  assert.equal(BANTER_MIN_GAP_MS, 5 * 60_000);
  // The window is deliberately TWICE the gap: a talk break landing anywhere in
  // the 5 minutes before the slot opens clears by the halfway point.
  assert.equal(BANTER_WINDOW_MINUTES, 2 * (BANTER_MIN_GAP_MS / 60_000));
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
    // Outside the windows nothing fires, whatever the rung — the ident and
    // hourly minutes stay theirs.
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
