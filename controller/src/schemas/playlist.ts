// Shared playlist schemas — the request bodies of the /playlists routes and
// the recipe shape behind sync-enabled playlists, executed on BOTH sides. The
// controller runs them at the route boundary (middleware/validate.ts) and in
// the recipe store's lenient read; the browser runs the mirrored copy
// (web/lib/schemas.generated.ts) for the builder's Generate/Save gates.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle. Enforced by controller/eslint.config.mjs and gen-schemas.ts.
//
// THE STRICT/LENIENT SPLIT LIVES INSIDE THIS MODULE. Playlists have no
// settings.update() chokepoint and no validate*Strict/normalize* pair, so the
// two postures are expressed here directly: **the knobs never throw, the
// request wrappers do.** A knob is a preference the engine has always clamped
// (targetCount) or ignored (a garbage mood), so failing a body over one would
// be a regression for anyone driving the API — and the same knob/recipe shape
// is run by the recipe-store read, where a throw wedges sync on boot. What
// rejects is the operator's input being WRONG: a save with no name, an append
// with no ids, a patch that changes nothing, a generate with nothing to
// generate from.
import { z } from 'zod';

export const playlistGenerationResultSchema = z.object({
  tracks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    artist: z.string(),
    album: z.string(),
    durationSec: z.number(),
    year: z.number().nullable(),
    genre: z.string().nullable(),
    energy: z.string().nullable(),
    moods: z.array(z.string()),
    instrumental: z.boolean().nullable(),
  })),
  name: z.string().optional(),
  description: z.string().optional(),
  degraded: z.boolean(),
  reasons: z.array(z.string()),
  poolSize: z.number(),
  usedFallback: z.boolean(),
});

export const playlistGenerationStartSchema = z.object({ jobId: z.string().min(1) });

export const playlistGenerationPollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('error'), error: z.string().optional() }),
  z.object({ status: z.literal('done'), result: playlistGenerationResultSchema }),
]);

export type PlaylistGenerationResult = z.infer<typeof playlistGenerationResultSchema>;

// The one cap a playlist name gets. It exists so an API caller can't store a
// name the library list then has to render; the save modal's input runs the
// same rule as an inline error rather than a silent maxLength truncation.
export const PLAYLIST_NAME_MAX = 120;

// Explicit null reads as absent — the hand-rolled readers these replace used
// `typeof v === 'string' ? v : undefined`, so null has always meant "not set".
// (Named per-module: the mirror is one flat file.)
const playlistText = z.unknown().optional().transform((v) => (typeof v === 'string' ? v : undefined));

// A trimmed id list. NEVER throws: a non-array reads as empty (the old
// parseIds behaviour), non-string entries are dropped. Deliberately UNCAPPED —
// the builder's deck can hold a playlist LOADED from Navidrome, and refusing
// to re-save what the server already holds would be a new failure the
// hand-rolled reader never had.
const playlistIdList = z.unknown().optional().transform((v): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
    .map((x) => x.trim());
});

// Knobs and sources pass through as-is (object → itself, anything else → {}).
// Two deliberate non-rules:
//   - No `.default()` on targetCount (or any knob): playlist-gen reads
//     `targetCount ?? (targetMinutes ? … : DEFAULT)`, so a schema default here
//     would silently retire targetMinutes.
//   - `energies` is NOT validated against SHOW_ENERGY: a mirrored module may
//     not import another mirrored module, and re-declaring the tuple would be
//     the exact drift this conversion removes — so the values stay free text
//     here (the engine ignores unknown ones) and the WEB reads SHOW_ENERGY out
//     of the flat mirror for its chips.
const playlistLooseRecord = z.unknown().optional().transform((v): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}));

