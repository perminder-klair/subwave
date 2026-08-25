// The `POST /settings` patch registry (#1348).
//
// `settings.update()` takes a PARTIAL patch over 42 top-level keys and validates
// it in a long chain of `if ('<key>' in patch)` branches — a route that owns
// forty-two shapes doesn't fit #1337's one-schema-per-form recipe.
//
// This module is the frame the conversion lands in, one key at a time:
//
//   SETTINGS_PATCH_KEYS     every top-level key update() will act on
//   SETTINGS_PATCH_SCHEMAS  the subset converted to a shared schema so far
//   parseSettingsPatchKey() the strict posture — used INSIDE update()
//   validateSettingsPatch() the route posture — supplies `fieldErrors`
//
// Both postures run the SAME schema; only the consequence differs, which is
// #1337's rule. An unconverted key keeps its hand-rolled branch untouched and
// simply has no entry here, so the frame can land without a flag day.
//
// WHY UNKNOWN-KEY REJECTION IS A ROUTE POSTURE AND NEVER AN update() RULE
// ----------------------------------------------------------------------
// At the route, rejecting an unknown top-level key is right: every admin panel
// posts keys from this inventory, so an unknown one is a typo that would
// otherwise save nothing and still answer 200.
//
// Inside update() the same rule would be a data-loss bug. routes/backup.ts hands
// a whole backup settings.json to update(), as do onboarding and every internal
// caller. A backup written by a newer version carries keys this one has never
// heard of, and refusing the patch would turn "one setting didn't come across"
// into "the restore failed". So the inventory is enforced at the boundary the
// operator types at, and update() stays tolerant of keys it doesn't know.
import { ZodError, type ZodType } from 'zod';
import {
  archivePatchSchema,
  audioPatchSchema,
  bedsPatchSchema,
  silenceTrimPatchSchema,
  crossfadeDurationSchema,
  djHouseRulesSchema,
  djSpeakClockSchema,
  festivalsSchema,
  jingleRatioSchema,
  likesPatchSchema,
  localeSchema,
  loudnessPatchSchema,
  moodScheduleSchema,
  moodsSchema,
  privacyPatchSchema,
  requestsPatchSchema,
  scrobblePatchSchema,
  searchPatchSchema,
  sfxPatchSchema,
  stationDescriptionSchema,
  stationSchema,
  streamPatchSchema,
  timezoneSchema,
  transitionsPatchSchema,
  uiPatchSchema,
  weatherMoodsSchema,
  weatherPatchSchema,
  webhooksPolicyPatchSchema,
} from '../schemas/settings.js';
import {
  activeDjPromptIdSchema,
  djPromptTextSchema,
  maxTrackSecondsSchema,
  themePatchSchema,
} from '../schemas/settings.js';
import {
  DJ_PROMPT_TEXT_MAX,
  DJ_PROMPT_TEXT_MIN,
  djPromptsSchema,
  personasSchema,
} from '../schemas/persona.js';
import { scheduleOverrideSchema, scheduleSchema } from '../schemas/schedule.js';
import { SHOW_MAX_TRACK_SECONDS, showsSchema } from '../schemas/show.js';
import { webhooksSchema } from '../schemas/webhook.js';

// Mirrors settings/defaults.ts's BOUNDS.maxTrackSeconds, which reads its ceiling
// from the same SHOW_MAX_TRACK_SECONDS — a mirrored module may not import a
// non-mirrored one, so the bound is composed here rather than imported.
const MAX_TRACK_SECONDS_BOUNDS = { min: 0, max: SHOW_MAX_TRACK_SECONDS };
import { firstMessage, flattenIssues } from '../util/zod-error.js';

/**
 * Every top-level key `settings.update()` acts on, in the order its branches
 * run.
 *
 * Order is not decoration. update() applies moods before the orphan guard and
 * personas before shows before schedule, because each validates against what
 * the last one wrote. Iterating in branch order means the route reports the
 * SAME first failure update() would have thrown on, rather than a second
 * opinion that depends on JSON key order.
 *
 * `maxTrackMinutes` is the legacy alias `rawMaxTrackSec()` still reads, and
 * `stationDescription` is its own branch rather than part of `station` — both
 * are postable today and both were missing from the issue's inventory. A key
 * absent from this list is rejected at the route, so adding a settings key
 * means adding it here as well as the three edits in controller/CLAUDE.md.
 */
