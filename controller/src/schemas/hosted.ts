// Hosted mode (SUBWAVE_HOSTED): the rules a SUB/WAVE Cloud station shares
// between the controller and the web admin. The controller reads the env
// through util/env.ts with these parsers and enforces the rules on every save
// (setup/hosted.ts); the web's server pages read the same env through the
// generated mirror (web/lib/hosted.ts) to decide what to show. One parser per
// variable, so the two sides can never read one value two ways.
//
// Each parser takes the raw, non-empty env string; an unset or empty variable
// never reaches it (util/env.ts and web/lib/hosted.ts treat that as "unset").

import { z } from 'zod';

const HOSTED_FLAG_ON = ['1', 'true', 'yes', 'on'] as const;
const HOSTED_FLAG_OFF = ['0', 'false', 'no', 'off'] as const;

/** SUBWAVE_HOSTED: on or off. Any other word is malformed, never "on". */
export const hostedFlagSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum([...HOSTED_FLAG_ON, ...HOSTED_FLAG_OFF], { error: 'is not one of 1/true/yes/on or 0/false/no/off' }))
  .transform((v) => (HOSTED_FLAG_ON as readonly string[]).includes(v));

/**
 * The lowest stream ceiling a plan can have. MP3 is always served and its
 * lowest bitrate is 64 (SETTINGS_MP3_BITRATES, pinned by hosted-mode.test.ts),
 * so a ceiling under it could not be honoured: the MP3 mount would air above it.
 */
export const HOSTED_MIN_BITRATE = 64;
const HOSTED_MAX_BITRATE_LIMIT = 10_000;

/** SUBWAVE_MAX_BITRATE: the plan's stream ceiling, whole kbps. */
export const hostedMaxBitrateSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().regex(/^\d+$/, 'is not a whole number of kbps'))
  .transform(Number)
  .pipe(z
    .number()
    .int()
    .min(HOSTED_MIN_BITRATE, `must be at least ${HOSTED_MIN_BITRATE} kbps, MP3's lowest bitrate`)
    .max(HOSTED_MAX_BITRATE_LIMIT, `must be at most ${HOSTED_MAX_BITRATE_LIMIT} kbps`));

const HOSTED_LISTENER_CAP_LIMIT = 10_000;

/** SUBWAVE_LISTENER_CAP: the plan's concurrent-listener ceiling. */
export const hostedListenerCapSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().regex(/^\d+$/, 'is not a whole number'))
  .transform(Number)
  .pipe(z.number().int().min(1, 'must be at least 1').max(HOSTED_LISTENER_CAP_LIMIT, `must be at most ${HOSTED_LISTENER_CAP_LIMIT}`));

/**
 * SUBWAVE_MUSIC_UPLOAD_URL / SUBWAVE_MUSIC_LIBRARY_URL: https only, so a stray
 * value can't become a javascript: link on the music source page.
 */
export const hostedHttpsUrlSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().regex(/^https:\/\/[^\s"'<>]+$/, 'is not an https URL'));

/**
 * The engines a persona or jingle voice slot may pin on a hosted station: the
 * station default (`inherit`) and the two local engines the box runs, plus the
 * brain's cloud voice when the station itself speaks through it (premium).
 * Heavy engines aren't on hosted boxes, and a cloud pin on a base station would
 * need a key of the owner's own, which hosted mode doesn't store.
 */
export function hostedPersonaEngines(defaultEngine: unknown): string[] {
  return ['inherit', 'kokoro', 'piper', ...(defaultEngine === 'cloud' ? ['cloud'] : [])];
}
