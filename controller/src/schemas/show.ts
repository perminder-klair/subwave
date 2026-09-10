// Shared show schema — run by validateShowsStrict (the update() chokepoint),
// normalizeShows (the lenient load path), the POST /shows route middleware and
// the mirrored browser copy.
//
// A FACTORY because a show cannot be validated against itself: personaId must
// name a real persona, moods a live mood, themeId an installed theme, and the
// two track-length fields clear a crossfade-derived floor. Those four travel as
// ONE ShowSchemaContext, never unpacked into separate arguments.
//
// Impure rules (id minting, cross-row dedupe) live in show-server.ts, which is
// not mirrored.
import { z } from 'zod';

// Entity id: shows, personas and skills share this pattern, re-declared per
// module (zod-only imports). settings/vocab.ts re-exports it as ID_RE.
export const SHOW_ID_RE = /^[a-z0-9_]{3,32}$/;

export const SHOWS_LIMIT = 64;
export const SHOW_NAME_MAX = 60;
export const SHOW_TOPIC_MAX = 2000;
export const GUESTS_PER_SHOW = 3;
export const PLAYLISTS_PER_SHOW = 10;
export const EXCLUDED_PLAYLISTS_PER_SHOW = 10;
// Per-attribute ceiling on the multi-value music filters (#929).
export const SHOW_FILTER_VALUES_MAX = 15;
export const SHOW_GENRE_MAX = 64;
export const SHOW_SEGMENT_SKILL_MAX = 64;
export const SHOW_THEME_ID_MAX = 64;

// Freeform organisation tags, the twin of skill.ts's SKILL_TAG_RE (re-declared
// for the same zod-only reason).
export const SHOW_TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const SHOW_TAG_MAX = 24;
export const TAGS_PER_SHOW_LIMIT = 8;
export const SHOW_YEAR_MIN = 1900;
export const SHOW_YEAR_MAX = 2100;
// Also the STATION-wide cap's ceiling; settings/defaults.ts BOUNDS reads it
// from here so the two cannot drift.
export const SHOW_MAX_TRACK_SECONDS = 36000;
// Ceiling on the per-show minimum-track-length FLOOR (#1573). Far below
// SHOW_MAX_TRACK_SECONDS on purpose: a ten-hour cap is a harmless "no cap", a
// ten-hour floor is a show that can never pick anything. Twinned with
// schemas/settings.ts's PICKER_MIN_TRACK_LENGTH_BOUNDS.max — separate
// declarations of one number, so they must move together.
export const SHOW_MIN_TRACK_LENGTH_MAX = 3600;

export const SHOW_ENERGY = ['low', 'medium', 'high'] as const;
export const SHOW_VOCALS = ['instrumental', 'vocal'] as const;

export type EraWindow = { fromYear: number | null; toYear: number | null };

/**
 * Everything a show can only be judged against from outside itself. Three fields
 * are NULLABLE and null always means "this caller cannot check that rule", which
 * is how the lenient load path and the strict save path share one schema:
 *
 *   - `moodNames: null` — load runs before the mood cache exists.
 *   - `themeIds: null` — load has no theme registry; a stale id is harmless.
 *   - `minTrackSeconds: null` — the crossfade-derived floor under BOTH
 *     maxTrackSeconds and minTrackLengthSeconds; load clamps to hard bounds.
 *
 * `personaIds` is NOT nullable: a show whose host does not exist has no owner on
 * either path (strict throws, lenient drops the row).
 */
export interface ShowSchemaContext {
  personaIds: string[];
  moodNames: string[] | null;
  themeIds: string[] | null;
  minTrackSeconds: number | null;
}

// `=== true` rather than z.boolean(): both paths read these that way, so
// tightening only the schema would make load and save disagree.
const showBool = () => z.unknown().optional().transform((v) => v === true);

