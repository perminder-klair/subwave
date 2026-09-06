// Pins "until the schedule changes" (#1601) — the takeover window resolved from
// the weekly grid instead of `now + N`.
//
// Four properties, each a real way this regresses:
//
//  - Nothing new is STORED. The resolved window is an ordinary
//    ScheduleOverride, so scheduleOverrideSchema accepts every answer this
//    resolver can produce and the janitor/resolver/programme span keep judging
//    expiry the one way they always have.
//  - The boundary is the GRID's. resolveActiveShow honours a live takeover, so
//    a resolver that scanned through it would answer "when does the pin I am
//    replacing run out" — which is why re-pinning during a takeover has its own
//    assertion below.
//  - There is a CEILING and NO FLOOR, and the asymmetry is the point: an empty
//    grid must not pin forever, but a boundary two minutes out must resolve to
//    that boundary and no later. `OVERRIDE_MIN_MINUTES` used to be applied here
//    as the ceiling's mirror image, which made "end at the change" end AFTER
//    the change — so the floor case below asserts the boundary is stored
//    verbatim, and that the floor still governs `until: 'fixed'`, where it is a
//    bound on typed input rather than on a resolved instant.
//  - The scan is on the STATION clock, so a zone at a :30 offset moves the
//    answer by half an hour rather than rounding to the process hour.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// settings.load()/update() touch nothing real — same shape as
// scripts/show-boundary.test.ts.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-takeover-window-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  resolveTakeoverWindow,
  nextGridChangeAt,
  resolveTakeoverWindowNow,
} = await import('../src/broadcast/takeover-window.js');
const {
  OVERRIDE_MAX_MINUTES,
  OVERRIDE_MIN_MINUTES,
  scheduleOverrideRequestSchema,
  scheduleOverrideSchema,
} = await import('../src/schemas/schedule.js');

const MIN = 60_000;
const HOUR = 3_600_000;
// 2026-01-15 09:40 UTC, a Thursday — clear of any DST step in the zones below.
const T0 = Date.UTC(2026, 0, 15, 9, 40);

// ── the pure clamps ──────────────────────────────────────────────────────────

test('the grid change IS the end instant when it is in range', () => {
  const at = T0 + 20 * MIN;
  const w = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: at });
  assert.equal(w.expiresAt, at, 'the boundary is stored verbatim, not rounded to an hour');
  assert.equal(w.minutes, 20);
  assert.equal(w.source, 'schedule');
  assert.equal(w.nextChangeAt, at);
});

test('no change in reach is a bounded pin, never an open one', () => {
  for (const none of [null, undefined, NaN]) {
    const w = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: none as number | null });
    assert.equal(w.source, 'maximum', `${String(none)} must not read as a boundary`);
    assert.equal(w.minutes, OVERRIDE_MAX_MINUTES);
    assert.equal(w.nextChangeAt, null, 'an unusable input is reported as no change, not echoed back');
  }
});

test('a change nearer than the request floor is still the change itself', () => {
  // The regression this exists for: OVERRIDE_MIN_MINUTES used to be applied
  // here, so a boundary five minutes out stored a fifteen-minute pin that ran
  // TEN MINUTES PAST the change it was asked to end at — shadowing the incoming
  // show, which is the one harm the option exists to remove. A ceiling trims a
  // window that is otherwise valid; a floor cannot lengthen one that is
  // genuinely short, it can only replace the request with a different one.
  for (const away of [1, 2, 5, OVERRIDE_MIN_MINUTES - 1]) {
    const at = T0 + away * MIN;
    const w = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: at });
    assert.equal(w.expiresAt, at, `a boundary ${away} min out is stored verbatim`);
    assert.equal(w.source, 'schedule', 'a near boundary is still the schedule\'s own answer');
    assert.equal(w.minutes, away);
    assert.ok(w.expiresAt <= at, 'a resolved window may never outlive the change it ends at');
  }
  // And it is storable: the stored shape has no minimum, only
  // `expiresAt > startedAt` and the cap.
  const schema = scheduleOverrideSchema({ showIds: ['early'], now: null });
  const short = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: T0 + 1 * MIN });
  assert.equal(schema.safeParse({ showId: 'early', startedAt: T0, expiresAt: short.expiresAt }).success, true);
});

test('the floor still governs the FIXED window, where it bounds typed input', () => {
  // The floor did not move, it stopped being applied to a resolved instant. A
  // duration an operator types is exactly where it belongs.
  assert.equal(
    scheduleOverrideRequestSchema.safeParse({ showId: 'x', minutes: OVERRIDE_MIN_MINUTES - 1 }).success,
    false,
  );
  assert.equal(
    scheduleOverrideRequestSchema.safeParse({ showId: 'x', minutes: OVERRIDE_MIN_MINUTES }).success,
    true,
  );
});

test('a change past the ceiling is trimmed to the ceiling, under its own source', () => {
  // Unreachable from resolveTakeoverWindowNow (the scan's horizon IS the
  // ceiling) — a guard on a caller passing its own instant. It must not report
  // 'maximum': that one means the grid never moves on, which is the opposite of
  // what happened here.
  const w = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: T0 + (OVERRIDE_MAX_MINUTES + 60) * MIN });
  assert.equal(w.source, 'ceiling');
  assert.equal(w.minutes, OVERRIDE_MAX_MINUTES);
  // Exactly at the ceiling is not a trim.
  const exact = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: T0 + OVERRIDE_MAX_MINUTES * MIN });
  assert.equal(exact.source, 'schedule');
});

