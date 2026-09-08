// Shared schedule schema — the weekly grid and the timed takeover (#930). Run
// by validateScheduleStrict / validateScheduleOverrideStrict, the lenient load
// path, the PUT /schedule + POST /schedule/override middleware, and the
// mirrored browser copy.
//
// A FACTORY, like shows: a slot either names a real show or names nothing, and
// `showIds: null` means "this caller cannot check that rule". Three postures:
//
//   strict  (update())      showIds = live roster → unknown id THROWS
//   lenient (load)          showIds = live roster → repaired away before parsing
//   route   (PUT /schedule) showIds = null        → shape only; ids resolved
//                                                   afterwards by
//                                                   resolveScheduleSlots, which
//                                                   DROPS and COUNTS
//
// The third posture must not become a schema rule: the panel can hold a
// locally-added show the operator has not saved yet, so the route answers 200
// with a `dropped` count.
import { z } from 'zod';

// 0 (Sunday) .. 6 (Saturday), matching JS Date.getDay(); 24 hours per day.
export const SCHEDULE_DAYS = 7;
export const SCHEDULE_HOURS = 24;

// Bounds for POST /schedule/override's `minutes`: long enough for an all-day
// takeover, short enough that a forgotten pin cannot shadow the grid for days.
export const OVERRIDE_MIN_MINUTES = 15;
export const OVERRIDE_MAX_MINUTES = 720;

/** A blank 7-day x 24-hour grid. Each value is an array[24] of showId|null. */
export function emptyWeek(): ScheduleWeek {
  const week: ScheduleWeek = {};
  for (let d = 0; d < SCHEDULE_DAYS; d++) week[d] = Array(SCHEDULE_HOURS).fill(null);
  return week;
}

export type ScheduleWeek = Record<number, Array<string | null>>;

export interface ScheduleSchemaContext {
  /** The show ids a slot may name, or null when this caller cannot check (the
   *  shape is still checked and ids are taken on trust). */
  showIds: string[] | null;
}

// A show id, or any of the three ways "nothing" has been written to
// settings.json (null, undefined, empty string).
const scheduleSlotSchema = z
  .union([z.string(), z.null()], { error: 'must be a show id or null' })
  .optional();

// Exactly 24 entries when the day is present at all. An absent or null day is a
// blank day, not an error, so a partial grid still loads.
const scheduleDaySchema = z
  .array(scheduleSlotSchema)
  .length(SCHEDULE_HOURS, `must be an array of exactly ${SCHEDULE_HOURS} entries`)
  .nullish();

// The grid is persisted as an object keyed "0".."6". An ARRAY of seven days is
// still accepted because it always loaded; z.object rejects arrays outright.
function toScheduleWeekRecord(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  raw.slice(0, SCHEDULE_DAYS).forEach((day, i) => {
    out[i] = day;
  });
  return out;
}

type ParsedWeek = Record<number, Array<string | null | undefined> | null | undefined>;

function toScheduleWeek(parsed: unknown): ScheduleWeek {
  const src = parsed as ParsedWeek;
  const week = emptyWeek();
  for (let d = 0; d < SCHEDULE_DAYS; d++) {
    const day = src[d];
    if (!day) continue;
    for (let h = 0; h < SCHEDULE_HOURS; h++) {
      const v = day[h];
      week[d]![h] = typeof v === 'string' && v !== '' ? v : null;
    }
  }
  return week;
}

export function scheduleSchema(ctx: ScheduleSchemaContext) {
  return z
    .preprocess(
      toScheduleWeekRecord,
      z.object(
        {
          0: scheduleDaySchema,
          1: scheduleDaySchema,
          2: scheduleDaySchema,
          3: scheduleDaySchema,
          4: scheduleDaySchema,
          5: scheduleDaySchema,
          6: scheduleDaySchema,
        },
        { error: 'must be an object keyed 0-6' },
      ),
    )
    // Cross-slot rather than per-slot so the issue path is the real coordinate
    // (`schedule.3.14`) an operator needs to find the cell.
    .check((c) => {
      if (!ctx.showIds) return;
      const ids = new Set(ctx.showIds);
      const week = c.value as ParsedWeek;
      for (let d = 0; d < SCHEDULE_DAYS; d++) {
        const day = week[d];
        if (!day) continue;
        for (let h = 0; h < SCHEDULE_HOURS; h++) {
          const v = day[h];
          if (typeof v === 'string' && v !== '' && !ids.has(v)) {
            c.issues.push({
              code: 'custom',
              input: v,
              path: [d, h],
              message: 'references an unknown show',
            });
          }
        }
      }
    })
    .transform(toScheduleWeek);
}