// Explicit null reads as "absent" on every OPTIONAL field. zod's `.default()`
// fires only on undefined, and update() re-validates the whole array, so one
// null field on one show would otherwise fail the entire shows/schedule save.
const nullToUndefined = (v: unknown) => (v == null ? undefined : v);

// Trimmed, non-empty, capped, de-duplicated, in first-seen order — the shape
// every one of a show's list filters takes. `key` is what dedup compares, so
// genres can be case-insensitive while ids are exact.
function showStringList(opts: {
  max: number;
  itemMax?: number;
  itemError?: string;
  values?: readonly string[];
  key?: (v: string) => string;
  overflowError: string;
}) {
  let item = z.string({ error: opts.itemError ?? 'must be a string' }).trim();
  if (opts.itemMax) item = item.max(opts.itemMax, opts.itemError ?? `must be ${opts.itemMax} characters or fewer`);
  const base = opts.values
    ? z.enum(opts.values as [string, ...string[]], {
        error: `must be one of: ${(opts.values as readonly string[]).join(', ')}`,
      })
    : item;
  return z.preprocess(
    nullToUndefined,
    z
      .array(base)
      .max(opts.max, opts.overflowError)
      .default([])
      .transform((xs) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const v of xs) {
          if (!v) continue;
          const k = opts.key ? opts.key(v) : v;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(v);
        }
        return out;
      }),
  );
}

// One era-window year bound, shared by showYear and the load path's
// repairEraWindow. null / '' means "open end"; a numeric string is accepted
// (<input type=number>). `validEraYear` is exported for the admin editor (#1599)
// and owns only the integer-and-range test — eraYearOf deliberately does not
// trim, so the editor keeps its own.
const eraYearOf = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
export const validEraYear = (n: number | null): boolean =>
  n == null || (Number.isInteger(n) && n >= SHOW_YEAR_MIN && n <= SHOW_YEAR_MAX);

const showYear = z
  .union([z.null(), z.literal(''), z.number(), z.string()])
  .optional()
  .transform((v) => eraYearOf(v))
  .refine(validEraYear, `must be an integer between ${SHOW_YEAR_MIN} and ${SHOW_YEAR_MAX}`);

const showEra = z
  .object({ fromYear: showYear, toYear: showYear })
  .refine(
    (w) => w.fromYear == null || w.toYear == null || w.fromYear <= w.toYear,
    'fromYear must be less than or equal to toYear',
  );

/**
 * The legacy singular fields #929 replaced with plural lists. BOTH paths migrate
 * them, and the migration runs INSIDE the schema (the preprocess in showSchema)
 * because z.object strips unknown keys: parsing the object directly would drop a
 * legacy `mood` and report success.
 */
export const LEGACY_SHOW_FIELDS = [
  'mood',
  'genre',
  'energy',
  'fromYear',
  'toYear',
  'maxTrackMinutes',
] as const;

/** Fill the plural fields from any legacy singular ones. `genre` splits on
 *  commas — operators crammed several into the one free-text field. */
export function migrateLegacyShowFields(raw: unknown): Record<string, unknown> {
  const rec = { ...(raw as Record<string, unknown>) };
  if (!Array.isArray(rec.moods) && rec.mood != null && rec.mood !== '') rec.moods = [rec.mood];
  if (!Array.isArray(rec.genres) && typeof rec.genre === 'string' && rec.genre.trim()) {
    rec.genres = rec.genre.split(',');
  }
  if (!Array.isArray(rec.energies) && rec.energy != null && rec.energy !== '') {
    rec.energies = [rec.energy];
  }
  if (!Array.isArray(rec.eras) && (rec.fromYear != null || rec.toYear != null)) {
    rec.eras = [{ fromYear: rec.fromYear ?? null, toYear: rec.toYear ?? null }];
  }
  if ((rec.maxTrackSeconds == null || rec.maxTrackSeconds === '') &&
      rec.maxTrackMinutes != null && rec.maxTrackMinutes !== '') {
    rec.maxTrackSeconds = Number(rec.maxTrackMinutes) * 60;
  }
  for (const k of LEGACY_SHOW_FIELDS) delete rec[k];
  return rec;
}

