// The pure quiet-times gate (music/analyze-quiet-pure.ts, #1099): zero
// listeners for the configured window proceeds, any listener pauses at once.
// Wrong in either direction is bad — too eager churns CPU on a live station,
// too strict stalls a library scan through a stats outage.

import assert from 'node:assert/strict';
import { quietGateDecision, type QuietState } from '../src/music/analyze-quiet-pure.js';
import { gatedCount } from '../src/broadcast/listeners.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const FRESH: QuietState = { quietSince: null };
const WINDOW = 10 * 60_000; // 10 min
const T0 = 1_000_000;

async function main() {
  console.log('quietGateDecision (analysis quiet-times gate):');

  await test('disabled gate always proceeds', () => {
    const r = quietGateDecision(FRESH, { enabled: false, count: 5, now: T0, quietAfterMs: WINDOW });
    assert.equal(r.proceed, true);
    assert.equal(r.state.quietSince, null);
  });

  await test('a listener pauses immediately and resets the quiet clock', () => {
    const r = quietGateDecision({ quietSince: T0 }, { enabled: true, count: 1, now: T0 + WINDOW, quietAfterMs: WINDOW });
    assert.equal(r.proceed, false);
    assert.equal(r.state.quietSince, null);
  });

  await test('zero listeners starts the quiet clock but does not proceed yet', () => {
    const r = quietGateDecision(FRESH, { enabled: true, count: 0, now: T0, quietAfterMs: WINDOW });
    assert.equal(r.proceed, false);
    assert.equal(r.state.quietSince, T0);
  });

  await test('the clock holds across polls while the room stays empty', () => {
    const r = quietGateDecision({ quietSince: T0 }, { enabled: true, count: 0, now: T0 + WINDOW / 2, quietAfterMs: WINDOW });
    assert.equal(r.proceed, false);
    assert.equal(r.state.quietSince, T0); // NOT restarted per poll
  });

  await test('proceeds once the full window has elapsed at zero', () => {
    const r = quietGateDecision({ quietSince: T0 }, { enabled: true, count: 0, now: T0 + WINDOW, quietAfterMs: WINDOW });
    assert.equal(r.proceed, true);
    assert.equal(r.state.quietSince, T0);
  });

  await test('keeps proceeding on later polls in an empty room', () => {
    const r = quietGateDecision({ quietSince: T0 }, { enabled: true, count: 0, now: T0 + WINDOW * 3, quietAfterMs: WINDOW });
    assert.equal(r.proceed, true);
  });

  await test('a listener blip mid-window restarts the wait from scratch', () => {
    const blip = quietGateDecision(
      { quietSince: T0 },
      { enabled: true, count: 2, now: T0 + WINDOW - 1_000, quietAfterMs: WINDOW },
    );
    assert.equal(blip.proceed, false);
    assert.equal(blip.state.quietSince, null);
    const again = quietGateDecision(blip.state, { enabled: true, count: 0, now: T0 + WINDOW, quietAfterMs: WINDOW });
    assert.equal(again.proceed, false);
    assert.equal(again.state.quietSince, T0 + WINDOW); // fresh clock
  });

  await test('unknown count fails OPEN — proceeds despite no quiet history', () => {
    // The opposite direction from djCallsAllowed().
    const r = quietGateDecision(FRESH, { enabled: true, count: null, now: T0, quietAfterMs: WINDOW });
    assert.equal(r.proceed, true);
    assert.equal(r.state.quietSince, T0); // outage accrues quiet time
  });

  await test('outage time counts toward the window on recovery at zero', () => {
    // Icecast down for a full window, then an empty room: the pass keeps
    // running rather than re-earning quiet.
    const during = quietGateDecision(FRESH, { enabled: true, count: null, now: T0, quietAfterMs: WINDOW });
    const after = quietGateDecision(during.state, { enabled: true, count: 0, now: T0 + WINDOW, quietAfterMs: WINDOW });
    assert.equal(after.proceed, true);
  });

  await test('recovery revealing listeners pauses again and resets the clock', () => {
    const during = quietGateDecision(FRESH, { enabled: true, count: null, now: T0, quietAfterMs: WINDOW });
    const after = quietGateDecision(during.state, { enabled: true, count: 3, now: T0 + WINDOW, quietAfterMs: WINDOW });
    assert.equal(after.proceed, false);
    assert.equal(after.state.quietSince, null);
  });

  // #1256: the INPUT is gated, not raw. Here unknown means PROCEED — the
  // opposite fail-open direction from the other readers — so a single timed-out
  // poll would start a heavy DSP pass over a listener's head.
  console.log('\nquietGateDecision fed through listeners.gatedCount (#1256):');

  const LIMIT = 4;   // STALE_STATUS_LIMIT

  await test('a blip while someone is listening no longer starts the pass', () => {
    // Three listeners, then one poll times out: on the raw count that is
    // null, proceed:true, Demucs on a live station.
    const count = gatedCount(null, 3, 1, LIMIT);
    const r = quietGateDecision(FRESH, { enabled: true, count, now: T0, quietAfterMs: WINDOW });
    assert.equal(r.proceed, false);
    assert.equal(r.state.quietSince, null);
  });

  await test('a blip in an empty room does not restart the quiet window', () => {
    const start = quietGateDecision(FRESH, { enabled: true, count: 0, now: T0, quietAfterMs: WINDOW });
    const blip = quietGateDecision(start.state, {
      enabled: true, count: gatedCount(null, 0, 1, LIMIT), now: T0 + 30_000, quietAfterMs: WINDOW,
    });
    assert.equal(blip.state.quietSince, T0);   // clock held, not reset to the blip
    assert.equal(blip.proceed, false);         // window still draining
  });

  await test('a sustained outage still fails open, exactly as before', () => {
    const count = gatedCount(null, 3, LIMIT, LIMIT);
    assert.equal(count, null);
    const r = quietGateDecision(FRESH, { enabled: true, count, now: T0, quietAfterMs: WINDOW });
    assert.equal(r.proceed, true);
  });

  await test('the child\'s very first probe still reads unknown', () => {
    // lastGoodCount is null until the child's first successful poll.
    assert.equal(gatedCount(null, null, 1, LIMIT), null);
  });

  process.exit(failures ? 1 : 0);
}

main();
