// Shared schedule schema — the weekly grid (#shows) and the timed takeover
// (#930), executed on BOTH sides. The controller runs it in
// settings.validate.validateScheduleStrict / validateScheduleOverrideStrict
// (the update() chokepoint), in settings.normalize.normalizeSchedule /
// normalizeScheduleOverride (the lenient load path) and in the PUT /schedule +
// POST /schedule/override route middleware; the browser runs the mirrored copy
// (web/lib/schemas.generated.ts) for the takeover dialog's minute bounds.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// That includes OTHER schema modules — the mirror is one flat concatenation, so
// gen-schemas.ts rejects every specifier but 'zod' and each module has to stand
// alone.
//
// WHY A FACTORY, like shows. A schedule slot cannot be validated against
// itself: it either names a real show or it names nothing. That single input
// travels as a ScheduleSchemaContext whose `showIds` is NULLABLE, and null
// means the same thing it means for a show — **this caller cannot check that
// rule**. It is what lets three postures share one schema:
//
//   strict  (update())      showIds = the live roster  → unknown id THROWS
//   lenient (load)          showIds = the live roster  → unknown id is REPAIRED
//                                                        away before parsing
//   route   (PUT /schedule) showIds = null             → shape only; the ids are
//                                                        resolved afterwards by
//                                                        resolveScheduleSlots,
//                                                        which DROPS and COUNTS
//
// That third posture is not a schema rule and must not become one: the panel
// can hold a locally-added show the operator has not saved yet, so PUT
// /schedule deliberately answers 200 with a `dropped` count rather than 400.
import { z } from 'zod';

// 0 (Sunday) .. 6 (Saturday), matching JS Date.getDay(); 24 hours per day.
// Previously written as bare 7 / 24 literals in six files across both packages.
export const SCHEDULE_DAYS = 7;
export const SCHEDULE_HOURS = 24;

// Bounds for POST /schedule/override's `minutes` — long enough for an all-day
// takeover, short enough that a forgotten pin can't shadow the grid for days.
// Homed here because web/components/admin/dash/TakeoverCard.tsx carried a
// hand-copied pair under a "Mirror the controller's OVERRIDE_MIN/MAX_MINUTES"
// comment, which is exactly the drift these conversions exist to delete.
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
  /**
   * The show ids a slot may name, or null when this caller cannot check.
   *
   * Non-null and a slot names something else → an issue. Null → the shape is
   * checked and every id is taken on trust, for a caller that resolves ids
   * itself (the route) or has no roster yet.
   */
  showIds: string[] | null;
}

// A stored slot: a show id, or any of the three ways "nothing" has been written
// to settings.json over the years (null, undefined, empty string).
const scheduleSlotSchema = z
  .union([z.string(), z.null()], { error: 'must be a show id or null' })
  .optional();

// Exactly 24 entries when the day is present at all — the rule the strict
// validator has always enforced. An absent or null day is a blank day, not an
// error, so a partial grid still loads.
const scheduleDaySchema = z
  .array(scheduleSlotSchema)
  .length(SCHEDULE_HOURS, `must be an array of exactly ${SCHEDULE_HOURS} entries`)
  .nullish();

// The grid has always been persisted as an object keyed "0".."6". An ARRAY of
// seven days is accepted here only because the hand-rolled validator it
// replaces read `raw[d]` and therefore took one without noticing; z.object
// rejects arrays outright, so without this a shape that used to load would
// start failing at boot.
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
    // (`schedule.3.14`), which is what firstMessage prints and what an operator
    // needs in order to find the cell.
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
 * PUT /schedule's body — the bare grid, or one wrapped in `{ schedule }`.
 *
 * Both spellings were accepted by `req.body?.schedule ?? req.body` and both
 * still are. Ids are NOT checked here (see the header): the route resolves them
 * against the live roster with resolveScheduleSlots and reports a count.
 *
 * This DOES newly reject a day that is present but not exactly 24 entries long,
 * where the route silently padded it with nulls. Same call the stations
 * conversion made three times: a grid quietly reshaped server-side is a grid
 * the operator cannot tell was reshaped, and the strict validator behind
 * update() has always refused it — so accepting it at the route only meant the
 * two disagreed about the same data.
 */
export const scheduleSaveSchema = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'schedule' in raw) {
    return (raw as { schedule: unknown }).schedule;
  }
  return raw;
}, scheduleSchema({ showIds: null }));

