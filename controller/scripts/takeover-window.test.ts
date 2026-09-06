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
//  - Both clamps fire, in opposite directions: an empty grid must not pin
//    forever, and a boundary two minutes out must not store a window that
//    expires before the switch can reach a track boundary.
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

test('a change nearer than the floor is held to the floor', () => {
  // A pin that expires before the switch reaches a track boundary airs nothing
  // and costs two session rolls — the station's own "shorter than this is not a
  // takeover" number is the floor.
  const w = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: T0 + 2 * MIN });
  assert.equal(w.source, 'minimum');
  assert.equal(w.minutes, OVERRIDE_MIN_MINUTES);
  assert.equal(w.nextChangeAt, T0 + 2 * MIN, 'the boundary is still reported, so the dialog can say why');
  // Exactly at the floor is not a clamp.
  const exact = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: T0 + OVERRIDE_MIN_MINUTES * MIN });
  assert.equal(exact.source, 'schedule');
});

test('a change past the ceiling is held to the ceiling', () => {
  const w = resolveTakeoverWindow({ startedAt: T0, nextChangeAt: T0 + (OVERRIDE_MAX_MINUTES + 60) * MIN });
  assert.equal(w.source, 'maximum');
  assert.equal(w.minutes, OVERRIDE_MAX_MINUTES);
});

test('every resolved window is one the stored-override schema accepts', () => {
  const schema = scheduleOverrideSchema({ showIds: ['early'], now: null });
  for (const nextChangeAt of [null, T0 + 1 * MIN, T0 + 47 * MIN, T0 + 999 * MIN]) {
    const { expiresAt } = resolveTakeoverWindow({ startedAt: T0, nextChangeAt });
    const r = schema.safeParse({ showId: 'early', startedAt: T0, expiresAt });
    assert.equal(r.success, true, `nextChangeAt=${String(nextChangeAt)} produced an unstorable window`);
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