export const SETTINGS_PATCH_KEYS = [
  'jingleRatio',
  'crossfadeDuration',
  'maxTrackSeconds',
  'maxTrackMinutes',
  'archive',
  'stream',
  'loudness',
  'weather',
  'station',
  'stationDescription',
  'timezone',
  'locale',
  'theme',
  'moods',
  'moodSchedule',
  'weatherMoods',
  'festivals',
  'djPrompts',
  'activeDjPromptId',
  'djPrompt',
  'djHouseRules',
  'djSpeakClock',
  'personas',
  'shows',
  'schedule',
  'scheduleOverride',
  'activePersonaId',
  'tts',
  'llm',
  'search',
  'embedding',
  'skills',
  'audio',
  'transitions',
  'sfx',
  'beds',
  'silenceTrim',
  'ui',
  'privacy',
  'requests',
  'webhooks',
  'webhooksPolicy',
  'scrobble',
  'likes',
] as const;

export type SettingsPatchKey = (typeof SETTINGS_PATCH_KEYS)[number];

const SETTINGS_PATCH_KEY_SET: ReadonlySet<string> = new Set(SETTINGS_PATCH_KEYS);

/**
 * The context a factory-shaped entry validates against.
 *
 * Every field is nullable and null always means "this caller cannot check that
 * rule" — the convention ShowSchemaContext established. It travels as ONE value
 * and is never unpacked into per-field arguments, for the reason PickerScope
 * documents: a rule named in one list and forgotten in another silently stops
 * being enforced on one path while the other still applies it.
 */
export interface SettingsPatchContext {
  /** The EFFECTIVE mood vocabulary — the same-patch one when `moods` is in the
   *  body. The route cannot know it (that is update()'s ordering to resolve),
   *  so it passes null and checks shape only. */
  moodNames: string[] | null;
  /** The EFFECTIVE show roster, for `scheduleOverride`'s "must name a real
   *  show" rule. Null for the same reason as moodNames: `shows` may ride in the
   *  same body, and only update() has applied it by the time this is judged. */
  showIds: string[] | null;
}

export const SETTINGS_PATCH_SHAPE_ONLY: SettingsPatchContext = {
  moodNames: null,
  showIds: null,
};

type SettingsPatchEntry = ZodType | ((ctx: SettingsPatchContext) => ZodType);

/**
 * The converted keys. Everything else still lives in its hand-rolled branch.
 *
 * Adding an entry here is what moves a key onto the shared schema: update()'s
 * branch switches to parseSettingsPatchKey() and the route starts producing
 * `fieldErrors` for it, in one edit.
 *
 * An entry is either a plain schema or a FACTORY over SettingsPatchContext,
 * for the shapes that cannot be validated against themselves.
 */
