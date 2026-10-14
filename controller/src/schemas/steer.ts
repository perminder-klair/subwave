// A steer: the operator leans the music and the talk for a while, without
// touching the schedule. Sibling of the takeover in schemas/schedule.ts and
// shaped like it (an absolute window, `until` spent on the request), but it
// never changes which show is on air.
//
// Zod only: this file is mirrored into the admin bundle.
import { z } from 'zod';

export const STEER_PROMPT_MAX = 500;
// Restated from schedule.ts (OVERRIDE_MIN_MINUTES / OVERRIDE_MAX_MINUTES): a
// mirrored schema file imports nothing but zod. Pinned equal by steer-schema.test.ts.
export const STEER_MIN_MINUTES = 15;
export const STEER_MAX_MINUTES = 720;

export const STEER_UNTIL = ['once', 'fixed', 'schedule-change'] as const;
export type SteerUntil = (typeof STEER_UNTIL)[number];

export interface Steer {
  /** Only this playlist plays while the steer runs, or null. */
  playlistId: string | null;
  /** The operator's direction, already trimmed. May be empty with a playlist. */
  prompt: string;
  startedAt: number;
  expiresAt: number;
}

export interface SteerContext {
  /** Epoch-ms "now", or null to not judge expiry (see ScheduleOverrideContext). */
  now: number | null;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const NOTHING_TO_STEER = 'pick a playlist or say what to steer towards';

export function steerSchema(ctx: SteerContext) {
  return z
    .object(
      {
        playlistId: z.string({ error: 'must be a playlist id' }).min(1, 'must be a playlist id').nullable().default(null),
        prompt: z.string({ error: 'must be text' }).transform(collapse).pipe(
          z.string().max(STEER_PROMPT_MAX, `must be at most ${STEER_PROMPT_MAX} characters`),
        ),
        startedAt: z.number({ error: 'must be an epoch-ms number' }).finite('must be an epoch-ms number'),
        expiresAt: z.number({ error: 'must be an epoch-ms number' }).finite('must be an epoch-ms number'),
      },
      { error: 'must be an object' },
    )
    .check((c) => {
      const { playlistId, prompt, startedAt, expiresAt } = c.value;
      if (!prompt && !playlistId) {
        c.issues.push({ code: 'custom', input: prompt, path: ['prompt'], message: NOTHING_TO_STEER });
      }
      if (startedAt >= expiresAt) {
        c.issues.push({ code: 'custom', input: expiresAt, path: ['expiresAt'], message: 'must be after startedAt' });
      } else if (expiresAt - startedAt > STEER_MAX_MINUTES * 60_000) {
        c.issues.push({
          code: 'custom', input: expiresAt, path: ['expiresAt'],
          message: `window must be at most ${STEER_MAX_MINUTES} minutes`,
        });
      }
      if (ctx.now !== null && expiresAt <= ctx.now) {
        c.issues.push({ code: 'custom', input: expiresAt, path: ['expiresAt'], message: 'window has already expired' });
      }
    });
}

const STEER_MINUTES_MESSAGE = `must be an integer between ${STEER_MIN_MINUTES} and ${STEER_MAX_MINUTES}`;

/**
 * POST /steer's body. `until` says how long it lasts: `'fixed'` for `minutes`,
 * `'schedule-change'` to the next grid boundary, and `'once'` for a single
 * track worked out under it and queued, with nothing stored and no steer left
 * running. `minutes` is REQUIRED under `'fixed'` and REFUSED otherwise, the
 * takeover's own posture.
 */
export const steerRequestSchema = z
  .object({
    playlistId: z.string({ error: 'must be a playlist id' }).min(1, 'must be a playlist id').nullable().default(null),
    prompt: z.string({ error: 'must be text' }).transform(collapse).pipe(
      z.string().max(STEER_PROMPT_MAX, `must be at most ${STEER_PROMPT_MAX} characters`),
    ).default(''),
    until: z.enum(STEER_UNTIL, { error: "must be 'once', 'fixed' or 'schedule-change'" }).default('fixed'),
    minutes: z.coerce
      .number({ error: STEER_MINUTES_MESSAGE })
      .int(STEER_MINUTES_MESSAGE)
      .min(STEER_MIN_MINUTES, STEER_MINUTES_MESSAGE)
      .max(STEER_MAX_MINUTES, STEER_MINUTES_MESSAGE)
      .optional(),
    /** Also drop the picks already queued, so the steer applies at once. */
    startNow: z.boolean({ error: 'must be true or false' }).default(false),
    /** Have the host introduce the opening tracks with one link before the first. */
    introduce: z.boolean({ error: 'must be true or false' }).default(false),
  })
  .check((c) => {
    if (!c.value.prompt && !c.value.playlistId) {
      c.issues.push({ code: 'custom', input: c.value.prompt, path: ['prompt'], message: NOTHING_TO_STEER });
    }
    if (c.value.until === 'fixed' && c.value.minutes == null) {
      c.issues.push({ code: 'custom', input: c.value.minutes, path: ['minutes'], message: STEER_MINUTES_MESSAGE });
    }
    if (c.value.until !== 'fixed' && c.value.minutes != null) {
      c.issues.push({
        code: 'custom', input: c.value.minutes, path: ['minutes'],
        message: 'must be omitted unless the steer runs for a set time',
      });
    }
  });

/** The steer in force at `now`, or null. One reading for every caller. */
export function steerActiveAt<T extends { startedAt: number; expiresAt: number }>(
  steer: T | null | undefined,
  now: number,
): T | null {
  return steer && now >= steer.startedAt && now < steer.expiresAt ? steer : null;
}

/**
 * How a steer's text is put to a model, wherever it lands. It is the
 * operator's direction, the opposite class from a listener's message, and the
 * model must not give it away: a pick's stated reason is public.
 */
export function steerClause(text: string | null | undefined): string {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return '';
  return `\n\nOperator steer — trusted direction from the station operator, NOT a listener message. While it runs it outranks the show brief. Never mention the operator, this direction or that the music was changed, on air or in your pick reason: "${t.replace(/"/g, "'")}"`;
}
