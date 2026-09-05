// Pins the talk PLACEMENT switch (settings.djTalkOnlyBetweenTracks →
// broadcast/talk-air.ts), #1485 FR 5b.
//
// Two things are worth pinning here, and neither is the planner's (that lives
// in scripts/talk-scheduler.test.ts, which replays whole hours with the switch
// both ways):
//
//  - THE UPGRADE IS BYTE-IDENTICAL. The key defaults false and every way of
//    NOT having it — a settings.json written before it existed, a hand-edited
//    non-boolean — has to read false too. Coercing a stray string to `true`
//    would silently move every segment on an upgraded station.
//  - THE SCOPE IS WHAT EXEMPTS MANUAL TRIGGERS. `currentTalkAir()` reads
//    'immediate' outside any scope, which is where every /dj route calls the
//    same gate-free runners from, and it has to survive an await — the scope
//    wraps a runner whose speech happens several awaits deep, which is the only
//    reason a scope is usable here at all.
//
// STATE_DIR is redirected before the first import, like clock-policy.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-talk-air-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { currentTalkAir, talkAirStatus, talkOnlyBetweenTracks, withTalkAir } =
  await import('../src/broadcast/talk-air.js');
// COLD load, not load(): load() returns the in-process cache untouched, so a
// field missing from its composition passes an in-process assertion and only
// vanishes on the next container start — the failure mode controller/CLAUDE.md
// documents twice (#1317, #918).
const { setCache } = await import('../src/settings/store.js');

test('the switch is off by default and flips both ways', async () => {
  await settings.load();
  assert.equal(talkOnlyBetweenTracks(), false, 'a fresh station talks as it always did');
  assert.deepEqual(talkAirStatus(), { onlyBetweenTracks: false });

  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  assert.equal(talkOnlyBetweenTracks(), true);
  assert.deepEqual(talkAirStatus(), { onlyBetweenTracks: true });

  await settings.update({ djTalkOnlyBetweenTracks: false } as never);
  assert.equal(talkOnlyBetweenTracks(), false, 'the switch is reversible');
});

test('only a boolean is accepted, and a refused write leaves the switch alone', async () => {
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  await assert.rejects(
    () => settings.update({ djTalkOnlyBetweenTracks: 'yes' } as never),
    /djTalkOnlyBetweenTracks must be a boolean/,
  );
  assert.equal(talkOnlyBetweenTracks(), true, 'the rejected write changed nothing');
});

test('a settings.json without the key, or with junk in it, reads as OFF', async () => {
  // The upgrade path, written straight to disk because update() would add the
  // key. Both directions matter: an absent key is every existing station, and a
  // hand-edited non-boolean must not be read as truthy — that would move every
  // scheduled segment on a station whose operator never asked for it.
  const path = join(root, 'settings.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));

  delete stored.djTalkOnlyBetweenTracks;
  writeFileSync(path, JSON.stringify(stored));
  setCache(null);
  await settings.load();
  assert.equal(talkOnlyBetweenTracks(), false, 'a pre-upgrade settings.json keeps the old placement');

  stored.djTalkOnlyBetweenTracks = 'true';
  writeFileSync(path, JSON.stringify(stored));
  setCache(null);
  await settings.load();
  assert.equal(talkOnlyBetweenTracks(), false, 'a non-boolean on disk coerces OFF, never ON');
});

test('the air scope is what a manual trigger is outside of', async () => {
  // Outside any scope — every /dj/segment, /dj/skill and programme runner the
  // operator presses — speech airs immediately, whatever the switch says.
  await settings.update({ djTalkOnlyBetweenTracks: true } as never);
  assert.equal(currentTalkAir(), 'immediate', 'the switch alone defers nothing');

  // Inside one, and still inside it several awaits deep: the scheduled runners
  // generate a script and render a WAV before they ever reach queue.announce().
  const seen = await withTalkAir('next-track', async () => {
    await new Promise(r => setTimeout(r, 1));
    return currentTalkAir();
  });
  assert.equal(seen, 'next-track');
  assert.equal(currentTalkAir(), 'immediate', 'the scope closes with the fire');

  // 'immediate' has to MEAN immediate even inside an enclosing scope, or a
  // nested manual path would inherit a deferral it never asked for.
  const nested = await withTalkAir('next-track', () =>
    withTalkAir('immediate', async () => currentTalkAir()));
  assert.equal(nested, 'immediate');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
