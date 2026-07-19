// Regression tests for the show-handoff boundary logic.
// Run: `tsx scripts/handoff-boundary.test.ts`.
//
// A persona handoff used to fire from the `0 * * * *` cron and duck the middle
// of whatever song was playing. It now rides the TRACK grid: queue.onTrackStarted
// resolves the show for the moment the next pick will air (`showAt = now +
// duration + PICK_SHOW_LOOKAHEAD_SEC`) and drives the roll, the mic-pass AND the
// pick off that one date — so the sign-off/greeting land in front of the
// changeover track, and the pick's brief can't disagree with the on-air persona.
//
// Three pure pieces hold that up, pinned here:
//
//  - contextDate    — reads the `at` stamp getFullContext puts on every context.
//                     This is the load-bearing bit: session.start() resolves the
//                     persona from it, and if it silently fell back to the wall
//                     clock a look-ahead roll would stamp the OUTGOING persona
//                     onto the INCOMING show's session. stampRolledFrom would
//                     then compare that persona against itself, see no change,
//                     and suppress the mic-pass ENTIRELY — worse than the bug
//                     being fixed. The fallback must therefore be exercised.
//  - handoffIsStale — drops a mic-pass that never found a track boundary. The
//                     hourly cron rolls without airing, so with nobody listening
//                     (or across one very long track) a pending handoff can
//                     outlive the moment it describes.
//  - rollIsBackward — refuses to roll the session to an OLDER moment than the
//                     one it was resolved for. Inside the look-ahead window a
//                     live-clock maybeRoll caller (routes/request.ts) still
//                     resolves the outgoing show; unguarded, a listener request
//                     there would archive the just-rolled session, arm a
//                     mirrored reverse mic-pass, and voice the request intro as
//                     the DJ who just signed off.
//
// node:assert-via-tsx style, matching scripts/stale-link.test.ts.

import assert from 'node:assert/strict';
import { contextDate, handoffIsStale, rollIsBackward } from '../src/broadcast/session.js';

const MAX_AGE = 20 * 60_000;   // mirrors HANDOFF_MAX_AGE_MS in dj-agent.ts

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

// A date is "about now" if it's within a couple of seconds of it — the fallback
// paths construct `new Date()` internally, so exact equality isn't available.
function assertAboutNow(d: Date, label: string) {
  const drift = Math.abs(d.getTime() - Date.now());
  assert.ok(drift < 2000, `${label}: expected ~now, got ${d.toISOString()} (${drift}ms off)`);
}

function main() {
  console.log('context date stamp (contextDate):');

  test('reads the `at` stamp getFullContext writes', () => {
    const at = '2026-07-18T09:58:30.000Z';
    assert.equal(contextDate({ at }).toISOString(), at);
  });

  test('a look-ahead stamp is honoured, not collapsed to now', () => {
    // The whole point: 09:58 real time, context describing 10:05. If this
    // returned "now" the roll would resolve the outgoing persona and the
    // mic-pass would never fire.
    const ahead = new Date(Date.now() + 7 * 60_000).toISOString();
    assert.equal(contextDate({ at: ahead }).toISOString(), ahead);
  });

  test('missing `at` (context from another path) → now', () => {
    assertAboutNow(contextDate({}), 'missing at');
  });

  test('null/undefined context → now, never throws', () => {
    assertAboutNow(contextDate(null), 'null ctx');
    assertAboutNow(contextDate(undefined), 'undefined ctx');
  });

  test('unparseable or wrongly-typed `at` → now, never Invalid Date', () => {
    // A session.json persisted before `at` existed, or a hand-edited one.
    for (const bad of ['not-a-date', '', 12345, {}, []] as any[]) {
      const d = contextDate({ at: bad });
      assert.ok(!Number.isNaN(d.getTime()), `at=${JSON.stringify(bad)} produced an Invalid Date`);
      assertAboutNow(d, `at=${JSON.stringify(bad)}`);
    }
  });

  console.log('\npending mic-pass expiry (handoffIsStale):');
  const now = Date.parse('2026-07-18T10:00:00.000Z');

  test('no stamp (session rolled before `at` existed) → fresh, still airs', () => {
    // Deliberate: an in-flight handoff across a deploy should not be swallowed.
    assert.equal(handoffIsStale(undefined, now, MAX_AGE), false);
    assert.equal(handoffIsStale(null, now, MAX_AGE), false);
  });

  test('rolled seconds ago → fresh', () => {
    assert.equal(handoffIsStale(now - 5_000, now, MAX_AGE), false);
  });

  test('rolled just inside the window → fresh', () => {
    assert.equal(handoffIsStale(now - (MAX_AGE - 1), now, MAX_AGE), false);
  });

  test('exactly at the window edge → fresh (strict >)', () => {
    assert.equal(handoffIsStale(now - MAX_AGE, now, MAX_AGE), false);
  });

  test('past the window → stale, drop it', () => {
    assert.equal(handoffIsStale(now - (MAX_AGE + 1), now, MAX_AGE), true);
  });

  test('rolled an hour ago with nobody listening → stale', () => {
    // The real scenario: cron rolls at 10:00 with airHandoff=false, no listener
    // so no track boundary runs the pick block, someone tunes in at 11:00.
    assert.equal(handoffIsStale(now - 60 * 60_000, now, MAX_AGE), true);
  });

  test('a clock skew putting the roll in the future → not stale', () => {
    assert.equal(handoffIsStale(now + 30_000, now, MAX_AGE), false);
  });

  test('non-numeric stamp → treated as unstamped, not stale', () => {
    for (const bad of ['2026-07-18T10:00:00.000Z', NaN, Infinity, {}] as any[]) {
      assert.equal(handoffIsStale(bad, now, MAX_AGE), false, `at=${String(bad)}`);
    }
  });

  console.log('\nbackward-roll guard (rollIsBackward):');
  // The session was look-ahead-rolled for 10:02 at a real time of ~09:58.
  const sessionAt = '2026-07-18T10:02:00.000Z';

  test('live-clock caller inside the look-ahead window → backward, skip', () => {
    // A listener request at 09:58:30 still resolves the outgoing show.
    assert.equal(rollIsBackward(new Date('2026-07-18T09:58:30.000Z'), sessionAt), true);
  });

  test('caller past the described moment → forward, roll allowed', () => {
    assert.equal(rollIsBackward(new Date('2026-07-18T10:02:00.001Z'), sessionAt), false);
  });

  test('exactly the described moment → not backward (strict <)', () => {
    assert.equal(rollIsBackward(new Date(sessionAt), sessionAt), false);
  });

  test('session persisted before ctxAt existed → never blocks a roll', () => {
    assert.equal(rollIsBackward(new Date('2020-01-01T00:00:00.000Z'), undefined), false);
    assert.equal(rollIsBackward(new Date('2020-01-01T00:00:00.000Z'), null), false);
  });

  test('garbage stamp → never blocks a roll', () => {
    for (const bad of ['not-a-date', '', 12345, {}] as any[]) {
      assert.equal(rollIsBackward(new Date(), bad), false, `ctxAt=${JSON.stringify(bad)}`);
    }
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  if (failures) process.exit(1);
}

main();
