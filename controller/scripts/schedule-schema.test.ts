// The weekly grid + timed takeover moved onto a shared zod schema
// (controller/src/schemas/schedule.ts), mirrored into
// web/lib/schemas.generated.ts. These tests pin the surfaces that must agree:
// the schema itself, the strict update() validators, the lenient load path, and
// the route-boundary middleware's payload.
//
// The point of the conversion is that three postures share ONE rule set, so
// most of what is asserted below is that strict / lenient / route disagree only
// where they are meant to: strict throws, load repairs, and PUT /schedule drops
// unknown shows with a count.
//
// Run: npx tsx scripts/schedule-schema.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-schedule-schema-'));

const {
  OVERRIDE_MAX_MINUTES,
  OVERRIDE_MIN_MINUTES,
  SCHEDULE_DAYS,
  SCHEDULE_HOURS,
  emptyWeek,
  isDefaultTakeover,
  repairScheduleForLoad,
  resolveScheduleSlots,
  scheduleOverrideRequestSchema,
  scheduleOverrideSchema,
  scheduleSaveSchema,
  scheduleSchema,
  takeoverShowId,
} = await import('../src/schemas/schedule.js');
const { validateScheduleStrict, validateScheduleOverrideStrict } = await import(
  '../src/settings/validate.js'
);
const { normalizeSchedule, normalizeScheduleOverride } = await import(
  '../src/settings/normalize.js'
);
const vocab = await import('../src/settings/vocab.js');
const { validateBody } = await import('../src/middleware/validate.js');

const SHOWS = [{ id: 'night_loop' }, { id: 'dawn_patrol' }];
const IDS = SHOWS.map(s => s.id);

/** A full grid with `id` booked on day `d`, hour `h`. */
function weekWith(d: number, h: number, id: string) {
  const week = emptyWeek();
  week[d]![h] = id;
  return week;
}

// --- constants + the vocab aliases ------------------------------------------

test('grid dimensions are the real ones', () => {
  assert.equal(SCHEDULE_DAYS, 7);
  assert.equal(SCHEDULE_HOURS, 24);
});

test('settings/vocab re-exports the schema constants rather than redeclaring them', () => {
  // A hand-copied constant is exactly the SKILL_SLUG_RE drift; these must be
  // the same binding, not the same value typed twice.
  assert.equal(vocab.OVERRIDE_MIN_MINUTES, OVERRIDE_MIN_MINUTES);
  assert.equal(vocab.OVERRIDE_MAX_MINUTES, OVERRIDE_MAX_MINUTES);
  assert.equal(vocab.SCHEDULE_DAYS, SCHEDULE_DAYS);
  assert.equal(vocab.SCHEDULE_HOURS, SCHEDULE_HOURS);
  assert.equal(vocab.emptyWeek, emptyWeek);
});

test('emptyWeek is a full blank grid', () => {
  const week = emptyWeek();
  assert.equal(Object.keys(week).length, SCHEDULE_DAYS);
  for (let d = 0; d < SCHEDULE_DAYS; d++) {
    assert.equal(week[d]!.length, SCHEDULE_HOURS);
    assert.ok(week[d]!.every(v => v === null));
  }
});

// --- the grid schema --------------------------------------------------------

test('accepts a full grid and returns every day filled out', () => {
  const r = scheduleSchema({ showIds: IDS }).parse(weekWith(3, 14, 'night_loop'));
  assert.equal(r[3]![14], 'night_loop');
  assert.equal(r[3]![13], null);
  assert.equal(r[0]!.length, SCHEDULE_HOURS);
});

test('an absent or null day is a blank day, not an error', () => {
  const r = scheduleSchema({ showIds: IDS }).parse({ 0: null, 2: undefined });
  assert.ok(r[0]!.every(v => v === null));
  assert.equal(r[6]!.length, SCHEDULE_HOURS);
});

test("empty string is a slot's third spelling of nothing", () => {
  const week = weekWith(1, 5, 'night_loop');
  week[1]![6] = '' as unknown as string;
  const r = scheduleSchema({ showIds: IDS }).parse(week);
  assert.equal(r[1]![6], null);
});

test('a day present but not exactly 24 entries is refused', () => {
  const r = scheduleSchema({ showIds: IDS }).safeParse({ 0: Array(23).fill(null) });
  assert.equal(r.success, false);
  assert.match(r.error!.issues[0]!.message, /exactly 24 entries/);
});