/**
 * PUT /schedule's body — the bare grid, or one wrapped in `{ schedule }`; both
 * spellings are accepted. Ids are NOT checked here (see the header): the route
 * resolves them with resolveScheduleSlots and reports a count. A day present but
 * not exactly 24 entries is rejected rather than padded.
 */
export const scheduleSaveSchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'schedule' in raw) {
    return (raw as { schedule: unknown }).schedule;
  }
  return raw;
}, scheduleSchema({ showIds: null }));

/**
 * Resolve a shape-valid grid against the live roster, dropping and COUNTING
 * slots naming a show that is not persisted. Deliberately not a schema rule:
 * the editor can hold a locally-added show, so PUT /schedule answers 200.
 */
export function resolveScheduleSlots(
  week: ScheduleWeek,
  showIds: string[],
): { schedule: ScheduleWeek; dropped: number } {
  const ids = new Set(showIds);
  const schedule = emptyWeek();
  let dropped = 0;
  for (let d = 0; d < SCHEDULE_DAYS; d++) {
    for (let h = 0; h < SCHEDULE_HOURS; h++) {
      const v = week[d]?.[h] ?? null;
      if (!v) continue;
      if (ids.has(v)) schedule[d]![h] = v;
      else dropped++;
    }
  }
  return { schedule, dropped };
}

/** The load path's repair: everything unrecognised becomes an empty slot. Lives
 *  beside the rule it repairs against, and lands on a value the strict path
 *  accepts (the schema is still run on the result). */
export function repairScheduleForLoad(raw: unknown, showIds: string[]): ScheduleWeek {
  const week = emptyWeek();
  const src = toScheduleWeekRecord(raw);
  if (!src || typeof src !== 'object') return week;
  const ids = new Set(showIds);
  const days = src as Record<number, unknown>;
  for (let d = 0; d < SCHEDULE_DAYS; d++) {
    const day = days[d];
    if (!Array.isArray(day)) continue;
    for (let h = 0; h < SCHEDULE_HOURS; h++) {
      const v = day[h];
      if (typeof v === 'string' && ids.has(v)) week[d]![h] = v;
    }
  }
  return week;
}

/**
 * A bounded takeover target. `showId: null` means Default programming; an
 * outer `scheduleOverride: null` means there is no takeover at all.
 */
export interface ScheduleOverride {
  showId: string | null;
  startedAt: number;
  expiresAt: number;
}

/**
 * The takeover target, read in ONE place — never inline a `showId` test. It is
 * three-way: a show, explicit `null` for Default programming (#1507), or
 * neither, and a target naming nothing real VOIDS the takeover. Both obvious
 * inline spellings get that third case wrong.
 *
 * Deliberately loose in their parameter, so a request body and an admin form's
 * submitted values can ask the same way a stored override does.
 */