export const SETTINGS_PATCH_SCHEMAS: Readonly<Partial<Record<SettingsPatchKey, SettingsPatchEntry>>> = {
  jingleRatio: jingleRatioSchema,
  crossfadeDuration: crossfadeDurationSchema,
  archive: archivePatchSchema,
  stream: streamPatchSchema,
  loudness: loudnessPatchSchema,
  weather: weatherPatchSchema,
  station: stationSchema,
  stationDescription: stationDescriptionSchema,
  locale: localeSchema,
  djHouseRules: djHouseRulesSchema,
  djSpeakClock: djSpeakClockSchema,
  search: searchPatchSchema,
  audio: audioPatchSchema,
  transitions: transitionsPatchSchema,
  sfx: sfxPatchSchema,
  beds: bedsPatchSchema,
  silenceTrim: silenceTrimPatchSchema,
  ui: uiPatchSchema,
  webhooksPolicy: webhooksPolicyPatchSchema,
  scrobble: scrobblePatchSchema,
  likes: likesPatchSchema,
  moods: moodsSchema,
  moodSchedule: moodScheduleSchema,
  weatherMoods: weatherMoodsSchema,
  festivals: festivalsSchema,
  timezone: timezoneSchema,
  privacy: privacyPatchSchema,
  requests: requestsPatchSchema,
  // Both are validated by the SAME schema update() reaches through
  // validatePersonasStrict / validateDjPromptsStrict. Their branches are NOT
  // switched to parseSettingsPatchKey, because both need a server-only step the
  // schema deliberately cannot do — resolvePersonaIds / resolveDjPromptIds mint
  // and de-duplicate ids, which is a side effect. Registering them here is what
  // gives the Personas panel its `fieldErrors` channel; the strict validators
  // stay the authoritative chokepoint, and both run one implementation.
  personas: personasSchema,
  djPrompts: djPromptsSchema,
  // Shape and bounds only — each of these keeps a genuinely stateful half in
  // update(), named on its schema: theme's async "does this id exist" fallback,
  // maxTrackSeconds' crossfade-derived floor, activeDjPromptId's membership in a
  // library the same patch may be replacing, and djPrompt's mapping onto that
  // library. Registering the pure half is still worth it: it is what gives these
  // inputs a `fieldErrors` key, and it moves the refusal to the boundary.
  theme: themePatchSchema,
  maxTrackSeconds: maxTrackSecondsSchema(MAX_TRACK_SECONDS_BOUNDS),
  activeDjPromptId: activeDjPromptIdSchema,
  djPrompt: djPromptTextSchema({ min: DJ_PROMPT_TEXT_MIN, max: DJ_PROMPT_TEXT_MAX }),
  // A FACTORY over the show roster — null at the route (shows may ride in the
  // same body), the real list inside update(). Nullable because clearing the
  // pin is how a takeover is cancelled.
  scheduleOverride: (ctx) =>
    scheduleOverrideSchema({ showIds: ctx.showIds, now: null }).nullable(),
  // These three were already on a shared schema before this registry existed —
  // update() reaches them through validateShowsStrict / validateScheduleStrict /
  // validateWebhooksStrict, which is where their server-only halves live (id
  // resolution, the redacted-secret merge, the drop-and-count posture). What
  // they lacked was a ROUTE, so a panel posting them to /settings got a flat
  // 400 and no `fieldErrors`. Registering the pure half closes that without
  // touching their branches.
  //
  // Every context field is null: the route cannot know the roster, the mood
  // vocabulary, the theme registry or the crossfade-derived floor, any of which
  // the same body may be changing. Shape and per-field rules still apply.
  shows: (ctx) =>
    showsSchema({
      // personaIds is NOT nullable on ShowSchemaContext — a show with no owner
      // has none on either path — so the route passes the empty roster, which
      // makes host membership unresolvable and therefore unchecked here.
      personaIds: [],
      moodNames: ctx.moodNames,
      themeIds: null,
      minTrackSeconds: null,
    }),
  schedule: (ctx) => scheduleSchema({ showIds: ctx.showIds }),
  webhooks: webhooksSchema,
};

/** Resolve an entry against a context — a plain schema ignores it. */
function schemaFor(key: SettingsPatchKey, ctx: SettingsPatchContext): ZodType | undefined {
  const entry = SETTINGS_PATCH_SCHEMAS[key];
  if (!entry) return undefined;
  return typeof entry === 'function' ? entry(ctx) : entry;
}

/**
 * Dotted paths for `fieldErrors`, rooted at the settings key.
 *
 * A block schema reports `thresholdSec`; the form input is `beds.thresholdSec`,
 * which is also react-hook-form's setError syntax. A scalar key's issue has an
 * empty path, so it maps to the bare key.
 */
function prefixed(key: string, issues: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [path, message] of Object.entries(issues)) {
    out[path ? `${key}.${path}` : key] = message;
  }
  return out;
}

/**
 * The flat `error` string — the first issue's message, VERBATIM.
 *
 * INVARIANT: every message in SETTINGS_PATCH_SCHEMAS is the exact string its
 * hand-rolled branch threw, and is written to stand alone.
 *
 * This is the one place that does NOT go through `firstMessage`, and the
 * exception is narrow. firstMessage prefixes the issue path unconditionally
 * because zod's BUILT-IN messages name a constraint and never a location —
 * 'expected array, received string' is useless without 'webhooks.1.url' in
 * front. Every message here is custom and already self-locating, so prefixing
 * would produce 'crossSec: beds.crossSec must be number in [0, 15]'. Carrying
 * the message as written keeps these strings byte-identical to the branches
 * they replace, which operators have been reading in toasts for as long as the
 * keys have existed.
 *
 * Most of them name a dotted field ('beds.thresholdSec must be …') but NOT all:
 * 'station name must be 80 chars or fewer', 'search.baseUrl too long' and
 * "locale must be 'en-GB' or 'en-US'" are all shipping strings that don't fit
 * that mould. The enforced rule is therefore the weaker, true one — a message
 * must be non-empty, single-line, and must not be one of zod's built-ins —
 * checked structurally in scripts/settings-patch-schema.test.ts by throwing
 * hostile values at every registered schema. The dotted path is never lost: it
 * rides `fieldErrors`, which is where a form needs it anyway.
 *
 * `firstMessage` remains the fallback for an issue carrying no message at all,
 * so a future schema cannot produce a bare 400.
 */
