// Unit tests for the pure quiet-times gate helper in
// music/analyze-quiet-pure.ts (#1099). Run: `tsx scripts/analyze-quiet.test.ts`
// (auto-discovered by `npm test`).
//
// quietGateDecision decides whether the analysis pass may compute the next
// track: zero listeners for the configured window → proceed; any listener →
// pause immediately. The branching is regression-critical in both directions:
// too eager and a bulk pass churns the CPU while the station is live; too
// strict (e.g. failing closed on an unknown count) and a stats outage stalls
// a library scan forever. node:assert-via-tsx style, matching
// stream-idle.test.ts.

import assert from 'node:assert/strict';
import { quietGateDecision, type QuietState } from '../src/music/analyze-quiet-pure.js';

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
    // The opposite direction from djCallsAllowed(): a stats outage must never
    // stall a library scan forever.
    const r = quietGateDecision(FRESH, { enabled: true, count: null, now: T0, quietAfterMs: WINDOW });
    assert.equal(r.proceed, true);
    assert.equal(r.state.quietSince, T0); // outage accrues quiet time
  });

  await test('outage time counts toward the window on recovery at zero', () => {
    // Icecast down for a full window, then recovers with an empty room: the
    // pass must keep running, not pause in an empty room to re-earn quiet.
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

  process.exit(failures ? 1 : 0);
}

main();