// Non-object bodies read as {} so the wrappers' own refusals (not a type
// error) answer an empty POST.
const playlistBody = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * "Is there anything to generate FROM?" — the ONE intent rule, shared by the
 * generate schema's refinement below AND the builder's Generate button (which
 * needs the answer before a request exists, so a refinement alone could not
 * retire the hand copy). The two copies it replaces had already diverged: the
 * route counted `knobs.eras?.length`, so an era window with both ends open was
 * intent server-side and not client-side. The unified rule: a window counts
 * only when it carries at least one real bound.
 */
export function playlistHasIntent(input: {
  prompt?: unknown;
  seedTrackIds?: unknown;
  seedArtist?: unknown;
  knobs?: unknown;
  sources?: unknown;
}): boolean {
  const knobs = (input?.knobs && typeof input.knobs === 'object'
    ? input.knobs
    : {}) as Record<string, unknown>;
  const sources = (input?.sources && typeof input.sources === 'object'
    ? input.sources
    : {}) as Record<string, unknown>;
  const filled = (v: unknown) => Array.isArray(v) && v.length > 0;
  const erasWithBounds = Array.isArray(knobs.eras)
    && knobs.eras.some((w) => {
      const win = w as { fromYear?: unknown; toYear?: unknown } | null;
      return win && typeof win === 'object' && (win.fromYear != null || win.toYear != null);
    });
  return Boolean(
    (typeof input?.prompt === 'string' && input.prompt.trim())
    || filled(input?.seedTrackIds)
    || (typeof input?.seedArtist === 'string' && input.seedArtist.trim())
    || sources.recentlyAdded
    || filled(knobs.moods)
    || filled(knobs.genres)
    || filled(knobs.artists)
    || filled(knobs.energies)
    || erasWithBounds
    || knobs.minBpm
    || knobs.maxBpm
    || knobs.instrumentalOnly,
  );
}

// The recipe behind a sync-enabled playlist — the same shape /generate takes,
// minus excludeTrackIds. Every field is lenient (see the header): this schema
// is also what the recipe-store read runs, and it must never throw.
export const playlistRecipeSchema = z.preprocess(
  playlistBody,
  z.object({
    prompt: playlistText,
    seedTrackIds: playlistIdList,
    seedArtist: playlistText,
    knobs: playlistLooseRecord,
    sources: playlistLooseRecord,
  }),
);
export type PlaylistRecipeParsed = z.output<typeof playlistRecipeSchema>;

// POST /playlists/generate and .../generate/jobs — an unsaved candidate list.
export const playlistGenerateSchema = z.preprocess(
  playlistBody,
  z
    .object({
      prompt: playlistText,
      seedTrackIds: playlistIdList,
      seedArtist: playlistText,
      knobs: playlistLooseRecord,
      sources: playlistLooseRecord,
      excludeTrackIds: playlistIdList,
    })
    .refine(playlistHasIntent, 'give a prompt, seeds, a source, or at least one knob to generate from'),
);

// POST /playlists — create, or overwrite when playlistId is present.
export const playlistSaveSchema = z.preprocess(
  playlistBody,
  z.object({
    name: z
      .string({ error: 'name is required' })
      .trim()
      .min(1, 'name is required')
      .max(PLAYLIST_NAME_MAX, `name must be 1-${PLAYLIST_NAME_MAX} chars`),
    songIds: playlistIdList,
    playlistId: z.unknown().optional().transform((v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)),
    keepInSync: z.unknown().optional().transform((v) => v === true),
    recipe: playlistRecipeSchema,
  }),
);

// POST /playlists/:id/tracks — append.
export const playlistAppendSchema = z.preprocess(
  playlistBody,
  z.object({
    songIds: playlistIdList.refine((ids) => ids.length > 0, 'songIds is required'),
  }),
);