function flatten(err: ZodError): string {
  return err.issues[0]?.message || firstMessage(err);
}

/**
 * The keys whose messages are NOT self-locating, and therefore need the path
 * prefixed after all.
 *
 * The verbatim rule above holds for a BLOCK ('beds.thresholdSec must be …') and
 * for a scalar, because there is exactly one place the failure can be. It
 * breaks for an ARRAY: the persona schema's message is 'name must be 1-40
 * chars', and on a 20-persona roster that names no row at all — which is the
 * precise failure `firstMessage` was written to fix, and which
 * validatePersonasStrict already avoids by rooting at its settings key. Rooting
 * these here is what keeps the route's flat string identical to the one
 * update() throws for the same body, rather than a less useful second opinion.
 *
 * A key belongs here when its schema is an array (or otherwise reports issues
 * at a path), NOT when its messages merely happen to omit the key name.
 */
const SETTINGS_PATCH_ROOTED_KEYS: ReadonlySet<string> = new Set<SettingsPatchKey>([
  'personas',
  'djPrompts',
  // A nested object rather than an array, but the same reason: its messages
  // ('must be a show id', 'must be an object') are phrased WITHOUT the key,
  // because validateScheduleOverrideStrict has always rooted them here. Adding
  // the key to the text instead would double it on that path.
  'scheduleOverride',
  // The same three validate*Strict functions already root at their settings
  // key, so the route must too or the two disagree about the same body.
  'shows',
  'schedule',
  'webhooks',
]);

/** Root the flat message at its settings key when that key needs it. */
function flattenFor(key: SettingsPatchKey, err: ZodError): string {
  return SETTINGS_PATCH_ROOTED_KEYS.has(key) ? firstMessage(err, key) : flatten(err);
}

/**
 * Strict posture — parse ONE key's value, or throw a plain Error.
 *
 * Used inside update(), which answers `{ error: err.message }`. A raw ZodError
 * must never reach that: its `.message` is a pretty-printed JSON array, ~15
 * lines of it, and update() is reached by backup restore and PUT /settings
 * alike.
 *
 * A key with no schema yet is returned untouched, so a caller can route every
 * key through here as the conversion proceeds.
 */
export function parseSettingsPatchKey<T = unknown>(
  key: SettingsPatchKey,
  value: unknown,
  ctx: SettingsPatchContext = SETTINGS_PATCH_SHAPE_ONLY,
): T {
  const schema = schemaFor(key, ctx);
  if (!schema) return value as T;
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(flattenFor(key, r.error));
  return r.data as T;
}

export interface SettingsPatchFailure {
  error: string;
  fieldErrors: Record<string, string>;
}

/**
 * Route posture — validate a whole patch, reporting every failure at once.
 *
 * Returns null when the patch is acceptable. Note it validates and does NOT
 * rewrite the body: update() re-runs the same schemas as it applies each key,
 * and it is still the authoritative chokepoint. Coercion is pure, so running it
 * twice costs nothing and leaves exactly one place that decides what gets
 * stored.
 *
 * Unknown keys are collected rather than short-circuited — an operator who
 * mistyped two keys should learn both.
 */
export function validateSettingsPatch(patch: unknown): SettingsPatchFailure | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { error: 'settings patch must be an object', fieldErrors: {} };
  }
  const body = patch as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !SETTINGS_PATCH_KEY_SET.has(k));
  if (unknown.length) {
    const fieldErrors: Record<string, string> = Object.create(null);
    for (const k of unknown) fieldErrors[k] = 'not a settings key';
    return {
      error: `unknown settings key${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
      fieldErrors,
    };
  }

  let error = '';
  let fieldErrors: Record<string, string> = Object.create(null);
  for (const key of SETTINGS_PATCH_KEYS) {
    if (!(key in body)) continue;
    // SHAPE-ONLY at the route for factory entries. The effective mood
    // vocabulary depends on whether `moods` rides in the same body and on what
    // validating it produced — update()'s ordering to resolve, not the
    // middleware's. Same three-posture split PUT /schedule already uses.
    const schema = schemaFor(key, SETTINGS_PATCH_SHAPE_ONLY);
    if (!schema) continue;
    const r = schema.safeParse(body[key]);
    if (r.success) continue;
    // First failure in BRANCH order owns the flat string, so the route and
    // update() agree on which problem to name.
    if (!error) error = flattenFor(key, r.error);
    fieldErrors = { ...fieldErrors, ...prefixed(key, flattenIssues(r.error)) };
  }
  return error ? { error, fieldErrors } : null;
}