// Array or comma string — the two wire shapes every tag surface takes. Trimmed,
// lowercased, empties dropped, deduped in first-seen order.
function showTagList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean);
}

const showTags = z
  .union([z.null(), z.array(z.unknown()), z.string()])
  .optional()
  .transform((v) => (v == null ? [] : showTagList(v)))
  .check((c) => {
    for (const tag of c.value) {
      if (!SHOW_TAG_RE.test(tag)) {
        c.issues.push({
          code: 'custom',
          input: c.value,
          message: `invalid tag "${tag}" — lowercase slugs (a-z, 0-9, hyphens), max ${SHOW_TAG_MAX} chars`,
        });
      }
    }
    if (new Set(c.value).size > TAGS_PER_SHOW_LIMIT) {
      c.issues.push({
        code: 'custom',
        input: c.value,
        message: `must have at most ${TAGS_PER_SHOW_LIMIT} entries`,
      });
    }
  })
  .transform((toks) => [...new Set(toks)]);

export function showSchema(ctx: ShowSchemaContext) {
  // Migration must run BEFORE the object parse: z.object strips unknown keys, so
  // by the time a field schema sees the value the legacy keys are gone.
  return z.preprocess(
    (raw) => (raw && typeof raw === 'object' ? migrateLegacyShowFields(raw) : raw),
    showObjectSchema(ctx),
  );
}