test('a non-object grid is refused', () => {
  assert.equal(scheduleSchema({ showIds: IDS }).safeParse('nope').success, false);
  assert.equal(scheduleSchema({ showIds: IDS }).safeParse(null).success, false);
});

test('an ARRAY of seven days still loads (the hand-rolled reader took one)', () => {
  // z.object rejects arrays, so without the preprocess a settings.json that
  // used to load would start failing at boot.
  const asArray = Array.from({ length: SCHEDULE_DAYS }, () => Array(SCHEDULE_HOURS).fill(null));
  asArray[2]![9] = 'dawn_patrol';
  const r = scheduleSchema({ showIds: IDS }).parse(asArray);
  assert.equal(r[2]![9], 'dawn_patrol');
});

test('showIds non-null: an unknown show is an issue at its real coordinate', () => {
  const r = scheduleSchema({ showIds: IDS }).safeParse(weekWith(3, 14, 'ghost_show'));
  assert.equal(r.success, false);
  assert.deepEqual(r.error!.issues[0]!.path, [3, 14]);
  assert.match(r.error!.issues[0]!.message, /unknown show/);
});

test('showIds null: the same grid passes, because that caller cannot check', () => {
  const r = scheduleSchema({ showIds: null }).safeParse(weekWith(3, 14, 'ghost_show'));
  assert.equal(r.success, true);
});

// --- PUT /schedule ----------------------------------------------------------

test('save schema accepts the bare grid and the { schedule } wrapper alike', () => {
  const week = weekWith(4, 2, 'night_loop');
  assert.equal(scheduleSaveSchema.parse(week)[4]![2], 'night_loop');
  assert.equal(scheduleSaveSchema.parse({ schedule: week })[4]![2], 'night_loop');
});

test('save schema checks SHAPE only — an unknown show is not its business', () => {
  assert.equal(scheduleSaveSchema.safeParse(weekWith(4, 2, 'ghost_show')).success, true);
});

test('resolveScheduleSlots drops unknown shows and counts them', () => {
  const week = weekWith(4, 2, 'night_loop');
  week[4]![3] = 'ghost_show';
  week[5]![0] = 'ghost_show';
  const { schedule, dropped } = resolveScheduleSlots(week, IDS);
  assert.equal(schedule[4]![2], 'night_loop');
  assert.equal(schedule[4]![3], null);
  assert.equal(dropped, 2);
});

test('validateBody(scheduleSaveSchema) returns fieldErrors keyed by the day', async () => {
  const mw = validateBody(scheduleSaveSchema);
  const req: any = { body: { 0: Array(3).fill(null) } };
  let payload: any = null;
  const res: any = {
    status() { return this; },
    json(p: any) { payload = p; return this; },
  };
  await new Promise<void>(resolve => {
    mw(req, res, () => resolve());
    resolve();
  });
  assert.ok(payload, 'a malformed grid is refused at the route boundary');
  assert.match(payload.error, /exactly 24 entries/);
  assert.ok('0' in payload.fieldErrors);
});

// --- strict (update()) ------------------------------------------------------

test('strict: accepts a valid grid', () => {
  const week = validateScheduleStrict(weekWith(3, 14, 'night_loop'), SHOWS);
  assert.equal(week[3][14], 'night_loop');
});

test('strict: throws a plain readable Error naming the coordinate', () => {
  // A raw ZodError's .message is a ~15-line JSON blob and update() is reached
  // by backup restore, which answers { error: err.message }.
  assert.throws(
    () => validateScheduleStrict(weekWith(3, 14, 'ghost_show'), SHOWS),
    (err: Error) => {
      assert.equal(err.constructor.name, 'Error');
      assert.match(err.message, /^schedule\.3\.14: /);
      assert.match(err.message, /unknown show/);
      return true;
    },
  );
});

test('strict: throws on a short day, naming the day', () => {
  assert.throws(
    () => validateScheduleStrict({ 2: Array(5).fill(null) }, SHOWS),
    /^Error: schedule\.2: .*exactly 24 entries/,
  );
});

// --- lenient (load) ---------------------------------------------------------

test('lenient: an unknown show is blanked, the rest of the grid survives', () => {
  const week = weekWith(3, 14, 'night_loop');
  week[3]![15] = 'ghost_show';
  const r = normalizeSchedule(week, IDS);
  assert.equal(r[3]![14], 'night_loop');
  assert.equal(r[3]![15], null);
});