export function takeoverShowId(ov: { showId?: unknown } | null | undefined): string | null {
  const id = ov?.showId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** True while `ov` is an explicit Default programming takeover (#1507). */
export function isDefaultTakeover(ov: { showId?: unknown } | null | undefined): boolean {
  return !!ov && ov.showId === null;
}

export interface ScheduleOverrideContext {
  /** Show ids a string target may name, or null when this caller cannot check. */
  showIds: string[] | null;
  /** Epoch-ms "now", or null to not judge expiry. Only the LOAD path passes a
   *  clock: a window that merely ran out is not update()'s input being wrong,
   *  and throwing there would fail an unrelated settings save. */
  now: number | null;
}

export function scheduleOverrideSchema(ctx: ScheduleOverrideContext) {
  return z
    .object(
      {
        // `.nullable()` rather than a union: null is the Default programming
        // target, and the string's own message is the actionable one.
        showId: z.string({ error: 'must be a show id' }).min(1, 'must be a show id').nullable(),
        startedAt: z.number({ error: 'must be an epoch-ms number' }).finite('must be an epoch-ms number'),
        expiresAt: z.number({ error: 'must be an epoch-ms number' }).finite('must be an epoch-ms number'),
      },
      // Explicit, and phrased WITHOUT the key: every caller roots this schema at
      // 'scheduleOverride', so self-naming would double it.
      { error: 'must be an object' },
    )
    .check((c) => {
      const { startedAt, expiresAt } = c.value;
      const showId = takeoverShowId(c.value);
      if (showId && ctx.showIds && !ctx.showIds.includes(showId)) {
        c.issues.push({
          code: 'custom',
          input: showId,
          path: ['showId'],
          message: 'references an unknown show',
        });
      }
      if (startedAt >= expiresAt) {
        c.issues.push({
          code: 'custom',
          input: expiresAt,
          path: ['expiresAt'],
          message: 'must be after startedAt',
        });
      } else if (expiresAt - startedAt > OVERRIDE_MAX_MINUTES * 60_000) {
        c.issues.push({
          code: 'custom',
          input: expiresAt,
          path: ['expiresAt'],
          message: `window must be at most ${OVERRIDE_MAX_MINUTES} minutes`,
        });
      }
      if (ctx.now !== null && expiresAt <= ctx.now) {
        c.issues.push({
          code: 'custom',
          input: expiresAt,
          path: ['expiresAt'],
          message: 'window has already expired',
        });
      }
    });
}

/**
 * How a takeover's end is chosen (#1601). `'fixed'` is `minutes` from now and is
 * the DEFAULT; `'schedule-change'` asks the server to end the pin at the next
 * weekly-grid boundary. It rides on the REQUEST and never on `ScheduleOverride`
 * — `expiresAt` stays an absolute instant, so the resolved pin is an ordinary
 * window every reader already understands.
 */
export const TAKEOVER_UNTIL = ['fixed', 'schedule-change'] as const;
export type TakeoverUntil = (typeof TAKEOVER_UNTIL)[number];

// One string for four constraints, naming both ends whichever one a value missed.
const OVERRIDE_MINUTES_MESSAGE =
  `must be an integer between ${OVERRIDE_MIN_MINUTES} and ${OVERRIDE_MAX_MINUTES}`;

/**
 * POST /schedule/override's body. `showId: null` requests Default programming;
 * an empty showId 400s rather than 404ing from the roster lookup. `minutes` is
 * coerced, so the string "60" is accepted.
 *
 * `minutes` is REQUIRED under `until: 'fixed'` and REFUSED under
 * `'schedule-change'`: the two fields must not be able to disagree about what
 * the caller asked for.
 */
export const scheduleOverrideRequestSchema = z
  .object({
    showId: z
      .string({ error: 'pick a show or Default programming' })
      .min(1, 'pick a show or Default programming')
      .nullable(),
    until: z.enum(TAKEOVER_UNTIL, { error: "must be 'fixed' or 'schedule-change'" }).default('fixed'),
    minutes: z.coerce
      .number({ error: OVERRIDE_MINUTES_MESSAGE })
      .int(OVERRIDE_MINUTES_MESSAGE)
      .min(OVERRIDE_MIN_MINUTES, OVERRIDE_MINUTES_MESSAGE)
      .max(OVERRIDE_MAX_MINUTES, OVERRIDE_MINUTES_MESSAGE)
      .optional(),
  })
  .check((c) => {
    if (c.value.until === 'fixed' && c.value.minutes == null) {
      c.issues.push({
        code: 'custom',
        input: c.value.minutes,
        path: ['minutes'],
        message: OVERRIDE_MINUTES_MESSAGE,
      });
    }
    if (c.value.until === 'schedule-change' && c.value.minutes != null) {
      c.issues.push({
        code: 'custom',
        input: c.value.minutes,
        path: ['minutes'],
        message: 'must be omitted when the window ends at the schedule change',
      });
    }
  });
