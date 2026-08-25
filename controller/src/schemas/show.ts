// Shared show schema — the single source of truth for a show's shape, executed
// on BOTH sides. The controller runs it in settings.validate.validateShowsStrict
// (the update() chokepoint), in settings.normalize.normalizeShows (the lenient
// load path) and in the POST /shows route middleware; the browser runs the
// mirrored copy (web/lib/schemas.generated.ts).
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// That includes OTHER schema modules — the mirror is one flat concatenation, so
// gen-schemas.ts rejects every specifier but 'zod' and each module has to stand
// alone. SHOW_ID_RE is therefore declared here and re-exported by
// settings/vocab.ts as ID_RE rather than living in a shared module.
//
// WHY A FACTORY. Unlike webhooks and stations, a show cannot be validated
// against itself: `personaId` must name a real persona, `moods` a live mood,
// `themeId` an installed theme, and `maxTrackSeconds` clears a crossfade-derived
// floor. Those four travel as ONE ShowSchemaContext value rather than separate
// arguments — the same "one scope value, never unpacked" rule PickerScope
// follows. Both sides can build it; the admin panel already fetches personas,
// moods, themes and the station settings.
//
// Rules that are NOT pure functions of the submitted value — id minting and
// cross-row de-duplication — live in show-server.ts, which is NOT mirrored.
import { z } from 'zod';

// Entity id: shows, personas and skills all share this pattern. Homed here
// because show is the first of the three to convert and a mirrored module
// cannot import a shared one (see the header). settings/vocab.ts re-exports it
// as ID_RE; whoever converts personas should decide its permanent home.
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

// Freeform organisation tags (`tags: ["late-night", "weekend"]`) — operator
// vocabulary for filtering and grouping the admin show list, the twin of
// skill.ts's SKILL_TAG_RE. Declared here rather than imported because the
// mirror is one flat concatenation and a schema module may import only zod
// (see the header) — the same reason SHOW_ID_RE and PERSONA_ID_RE are three
// copies of one pattern.
export const SHOW_TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const SHOW_TAG_MAX = 24;
export const TAGS_PER_SHOW_LIMIT = 8;
export const SHOW_YEAR_MIN = 1900;
export const SHOW_YEAR_MAX = 2100;
// Also the STATION-wide cap's ceiling — settings/defaults.ts BOUNDS reads it
// from here, because the strict show validator has always bounds-checked a
// show's override against the station figure and two copies would drift.
export const SHOW_MAX_TRACK_SECONDS = 36000;

export const SHOW_ENERGY = ['low', 'medium', 'high'] as const;
export const SHOW_VOCALS = ['instrumental', 'vocal'] as const;

export type EraWindow = { fromYear: number | null; toYear: number | null };

/**
 * Everything a show can only be judged against from outside itself.
 *
 * Three fields are NULLABLE, and null always means the same thing: **this
 * caller cannot check that rule**, so leave the value alone. That is how the
 * lenient load path and the strict save path share one schema without either
 * restating a rule — the difference between them becomes CONTEXT rather than a
 * second implementation:
 *
 *   - `moodNames: null` — load runs before the mood cache is built, and moods
 *     are operator-editable, so filtering against the seed defaults there would
 *     strip an operator's own moods. A stale mood just matches nothing on air.
 *   - `themeIds: null` — load has no theme registry to consult. A stale id is
 *     harmless: GET /themes falls back to the station default at serve time.
 *   - `minTrackSeconds: null` — the crossfade-derived floor. Load clamps to the
 *     hard bounds instead of enforcing it.
 *
 * `personaIds` is NOT nullable: a show whose host does not exist has no owner
 * on either path. Strict throws, lenient drops the row — same rule, different
 * consequence, which is exactly the split that is allowed.
 */
export interface ShowSchemaContext {
  personaIds: string[];
  moodNames: string[] | null;
  themeIds: string[] | null;
  minTrackSeconds: number | null;
}

// Booleans are compared to `true` rather than typed as z.boolean(), which is
// deliberate and load-bearing: BOTH the strict and the lenient path have always
// read these as `item.banter === true`, so they already agree, and tightening
// only the schema would make load and save disagree about a value neither
// considers worth failing a show over. A string 'yes' reads as off, as it
// always has.
const showBool = () => z.unknown().optional().transform((v) => v === true);

// Explicit null reads as "absent" on every OPTIONAL field. The pre-schema
// validator accepted null everywhere it accepted an omission (`String(x ?? '')`,
// `!= null` guards), and clients or serializers that write null for empty
// fields relied on that. zod's `.default()` fires only on undefined, so without
// this preprocess a `{topic: null}` that has always saved cleanly would 400 —
// and because update() re-validates the whole array, one null field on one show
// would fail the entire shows/schedule save.
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