test('every resolved window is storable, and none outlives its own boundary', () => {
  // The storability half alone would have passed with the floor still applied —
  // it is the second assertion that pins the rule, so keep them together.
  const schema = scheduleOverrideSchema({ showIds: ['early'], now: null });
  for (const nextChangeAt of [null, T0 + 1 * MIN, T0 + 47 * MIN, T0 + 999 * MIN]) {
    const { expiresAt } = resolveTakeoverWindow({ startedAt: T0, nextChangeAt });
    const r = schema.safeParse({ showId: 'early', startedAt: T0, expiresAt });
    assert.equal(r.success, true, `nextChangeAt=${String(nextChangeAt)} produced an unstorable window`);
    if (nextChangeAt != null) {
      assert.ok(expiresAt <= nextChangeAt, `nextChangeAt=${nextChangeAt} resolved PAST its own change`);
    }
  }
});

// ── the live scan, against a real settings store ─────────────────────────────

// Hours 9 and 10 (station clock) are "early", 11 is "late", the rest default.
async function seed(timezone: string) {
  await settings.load();
  await settings.update({ timezone });
  const personaId = settings.get().personas[0].id;
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) {
    const day: (string | null)[] = Array(24).fill(null);
    day[9] = 'early';
    day[10] = 'early';
    day[11] = 'late';
    week[d] = day;
  }
  await settings.update({
    shows: [
      { id: 'early', name: 'Early', topic: 'ambient', personaId },
      { id: 'late', name: 'Late', topic: 'noise', personaId },
    ],
    schedule: week,
  });
}

async function clearGrid() {
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) week[d] = Array(24).fill(null);
  await settings.update({ schedule: week, scheduleOverride: null });
}

test('the scan finds the hour the grid stops naming the current show', async () => {
  await seed('UTC');
  // 09:40, inside Early's first hour: the 10:00 mark is the same show, so the
  // boundary is 11:00 — an hour mark is not automatically a change.
  assert.equal(nextGridChangeAt(T0), Date.UTC(2026, 0, 15, 11, 0));
  // Coming OFF a show onto default programming is a change like any other:
  // inside Late's only hour the boundary is the drop back to default at 12:00.
  assert.equal(nextGridChangeAt(Date.UTC(2026, 0, 15, 11, 20)), Date.UTC(2026, 0, 15, 12, 0));
});

test('the scan walks the STATION clock, not the process clock', async () => {
  await seed('Asia/Kolkata');
  // +05:30, so station 09:00-11:00 is 03:30-05:30 UTC. Started at station 09:40
  // (04:10 UTC), Early ends at station 11:00 = 05:30 UTC — a :30 offset the
  // process clock would round to 05:00 or 06:00.
  assert.equal(
    nextGridChangeAt(Date.UTC(2026, 0, 15, 4, 10)),
    Date.UTC(2026, 0, 15, 5, 30),
  );
});

test('a live takeover is not the boundary being measured', async () => {
  await seed('UTC');
  const startedAt = T0;
  // A pin already in force, expiring long before the grid's own change.
  await settings.update({
    scheduleOverride: { showId: 'late', startedAt: startedAt - 5 * MIN, expiresAt: startedAt + 10 * MIN },
  });
  assert.equal(
    nextGridChangeAt(startedAt),
    Date.UTC(2026, 0, 15, 11, 0),
    're-pinning during a takeover must measure the grid, not the pin it replaces',
  );
  await settings.update({ scheduleOverride: null });
});

test('an empty grid resolves to a bounded pin rather than a forever one', async () => {
  await seed('UTC');
  await clearGrid();
  assert.equal(nextGridChangeAt(T0), null, 'a grid that never changes has no boundary');
  const w = resolveTakeoverWindowNow(T0);
  assert.equal(w.source, 'maximum');
  assert.equal(w.expiresAt, T0 + OVERRIDE_MAX_MINUTES * MIN);
});

test('the horizon is the longest pin the station allows', async () => {
  await seed('UTC');
  // Started just after Early ends: the next change is Early tomorrow, 21h out —
  // past the 12h ceiling, so the scan reports nothing and the pin is capped.
  const at = Date.UTC(2026, 0, 15, 12, 0);
  assert.equal(nextGridChangeAt(at), null);
  assert.equal(resolveTakeoverWindowNow(at).source, 'maximum');
  // A wider horizon does see it — the ceiling is the reason, not the scan.
  assert.equal(nextGridChangeAt(at, 24 * 60), Date.UTC(2026, 0, 16, 9, 0));
});

test('a boundary minutes away resolves live to that boundary, not past it', async () => {
  await seed('UTC');
  // The end-to-end shape of the regression: station 10:55, Early ends at 11:00.
  // The pin must end at 11:00. Applying OVERRIDE_MIN_MINUTES here ended it at
  // 11:10, ten minutes deep into Late's slot.
  const at = Date.UTC(2026, 0, 15, 10, 55);
  const w = resolveTakeoverWindowNow(at);
  assert.equal(w.expiresAt, Date.UTC(2026, 0, 15, 11, 0));
  assert.equal(w.source, 'schedule');
  assert.equal(w.minutes, 5);
});

test('a Default programming takeover resolves the same boundary', async () => {
  await seed('UTC');
  // The boundary is a property of the grid, not of what is pinned over it, so
  // the null target gets the same answer a show pin does — the explicit call
  // the issue asked for.
  const w = resolveTakeoverWindowNow(T0);
  assert.equal(w.expiresAt, Date.UTC(2026, 0, 15, 11, 0));
  const schema = scheduleOverrideSchema({ showIds: ['early'], now: null });
  assert.equal(
    schema.safeParse({ showId: null, startedAt: T0, expiresAt: w.expiresAt }).success,
    true,
  );
});

test.after(() => rmSync(root, { recursive: true, force: true }));