function showObjectSchema(ctx: ShowSchemaContext) {
  return z
    .object({
      // Optional (a new show has no id yet) and a MALFORMED one is re-minted
      // rather than rejected, unlike a webhook id: a show id is what every
      // weekly-grid slot points at, so rejecting one would refuse the restore.
      id: z
        .string()
        .regex(SHOW_ID_RE, 'id must be 3-32 characters: lowercase letters, digits or underscores')
        .optional()
        .catch(undefined),
      name: z
        .string({ error: 'name must be 1-60 chars' })
        .trim()
        .min(1, 'name must be 1-60 chars')
        .max(SHOW_NAME_MAX, `name must be 1-${SHOW_NAME_MAX} chars`),
      topic: z.preprocess(
        nullToUndefined,
        z
          .string()
          .trim()
          .max(SHOW_TOPIC_MAX, `topic must be 0-${SHOW_TOPIC_MAX} chars`)
          .default(''),
      ),
      personaId: z
        .string({ error: 'Pick a host persona' })
        .refine((v) => ctx.personaIds.includes(v), 'must reference an existing persona'),
      // Host exclusion and dedupe happen in the object transform below.
      guestPersonaIds: z.preprocess(
        nullToUndefined,
        z
          .array(
            z
              .string()
              .refine((v) => ctx.personaIds.includes(v), 'must reference existing personas'),
          )
          .max(GUESTS_PER_SHOW, `must have at most ${GUESTS_PER_SHOW} entries`)
          .default([]),
      ),
      banter: showBool(),
      // Long skill segments may take a genuine music-free break. This is a
      // show-level opt-in: unscheduled/autonomous programming keeps ducking.
      pauseTalk: showBool(),
      programme: showBool(),
      // Free text, resolved against the live skill catalog at air time.
      segmentSkill: z.preprocess(
        nullToUndefined,
        z
          .string()
          .trim()
          .max(SHOW_SEGMENT_SKILL_MAX, `must be ${SHOW_SEGMENT_SKILL_MAX} characters or fewer`)
          .default(''),
      ),
      // Empty means "Any": the autonomous dominantMood chain applies on air.
      moods: showStringList({
        max: SHOW_FILTER_VALUES_MAX,
        values: ctx.moodNames ?? undefined,
        overflowError: `must have at most ${SHOW_FILTER_VALUES_MAX} entries`,
      }),
      // A stale id is DROPPED to '' rather than rejected (#917): update()
      // re-validates the whole array, so throwing would brick every shows and
      // schedule save. The caller reports the drop; this module stays pure.
      themeId: z.preprocess(
        nullToUndefined,
        z
          .string()
          .trim()
          .max(SHOW_THEME_ID_MAX)
          .default('')
          .transform((v) => (!v || !ctx.themeIds || ctx.themeIds.includes(v) ? v : '')),
      ),
      // Resolved fuzzily against the live library at pick time. Case-insensitive
      // dedupe.
      genres: showStringList({
        max: SHOW_FILTER_VALUES_MAX,
        itemMax: SHOW_GENRE_MAX,
        itemError: `genres entries must be ${SHOW_GENRE_MAX} characters or fewer`,
        key: (v) => v.toLowerCase(),
        overflowError: `must have at most ${SHOW_FILTER_VALUES_MAX} entries`,
      }),
      energies: showStringList({
        max: SHOW_FILTER_VALUES_MAX,
        values: SHOW_ENERGY,
        overflowError: `must have at most ${SHOW_FILTER_VALUES_MAX} entries`,
      }),
      // Windows with no bound are dropped; the rest dedupe on the pair.
      eras: z.preprocess(
        nullToUndefined,
        z
          .array(showEra)
          .max(SHOW_FILTER_VALUES_MAX, `must have at most ${SHOW_FILTER_VALUES_MAX} entries`)
          .default([])
          .transform((xs) => {
            const seen = new Set<string>();
            const out: EraWindow[] = [];
            for (const w of xs) {
              if (w.fromYear == null && w.toYear == null) continue;
              const k = `${w.fromYear ?? ''}:${w.toYear ?? ''}`;
              if (seen.has(k)) continue;
              seen.add(k);
              out.push({ fromYear: w.fromYear, toYear: w.toYear });
            }
            return out;
          }),
      ),
      // One value, not a list: wanting both is wanting neither. '' is no
      // constraint, so a show predating the field round-trips unchanged.
      vocals: z
        .union([z.null(), z.literal(''), z.enum(SHOW_VOCALS)])
        .optional()
        .transform((v) => v ?? ''),
      // Opt-in hard filter across every set music constraint. The legacy
      // genre-only `genreStrict` is NOT migrated: this toggle now spans
      // mood/genre/era/energy and would harden filters a show never opted into.
      filtersStrict: showBool(),
      // null = inherit the station default, 0 = unlimited, >0 = this show's cap.
      maxTrackSeconds: z
        .union([z.null(), z.literal(''), z.number(), z.string()])
        .optional()
        .transform((v) => (v == null || v === '' ? null : Number(v)))
        .refine(
          (n) =>
            n == null ||
            (Number.isInteger(n) && n >= 0 && n <= SHOW_MAX_TRACK_SECONDS),
          `must be an integer between 0 and ${SHOW_MAX_TRACK_SECONDS}`,
        )
        // Shows have no crossfade of their own, so the floor is the station's;
        // 0 (inherit/unlimited) stays allowed.
        .refine(
          (n) => n == null || n === 0 || ctx.minTrackSeconds == null || n >= ctx.minTrackSeconds,
          `must be 0 (inherit/unlimited) or at least the station's minimum track length`,
        ),
      // Minimum track length (#1573): null = inherit picker.minTrackLengthSeconds,
      // 0 = no floor, >0 = this show's floor. Unlike the cap this is a SELECTION
      // filter — a short interlude cannot be lengthened on air — and it carries
      // the same crossfade-derived lower bound. 0 always stays allowed.
      minTrackLengthSeconds: z
        .union([z.null(), z.literal(''), z.number(), z.string()])
        .optional()
        .transform((v) => (v == null || v === '' ? null : Number(v)))
        .refine(
          (n) =>
            n == null ||
            (Number.isInteger(n) && n >= 0 && n <= SHOW_MIN_TRACK_LENGTH_MAX),
          `must be an integer between 0 and ${SHOW_MIN_TRACK_LENGTH_MAX}`,
        )
        .refine(
          (n) => n == null || n === 0 || ctx.minTrackSeconds == null || n >= ctx.minTrackSeconds,
          `must be 0 (inherit/no floor) or at least the station's minimum track length`,
        ),
      // Show-boundary fade (#1574). TRI-STATE like maxTrackSeconds: null =
      // inherit. A plain showBool() would read an untouched show as an explicit
      // false and opt it out of a station default just turned on.
      fadeAtShowEnd: z
        .union([z.null(), z.literal(''), z.boolean()])
        .optional()
        .transform((v) => (v == null || v === '' ? null : v)),
      // Shape-checked only: ids resolve against live Navidrome at pick time.
      playlistIds: showStringList({
        max: PLAYLISTS_PER_SHOW,
        overflowError: `must have at most ${PLAYLISTS_PER_SHOW} entries`,
      }),
      playlistStrict: showBool(),
      // Full rotation (#1612): every track in the anchor playlist airs once
      // before any repeats, the no-repeat window becoming the resolved
      // playlist's size (recomputed per pick). A NO-OP without `playlistStrict`
      // rather than a validation error, so a half-configured show still saves.
      // The window is counted AFTER strict locks and excluded playlists, in
      // music/show-recency.ts.
      playlistExhaust: showBool(),
      excludedPlaylistIds: showStringList({
        max: EXCLUDED_PLAYLISTS_PER_SHOW,
        overflowError: `must have at most ${EXCLUDED_PLAYLISTS_PER_SHOW} entries`,
      }),
      // Organisation only, declared LAST so persisted key order is unchanged.
      // Unlike every other list here a bad entry is REFUSED rather than dropped:
      // a tag is typed by hand and must not vanish on save. The load twin
      // (repairShowTags) drops instead.
      tags: showTags,
    })
    // Needs two fields at once, so it cannot live on guestPersonaIds.
    .check((c) => {
      if (c.value.guestPersonaIds.includes(c.value.personaId)) {
        c.issues.push({
          code: 'custom',
          input: c.value.guestPersonaIds,
          path: ['guestPersonaIds'],
          message: "must not include the show's host persona",
        });
      }
    })
    .transform((s) => ({
      ...s,
      guestPersonaIds: [...new Set(s.guestPersonaIds)].filter((id) => id !== s.personaId),
    }));
}