// One era-window year bound, shared by the schema's own showYear pipeline and
// the load path's repairEraWindow (below) so the two can never disagree about
// what a valid year is. null / '' means "open end". A numeric string is
// accepted because that is what an <input type="number"> posts.
const eraYearOf = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
const validEraYear = (n: number | null): boolean =>
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
 * The legacy singular fields #929 replaced with plural lists.
 *
 * BOTH paths migrate them. The pre-schema strict validator always accepted a
 * legacy `mood` from an older client or a pre-#929 backup and folded it into
 * the plural list ("a legacy singular mood from an older client still
 * validates" was its own comment), so a refusal here would turn a working
 * backup restore through settings.update() into a hard failure. Migration runs
 * INSIDE the schema (the preprocess in showSchema below) rather than at any
 * call site, because z.object strips unknown keys: a route that parses the
 * object directly would otherwise silently drop a legacy `mood` and report
 * success — the exact silent loss #929's migration exists to prevent.
 */
export const LEGACY_SHOW_FIELDS = [
  'mood',
  'genre',
  'energy',
  'fromYear',
  'toYear',
  'maxTrackMinutes',
] as const;

/**
 * Fill the plural fields from any legacy singular ones.
 *
 * `genre` splits on commas because operators crammed multiple genres into the
 * one free-text field ("funk, soul, jazz-funk"), which never resolved against
 * the library as a single tag.
 */
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

// Accepts the array the editor sends AND a comma string, the two wire shapes
// every other tag surface in the codebase has always taken. Tokens are
// trimmed + lowercased, empties dropped, de-duplicated in first-seen order.
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
  // Migration must run BEFORE the object parse — z.object strips unknown keys,
  // so by the time any .check() or field schema sees the value the legacy keys
  // are already gone. Running it here rather than at call sites is what makes
  // every caller — update(), POST /shows, the lenient load, the browser — give
  // the same answer for the same payload. A migrated value is then validated by
  // the same field schemas as a native one, so a legacy `energy: 'bogus'` still
  // fails exactly like `energies: ['bogus']` would.
  return z.preprocess(
    (raw) => (raw && typeof raw === 'object' ? migrateLegacyShowFields(raw) : raw),
    showObjectSchema(ctx),
  );
}

function showObjectSchema(ctx: ShowSchemaContext) {
  return z
    .object({
      // Optional because a brand-new show has no id yet — the server mints one.
      //
      // A MALFORMED id is re-minted rather than rejected (.catch → undefined,
      // then show-server.resolveShowIds mints), which is what both paths have
      // always done and is deliberately unlike the webhook schema. A webhook id
      // only resolves that row's stored secret, so rejecting a bad one costs
      // nothing; a SHOW id is what every slot in the weekly schedule grid points
      // at, so the same tightening would turn one malformed id in a restored
      // backup into a refusal to restore the station at all.
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
      // Host exclusion and de-duplication happen in the object transform below,
      // where the host id is in scope.
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
      programme: showBool(),
      // Free text, resolved against the live skill catalog at air time — a
      // stale kind degrades to the producer's choice rather than blocking a save.
      segmentSkill: z.preprocess(
        nullToUndefined,
        z
          .string()
          .trim()
          .max(SHOW_SEGMENT_SKILL_MAX, `must be ${SHOW_SEGMENT_SKILL_MAX} characters or fewer`)
          .default(''),
      ),
      // Empty means "Any": the show pins no mood and the autonomous
      // dominantMood chain (festival > weather > time) applies on air.
      moods: showStringList({
        max: SHOW_FILTER_VALUES_MAX,
        values: ctx.moodNames ?? undefined,
        overflowError: `must have at most ${SHOW_FILTER_VALUES_MAX} entries`,
      }),
      // A stale id is DROPPED to '' rather than rejected — the tolerance #917's
      // theme.active twin established. Throwing here bricked EVERY shows and
      // schedule save, and every full restore, for any install still carrying
      // one retired palette id on one show, because update() re-validates the
      // whole array. Self-heals on the next save. The caller reports the drop
      // (this module stays side-effect free, so no console.warn here).
      themeId: z.preprocess(
        nullToUndefined,
        z
          .string()
          .trim()
          .max(SHOW_THEME_ID_MAX)
          .default('')
          .transform((v) => (!v || !ctx.themeIds || ctx.themeIds.includes(v) ? v : '')),
      ),
      // Free text resolved fuzzily against the live library at pick time, so
      // never checked against Subsonic here. Dedup is case-insensitive.
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
      // Windows with no bound at all are dropped; the rest de-duplicate on the
      // pair.
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
      // One value, not a list — instrumental and vocal are mutually exclusive
      // and wanting both is wanting neither. '' is no constraint, so a show
      // predating the field round-trips unchanged.
      vocals: z
        .union([z.null(), z.literal(''), z.enum(SHOW_VOCALS)])
        .optional()
        .transform((v) => v ?? ''),
      // Opt-in hard filter across every set music constraint. The legacy
      // genre-only `genreStrict` is deliberately NOT carried over: the toggle
      // now spans mood/genre/era/energy, so migrating it would harden filters
      // an old show never opted into.
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
        // Shows have no crossfade of their own, so the floor is the station's.
        // 0 (inherit/unlimited) always stays allowed.
        .refine(
          (n) => n == null || n === 0 || ctx.minTrackSeconds == null || n >= ctx.minTrackSeconds,
          `must be 0 (inherit/unlimited) or at least the station's minimum track length`,
        ),
      // Shape-checked only: ids resolve against the live Navidrome at pick
      // time, so a stale one contributes nothing rather than failing a save.
      playlistIds: showStringList({
        max: PLAYLISTS_PER_SHOW,
        overflowError: `must have at most ${PLAYLISTS_PER_SHOW} entries`,
      }),
      playlistStrict: showBool(),
      excludedPlaylistIds: showStringList({
        max: EXCLUDED_PLAYLISTS_PER_SHOW,
        overflowError: `must have at most ${EXCLUDED_PLAYLISTS_PER_SHOW} entries`,
      }),
      // Organisation only — tags steer nothing on air. Declared LAST so the
      // persisted key order of every pre-existing field is unchanged, and
      // defaulted to [] so a show written before the field round-trips byte
      // identically apart from the new empty list.
      //
      // Unlike every other list here a bad entry is REFUSED rather than
      // dropped: a tag is typed by hand in the editor, and a tag that silently
      // vanishes on save is the failure the skill conversion called out. The
      // lenient load twin (repairShowTags) drops instead, because a hand-edited
      // settings.json should cost the show a filter chip, not the show.
      tags: showTags,
    })
    // Needs two fields at once, so it cannot live on guestPersonaIds itself.
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
  // The array-level error is explicit so a non-array never reaches an operator
  // as zod's own 'Invalid input: expected array, received number'. Phrased
  // WITHOUT the key, like every other message here, because both callers root
  // this schema at 'shows'.
  return z
    .array(showSchema(ctx), { error: 'must be an array' })
    .max(SHOWS_LIMIT, `must be at most ${SHOWS_LIMIT} entries`);
}