test('lenient: never throws, whatever is on disk', () => {
  for (const junk of [null, undefined, 'nope', 42, [], {}, { 0: 'not-an-array' }, { 3: [1, 2] }]) {
    const r = normalizeSchedule(junk, IDS);
    assert.equal(r[0]!.length, SCHEDULE_HOURS);
  }
});

test('lenient: a short day is padded rather than dropping the whole grid', () => {
  // The rule strict refuses, load repairs — the split the conversion exists to
  // make explicit. A boot must not lose the other six days over one bad row.
  const r = normalizeSchedule({ 1: ['night_loop'], 2: Array(SCHEDULE_HOURS).fill('dawn_patrol') }, IDS);
  assert.equal(r[1]![0], 'night_loop');
  assert.equal(r[1]!.length, SCHEDULE_HOURS);
  assert.equal(r[2]![23], 'dawn_patrol');
});

test('repairScheduleForLoad lands on a value the strict path accepts', () => {
  const repaired = repairScheduleForLoad({ 3: ['ghost_show', 'night_loop'] }, IDS);
  assert.equal(scheduleSchema({ showIds: IDS }).safeParse(repaired).success, true);
  assert.equal(repaired[3]![0], null);
  assert.equal(repaired[3]![1], 'night_loop');
});

// --- the takeover -----------------------------------------------------------

const NOW = 1_800_000_000_000;
const okOverride = { showId: 'night_loop', startedAt: NOW, expiresAt: NOW + 60 * 60_000 };
const defaultOverride = { showId: null, startedAt: NOW, expiresAt: NOW + 60 * 60_000 };

test('override: accepts named-show and Default programming windows', () => {
  const schema = scheduleOverrideSchema({ showIds: IDS, now: null });
  assert.deepEqual(schema.parse(okOverride), okOverride);
  assert.deepEqual(schema.parse(defaultOverride), defaultOverride);
});

// The takeover target is THREE-way, and the two obvious inline spellings of the
// question disagree about the third case. These pin which answer each predicate
// gives, because every reader in the controller and the admin UI asks through
// them — a drift here is a resolver and a /schedule route describing the same
// stored override differently.
test('takeover target: a show, Default programming, and neither', () => {
  const win = { startedAt: NOW, expiresAt: NOW + 60 * 60_000 };
  assert.equal(takeoverShowId({ ...win, showId: 'night_loop' }), 'night_loop');
  assert.equal(isDefaultTakeover({ ...win, showId: 'night_loop' }), false);

  assert.equal(takeoverShowId({ ...win, showId: null }), null);
  assert.equal(isDefaultTakeover({ ...win, showId: null }), true);

  // Neither: a malformed target names nothing real, so it is not a show pin AND
  // not Default programming. Pre-#1507 the roster lookup missed and the grid
  // resumed; both predicates saying "no" is what keeps that behaviour.
  for (const bad of [undefined, '', 0, 42, {}, []]) {
    assert.equal(takeoverShowId({ ...win, showId: bad }), null, String(bad));
    assert.equal(isDefaultTakeover({ ...win, showId: bad }), false, String(bad));
  }

  // No takeover at all is neither, and must not throw on the way there.
  assert.equal(takeoverShowId(null), null);
  assert.equal(isDefaultTakeover(null), false);
  assert.equal(takeoverShowId(undefined), null);
  assert.equal(isDefaultTakeover(undefined), false);
});

test('override: Default programming is distinct from a cleared outer override', () => {
  assert.deepEqual(validateScheduleOverrideStrict(defaultOverride, SHOWS), defaultOverride);
  assert.equal(validateScheduleOverrideStrict(null, SHOWS), null);
});

test('override: refuses an unknown show, a backwards window and an over-long one', () => {
  const schema = scheduleOverrideSchema({ showIds: IDS, now: null });
  assert.equal(schema.safeParse({ ...okOverride, showId: 'ghost_show' }).success, false);
  assert.equal(schema.safeParse({ ...okOverride, expiresAt: NOW - 1 }).success, false);
  assert.equal(
    schema.safeParse({ ...okOverride, expiresAt: NOW + (OVERRIDE_MAX_MINUTES + 1) * 60_000 })
      .success,
    false,
  );
});