// PATCH /playlists/:id — rename / visibility. A patch that changes nothing is
// the operator's input being wrong, so it rejects.
//
// A non-string `name` reads as ABSENT rather than as a type error, which is
// what the hand-rolled reader did and is deliberately preserved: `{name: 42,
// public: true}` flips the visibility and drops the rename silently. Worth
// knowing before relying on the opposite — the only caller is the admin row
// editor, which cannot produce a non-string, so tightening it would buy a rule
// nothing can trip while changing an API answer somebody may depend on.
export const playlistPatchSchema = z.preprocess(
  playlistBody,
  z
    .object({
      name: z
        .unknown()
        .optional()
        .transform((v) => (typeof v === 'string' ? v.trim() : undefined))
        .refine((v) => v === undefined || v.length > 0, 'name cannot be empty')
        .refine(
          (v) => v === undefined || v.length <= PLAYLIST_NAME_MAX,
          `name must be 1-${PLAYLIST_NAME_MAX} chars`,
        ),
      public: z.unknown().optional().transform((v) => (typeof v === 'boolean' ? v : undefined)),
    })
    .check((c) => {
      if (c.value.name === undefined && c.value.public === undefined) {
        c.issues.push({
          code: 'custom',
          input: c.value,
          message: 'nothing to update — send name and/or public',
        });
      }
    }),
);

// DELETE /playlists/:id/tracks — remove by position.
export const playlistRemoveTracksSchema = z.preprocess(
  playlistBody,
  z.object({
    indexes: z
      .unknown()
      .optional()
      .transform((v): number[] =>
        (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0) : []))
      .refine((xs) => xs.length > 0, 'indexes is required'),
  }),
);

/**
 * Lenient repair for one stored recipe-store row (state/playlist-recipes.json,
 * read at boot and by every sync). A row is DROPPED when it has no identity
 * (no playlistId) or no recipe at all; every other field is REPAIRED — the
 * store read used to keep any row carrying a string playlistId and nothing
 * else, so a hand-edited entry missing its `recipe` reached syncRecipe and
 * threw on `entry.recipe.prompt`, turning "Sync now" into a 500.
 *
 * WHY A MISSING RECIPE DROPS RATHER THAN REPAIRS. An empty recipe is not a
 * neutral value for this shape: buildCandidatePool reads an absent knob as NO
 * FILTER, not as "match nothing", so `{seedTrackIds: [], knobs: {}, sources:
 * {}}` is a recipe that matches the whole library. Repairing to it would turn
 * a loud 500 into a quiet wrong result — syncRecipe would append perSyncCap
 * arbitrary tracks added since createdAt, answer `{added: 25}` as success, and
 * recordSync would persist the invented recipe. That also runs unattended via
 * syncAllAfterTag() after every tagging pass. Dropping keeps the never-throws
 * property without inventing intent the operator never expressed.
 */
export function normalizeRecipeRow(raw: unknown): {
  playlistId: string;
  name: string;
  recipe: PlaylistRecipeParsed;
  perSyncCap: number;
  createdAt: string;
  lastSyncedAt: string | null;
  lastResult: { added: number; at: string } | null;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.playlistId !== 'string' || !r.playlistId.trim()) return null;
  if (!r.recipe || typeof r.recipe !== 'object' || Array.isArray(r.recipe)) return null;
  const lastResult = r.lastResult && typeof r.lastResult === 'object'
    && Number.isInteger((r.lastResult as Record<string, unknown>).added)
    && typeof (r.lastResult as Record<string, unknown>).at === 'string'
    ? { added: (r.lastResult as { added: number }).added, at: (r.lastResult as { at: string }).at }
    : null;
  return {
    playlistId: r.playlistId,
    name: typeof r.name === 'string' ? r.name : '',
    // Never throws: every field of the recipe schema is a lenient coercer.
    recipe: playlistRecipeSchema.parse(r.recipe),
    perSyncCap: Number.isInteger(r.perSyncCap) && (r.perSyncCap as number) > 0 ? (r.perSyncCap as number) : 25,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    lastSyncedAt: typeof r.lastSyncedAt === 'string' ? r.lastSyncedAt : null,
    lastResult,
  };
}