// POST /shows submits ONE show under a `show` key and merges it server-side.
export function showPostSchema(ctx: ShowSchemaContext) {
  return z.object({ show: showSchema(ctx) });
}

// ── Lenient per-field repairs (the LOAD path) ────────────────────────────────
//
// settings/normalize.ts's normalizeShows repairs a stored show field-by-field
// BEFORE running the schema, so a stale mood or a mistyped list entry costs the
// show that one value, not the show. The repairs live HERE, beside the rules
// they repair against, because a repair restated at the call site is a repair
// that can drift from the schema — and the failure mode of that drift is the
// worst one available: the lenient parse fails, `continue` drops the row, and a
// working show silently vanishes on the next boot.

/**
 * One era window, repaired: numeric-string years accepted (same eraYearOf the
 * schema's own showYear runs), out-of-range or backwards windows dropped as
 * null rather than failing the show.
 */
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

// Trimmed strings only, deduped in first-seen order, capped — the lenient twin
// of showStringList: where the schema REJECTS (a non-string entry, an
// over-cap list), this drops or truncates instead.
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

/**
 * Tags, repaired: lowercased, invalid entries dropped, de-duplicated, capped.
 *
 * The cap is applied AFTER the validity filter, not before, so a stored list
 * padded with junk still yields the operator's real tags rather than spending
 * the budget on entries that were never going to survive.
 */
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
 * Every per-field repair the load path applies before parsing, in one place.
 *
 * `undefined` lets the schema's own default apply. Each repair lands on a value
 * the strict path would have accepted, so load and save still agree about what
 * a valid show is — the schema itself is still run on the result.
 *
 * `personaIds: null` mirrors the ShowSchemaContext convention: this caller
 * cannot check roster membership, so guest entries are kept. The load path
 * passes the real roster and dangling guests (and the host itself) are dropped
 * so the show survives with whatever roster is still real.
 *
 * maxTrackSeconds is deliberately NOT repaired here: its clamp bounds are owned
 * by settings/defaults.ts (coerceMaxTrackSeconds), which already reads its
 * ceiling from this module's SHOW_MAX_TRACK_SECONDS.
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
    // Anything unrecognised reads as no constraint — a steering field that
    // silently stops applying is a far smaller failure than a show that stops
    // playing music.
    vocals: typeof raw.vocals === 'string' && (SHOW_VOCALS as readonly string[]).includes(raw.vocals)
      ? raw.vocals
      : undefined,
    // A stale mood costs the show that one filter, not the show. Moods are NOT
    // filtered against a vocabulary here for the same reason the load context
    // carries moodNames: null — the mood cache doesn't exist yet.
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
    // Lenient twin of the strict `tags` field: an invalid tag is DROPPED here
    // rather than failing the show, the same posture skill.ts's
    // normalizeSkillTags takes against a hand-edited SKILL.md. Non-array reads
    // as absent so the schema's [] default applies.
    tags: repairShowTags(raw.tags),
    playlistIds: repairShowStringList(raw.playlistIds, { max: PLAYLISTS_PER_SHOW }),
    excludedPlaylistIds: repairShowStringList(raw.excludedPlaylistIds, {
      max: EXCLUDED_PLAYLISTS_PER_SHOW,
    }),
  };
}