test('override: a non-finite stamp is refused', () => {
  const schema = scheduleOverrideSchema({ showIds: IDS, now: null });
  assert.equal(schema.safeParse({ ...okOverride, startedAt: NaN }).success, false);
  assert.equal(schema.safeParse({ ...okOverride, startedAt: '123' }).success, false);
});

test('override: `now` is what makes expiry a rule, and only the load path passes one', () => {
  const expired = { showId: 'night_loop', startedAt: NOW - 60_000, expiresAt: NOW - 1 };
  assert.equal(scheduleOverrideSchema({ showIds: IDS, now: null }).safeParse(expired).success, true);
  assert.equal(scheduleOverrideSchema({ showIds: IDS, now: NOW }).safeParse(expired).success, false);
});

test('strict override: null and undefined clear the pin', () => {
  assert.equal(validateScheduleOverrideStrict(null, SHOWS), null);
  assert.equal(validateScheduleOverrideStrict(undefined, SHOWS), null);
});

test('strict override: throws a readable Error, not a ZodError', () => {
  assert.throws(
    () => validateScheduleOverrideStrict({ ...okOverride, showId: 'ghost_show' }, SHOWS),
    (err: Error) => {
      assert.equal(err.constructor.name, 'Error');
      assert.match(err.message, /^scheduleOverride\.showId: /);
      return true;
    },
  );
});

test('lenient override: a dangling or expired pin loads as null', () => {
  assert.equal(normalizeScheduleOverride({ ...okOverride, showId: 'ghost_show' }, IDS), null);
  assert.equal(normalizeScheduleOverride({ showId: 'night_loop', startedAt: 1, expiresAt: 2 }, IDS), null);
  assert.equal(normalizeScheduleOverride('nope', IDS), null);
  assert.equal(normalizeScheduleOverride(null, IDS), null);
});

test('lenient override: live show and Default programming takeovers survive boot', () => {
  const live = {
    showId: 'night_loop',
    startedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60 * 60_000,
  };
  const liveDefault = { ...live, showId: null };
  assert.deepEqual(normalizeScheduleOverride(live, IDS), live);
  assert.deepEqual(normalizeScheduleOverride(liveDefault, IDS), liveDefault);
});

// --- POST /schedule/override ------------------------------------------------

test('override request: accepts named shows, Default programming, and coerces a numeric string', () => {
  assert.equal(scheduleOverrideRequestSchema.parse({ showId: 'x', minutes: 60 }).minutes, 60);
  assert.equal(scheduleOverrideRequestSchema.parse({ showId: null, minutes: 60 }).showId, null);
  // The hand-rolled route ran Number(req.body?.minutes), so "60" was accepted.
  assert.equal(scheduleOverrideRequestSchema.parse({ showId: 'x', minutes: '60' }).minutes, 60);
});

test('override request: refuses out-of-range and non-integer minutes', () => {
  for (const minutes of [
    OVERRIDE_MIN_MINUTES - 1,
    OVERRIDE_MAX_MINUTES + 1,
    30.5,
    'soon',
    undefined,
  ]) {
    assert.equal(
      scheduleOverrideRequestSchema.safeParse({ showId: 'x', minutes }).success,
      false,
      `minutes=${String(minutes)} should be refused`,
    );
  }
  assert.equal(scheduleOverrideRequestSchema.safeParse({ showId: 'x', minutes: OVERRIDE_MIN_MINUTES }).success, true);
  assert.equal(scheduleOverrideRequestSchema.safeParse({ showId: 'x', minutes: OVERRIDE_MAX_MINUTES }).success, true);
});

test('override request: an empty showId is a 400, not a lookup that 404s on ""', () => {
  assert.equal(scheduleOverrideRequestSchema.safeParse({ minutes: 60 }).success, false);
  assert.equal(scheduleOverrideRequestSchema.safeParse({ showId: '', minutes: 60 }).success, false);
  assert.equal(scheduleOverrideRequestSchema.safeParse({ showId: undefined, minutes: 60 }).success, false);
});

test('override request: the minutes message names the real bounds', () => {
  const r = scheduleOverrideRequestSchema.safeParse({ showId: 'x', minutes: 1 });
  assert.equal(r.success, false);
  assert.match(
    r.error!.issues[0]!.message,
    new RegExp(`between ${OVERRIDE_MIN_MINUTES} and ${OVERRIDE_MAX_MINUTES}`),
  );
});