export type ShowParsed = z.output<ReturnType<typeof showSchema>>;
export type Show = ShowParsed & { id: string };

export function showsSchema(ctx: ShowSchemaContext) {
  // Explicit array-level error, phrased WITHOUT the key because both callers
  // root this schema at 'shows'.
  return z
    .array(showSchema(ctx), { error: 'must be an array' })
    .max(SHOWS_LIMIT, `must be at most ${SHOWS_LIMIT} entries`);
}

// POST /shows submits ONE show under a `show` key and merges it server-side.
export function showPostSchema(ctx: ShowSchemaContext) {
  return z.object({ show: showSchema(ctx) });
}

// Lenient per-field repairs (the LOAD path). normalizeShows repairs a stored
// show field-by-field BEFORE running the schema, so a stale value costs the show
// that value, not the show. They live here, beside the rules they repair
// against: a repair that drifts from the schema drops the row at boot.

/** One era window, repaired: numeric-string years accepted, out-of-range or
 *  backwards windows dropped as null rather than failing the show. */
export function repairEraWindow(raw: unknown): EraWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as { fromYear?: unknown; toYear?: unknown };
  const fromYear = eraYearOf(rec.fromYear);
  const toYear = eraYearOf(rec.toYear);
  if (!validEraYear(fromYear) || !validEraYear(toYear)) return null;
  if (fromYear == null && toYear == null) return null;
  if (fromYear != null && toYear != null && fromYear > toYear) return null;
  return { fromYear, toYear };
}