/**
 * Resolve a shape-valid grid against the live roster, dropping and COUNTING
 * slots that name a show which isn't persisted.
 *
 * Pure, and deliberately not a schema rule — PUT /schedule answers 200 with
 * `dropped` because the editor can hold a locally-added show the operator
 * hasn't saved yet, and rejecting the save would strand it.
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

/**
 * The load path's repair: everything unrecognised becomes an empty slot.
 *
 * Lives beside the rule it repairs against, like repairShowForLoad — a repair
 * in normalize.ts restating ~5 schema rules inline is how the shows load path
 * ended up able to delete a whole show. Each repair lands on a value the strict
 * path would accept, and the schema is still run on the result.
 */
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

// ── Timed takeover (#930) ────────────────────────────────────────────────────

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
 * The takeover target, read in ONE place.
 *
 * A takeover's `showId` is three-way, not two-way — it names a show, it is
 * explicitly `null` for Default programming (#1507), or it is neither — and the
 * two obvious spellings of the question DISAGREE about that third case:
 * `showId === null` calls a malformed target a show pin, `typeof showId ===
 * 'string'` calls it Default programming. Both are wrong: before #1507 a target
 * that named nothing real simply VOIDED the takeover (the roster lookup missed
 * and the grid resumed), and that is the behaviour these two keep. The resolver,
 * the roster sweep, the janitor, the programme span, the route and both admin
 * screens all ask through them, so the answer cannot drift between call sites.
 *
 * Deliberately loose in their parameter: the route asks about a request body
 * and the admin forms about their own submitted values, neither of which is a
 * stored `ScheduleOverride` yet.
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
  /**
   * Epoch-ms "now", or null to not judge expiry at all.
   *
   * Only the LOAD path passes a clock: an override that has already run out is
   * transient state worth dropping at boot, whereas update() persisting one
   * with a past `expiresAt` is not an input error — the operator's own window
   * simply ended, and throwing there would fail an unrelated settings save.
   */
  now: number | null;
}

export function scheduleOverrideSchema(ctx: ScheduleOverrideContext) {
  return z
    .object(
      {
        // `.nullable()` rather than a two-branch union: null is the Default
        // programming target, and the string's own message is the one an
        // operator can act on — a union answers with its own wording instead.
        showId: z.string({ error: 'must be a show id' }).min(1, 'must be a show id').nullable(),
        startedAt: z.number({ error: 'must be an epoch-ms number' }).finite('must be an epoch-ms number'),
        expiresAt: z.number({ error: 'must be an epoch-ms number' }).finite('must be an epoch-ms number'),
      },
      // Explicit, so a non-object never reaches an operator as zod's own
      // 'Invalid input: expected object, received number'. Phrased WITHOUT the
      // key, like the field messages above, because every caller roots this
      // schema at 'scheduleOverride' — self-naming here would double it.
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
 * POST /schedule/override's body.
 *
 * `showId: null` requests Default programming; an outer missing field is still
 * malformed. `minutes` is coerced because the hand-rolled route ran
 * `Number(req.body?.minutes)` and therefore accepted the string "60". An EMPTY
 * showId now 400s
 * where it used to reach the roster lookup and 404 as `no such show: ` — a
 * missing field is a malformed request, not a missing show. A real id that
 * isn't in the roster still 404s from the handler, which is the answer that
 * needs server state.
 */
export const scheduleOverrideRequestSchema = z.object({
  showId: z
    .string({ error: 'pick a show or Default programming' })
    .min(1, 'pick a show or Default programming')
    .nullable(),
  minutes: z.coerce
    .number({ error: `must be an integer between ${OVERRIDE_MIN_MINUTES} and ${OVERRIDE_MAX_MINUTES}` })
    .int(`must be an integer between ${OVERRIDE_MIN_MINUTES} and ${OVERRIDE_MAX_MINUTES}`)
    .min(OVERRIDE_MIN_MINUTES, `must be an integer between ${OVERRIDE_MIN_MINUTES} and ${OVERRIDE_MAX_MINUTES}`)
    .max(OVERRIDE_MAX_MINUTES, `must be an integer between ${OVERRIDE_MIN_MINUTES} and ${OVERRIDE_MAX_MINUTES}`),
});