// The lenient twin of showStringList: where the schema REJECTS a non-string or
// over-cap entry, this drops or truncates.
export function repairShowStringList(
  raw: unknown,
  opts: { max: number; itemMax?: number; values?: readonly string[]; key?: (v: string) => string },
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = opts.itemMax ? item.trim().slice(0, opts.itemMax) : item.trim();
    if (!v) continue;
    if (opts.values && !opts.values.includes(v)) continue;
    const k = opts.key ? opts.key(v) : v;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= opts.max) break;
  }
  return out;
}

/** Tags, repaired. The cap applies AFTER the validity filter so a list padded
 *  with junk still yields the operator's real tags. */
export function repairShowTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase();
    if (!SHOW_TAG_RE.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= TAGS_PER_SHOW_LIMIT) break;
  }
  return out;
}

/**
 * Every per-field repair the load path applies before parsing. `undefined` lets
 * the schema's own default apply; each repair lands on a value the strict path
 * accepts, and the schema is still run on the result.
 *
 * `personaIds: null` means this caller cannot check roster membership, so guests
 * are kept. maxTrackSeconds and minTrackLengthSeconds are deliberately NOT
 * repaired here — settings/defaults.ts owns their clamps.
 */
export function repairShowForLoad(
  raw: Record<string, unknown>,
  personaIds: string[] | null,
): Record<string, unknown> {
  const host = typeof raw.personaId === 'string' ? raw.personaId : '';
  return {
    ...raw,
    id: typeof raw.id === 'string' && SHOW_ID_RE.test(raw.id) ? raw.id : undefined,
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, SHOW_NAME_MAX) : undefined,
    topic: typeof raw.topic === 'string' ? raw.topic.slice(0, SHOW_TOPIC_MAX) : undefined,
    segmentSkill: typeof raw.segmentSkill === 'string'
      ? raw.segmentSkill.trim().slice(0, SHOW_SEGMENT_SKILL_MAX)
      : undefined,
    themeId: typeof raw.themeId === 'string'
      ? raw.themeId.trim().slice(0, SHOW_THEME_ID_MAX)
      : undefined,
    // Anything unrecognised reads as no constraint: a steering field that stops
    // applying beats a show that stops playing music.
    vocals: typeof raw.vocals === 'string' && (SHOW_VOCALS as readonly string[]).includes(raw.vocals)
      ? raw.vocals
      : undefined,
    // Not filtered against a vocabulary here, for the same reason the load
    // context carries moodNames: null — the mood cache does not exist yet.
    moods: repairShowStringList(raw.moods, { max: SHOW_FILTER_VALUES_MAX }),
    genres: repairShowStringList(raw.genres, {
      max: SHOW_FILTER_VALUES_MAX,
      itemMax: SHOW_GENRE_MAX,
      key: (v) => v.toLowerCase(),
    }),
    energies: repairShowStringList(raw.energies, {
      max: SHOW_FILTER_VALUES_MAX,
      values: SHOW_ENERGY,
    }),
    eras: Array.isArray(raw.eras)
      ? raw.eras
          .map(repairEraWindow)
          .filter((w): w is EraWindow => w != null)
          .slice(0, SHOW_FILTER_VALUES_MAX)
      : undefined,
    guestPersonaIds: Array.isArray(raw.guestPersonaIds)
      ? raw.guestPersonaIds
          .filter((g): g is string =>
            typeof g === 'string' && g !== host && (personaIds == null || personaIds.includes(g)))
          .slice(0, GUESTS_PER_SHOW)
      : undefined,
    // Lenient twin of the strict `tags` field: an invalid tag is DROPPED rather
    // than failing the show. Non-array reads as absent (schema's [] default).
    tags: repairShowTags(raw.tags),
    playlistIds: repairShowStringList(raw.playlistIds, { max: PLAYLISTS_PER_SHOW }),
    excludedPlaylistIds: repairShowStringList(raw.excludedPlaylistIds, {
      max: EXCLUDED_PLAYLISTS_PER_SHOW,
    }),
  };
}
