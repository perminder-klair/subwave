// Shared library-maintenance schemas — POST /library/manual-tag,
// /library/original-year and /library/scenes/merge, plus the referenced-by
// warning a merge response carries (#1593).
//
// A FACTORY because moods are operator-editable: `moodNames: null` means "this
// caller cannot check that rule", so the browser can pre-flight the shape while
// the route enforces membership.
import { z } from 'zod';

/** At most three moods per track — the tagger's own ceiling. */
export const MANUAL_TAG_MOODS_MAX = 3;

export const MANUAL_TAG_ENERGIES = ['low', 'medium', 'high'] as const;

export interface ManualTagContext {
  /** The live mood vocabulary, or null when the caller cannot know it. */
  moodNames: string[] | null;
}

export const MANUAL_TAG_SHAPE_ONLY: ManualTagContext = { moodNames: null };

export function manualTagSchema(ctx: ManualTagContext) {
  return z.object({
    // A blank string is refused too, with the same message.
    id: z.unknown().optional().transform((raw, c) => {
      if (typeof raw !== 'string' || !raw) {
        c.addIssue({ code: 'custom', message: 'id is required' });
        return z.NEVER;
      }
      return raw;
    }),
    // An EMPTY array clears the track's tags, so this is required-but-may-be-
    // empty, never defaulted: a missing key and an explicit [] differ.
    moods: z
      .array(z.unknown(), { error: 'moods must be an array of strings' })
      .transform((items, c) => {
        if (items.some((m) => typeof m !== 'string')) {
          c.addIssue({ code: 'custom', message: 'moods must be an array of strings' });
          return z.NEVER;
        }
        const values = items as string[];
        if (values.length > MANUAL_TAG_MOODS_MAX) {
          c.addIssue({
            code: 'custom',
            message: `at most ${MANUAL_TAG_MOODS_MAX} moods per track`,
          });
          return z.NEVER;
        }
        if (ctx.moodNames) {
          const unknown = values.filter((m) => !ctx.moodNames!.includes(m));
          if (unknown.length) {
            c.addIssue({ code: 'custom', message: `unknown mood(s): ${unknown.join(', ')}` });
            return z.NEVER;
          }
        }
        return values;
      }),
    // null is the explicit "no energy"; an omission lands on null too.
    energy: z.preprocess(
      (v) => (v === undefined ? null : v),
      z
        .enum(MANUAL_TAG_ENERGIES, {
          error: "energy must be 'low', 'medium', 'high' or null",
        })
        .nullable(),
    ),
    // `=== true`, so anything else reads as off.
    applyToAlbum: z.unknown().optional().transform((v) => v === true),
  });
}

// POST /library/original-year — the operator's manual era override (#1418), the
// escape hatch for reissue anthologies the automatic pipeline gets wrong.

/** Floor for a plausible recording year. Mirrors musicbrainz.ts MIN_YEAR. */
export const ORIGINAL_YEAR_MIN = 1900;

export function originalYearSchema() {
  // Per request, not at module load: a schema frozen at boot starts refusing
  // next January.
  const max = new Date().getUTCFullYear() + 1;
  return z.object({
    // Same wording and blank-string refusal as manualTagSchema: one editor
    // posts to both routes.
    id: z.unknown().optional().transform((raw, c) => {
      if (typeof raw !== 'string' || !raw) {
        c.addIssue({ code: 'custom', message: 'id is required' });
        return z.NEVER;
      }
      return raw;
    }),
    // null CLEARS the override; a missing key is a malformed request, not
    // "clear it". Numeric strings accepted (<input>), but a non-integer or
    // out-of-window year is refused rather than rounded.
    originalYear: z.unknown().transform((raw, c) => {
      if (raw === null) return null;
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isInteger(n)) {
        c.addIssue({ code: 'custom', message: 'originalYear must be a whole year or null' });
        return z.NEVER;
      }
      if (n < ORIGINAL_YEAR_MIN || n > max) {
        c.addIssue({
          code: 'custom',
          message: `originalYear must be between ${ORIGINAL_YEAR_MIN} and ${max}, or null`,
        });
        return z.NEVER;
      }
      return n;
    }),
    // `=== true`, matching manualTagSchema.
    applyToAlbum: z.unknown().optional().transform((v) => v === true),
  });
}

// POST /library/scenes/merge — scene-vocabulary consolidation (#1577). "Scene"
// is the operator word for a genre tag. A wrong `to` is not recoverable from the
// UI: rows are rewritten in place and the retired spellings are gone until the
// next Navidrome walk.

/** How many values one merge may retire at once; bounds the SQL parameter list. */
export const SCENE_MERGE_SOURCES_MAX = 100;

/** Longest scene value accepted as a merge target. */
export const SCENE_VALUE_MAX = 120;

export function sceneMergeSchema() {
  return z.object({
    // Matched against the EXACT stored value, so blanks and non-strings are
    // refused rather than trimmed into something matching a different row.
    from: z
      .array(z.unknown(), { error: 'from must be an array of scene values' })
      .transform((items, c) => {
        if (items.some((v) => typeof v !== 'string' || !(v as string).trim())) {
          c.addIssue({ code: 'custom', message: 'from must be an array of scene values' });
          return z.NEVER;
        }
        const values = [...new Set(items as string[])];
        if (values.length < 1) {
          c.addIssue({ code: 'custom', message: 'pick at least one scene to merge' });
          return z.NEVER;
        }
        if (values.length > SCENE_MERGE_SOURCES_MAX) {
          c.addIssue({
            code: 'custom',
            message: `at most ${SCENE_MERGE_SOURCES_MAX} scenes per merge`,
          });
          return z.NEVER;
        }
        return values;
      }),
    // Trimmed: the target is TYPED (it may be a new spelling), and a trailing
    // space would file a second scene beside the one meant.
    to: z.unknown().transform((raw, c) => {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) {
        c.addIssue({ code: 'custom', message: 'to (the surviving scene) is required' });
        return z.NEVER;
      }
      if (value.length > SCENE_VALUE_MAX) {
        c.addIssue({ code: 'custom', message: `to must be at most ${SCENE_VALUE_MAX} characters` });
        return z.NEVER;
      }
      return value;
    }),
  });
}

// The referenced-by warning on a scene merge (#1593). A semantic rename
// ("trip-hop" → "downtempo") leaves every show, rule and playlist filter naming
// the retired value selecting nothing, with no error. The scan lives in
// music/scene-references.ts (it needs show-filter's matcher); only the SHAPE is
// here, because it crosses to the browser.

/** Where a retired scene can still be named. A bare union: nothing validates
 *  against it at a boundary, so there is no runtime list. */
export type SceneReferenceKind = 'show' | 'rule' | 'playlist';

/** One filter that names a value this merge retires and would stop catching it. */
export interface SceneReference {
  kind: SceneReferenceKind;
  /** Show id, blocklist rule id, or Navidrome playlist id. */
  id: string;
  /** What the operator calls it: show name, rule label, playlist name. */
  name: string;
  /** Its values that NAME a retired scene (not something broader that also
   *  caught it) and do not catch the survivor. */
  orphaned: string[];
  /** The REST of this filter's own list. Empty means the orphaned values were
   *  all it had — NOT a claim that the filter now matches no tracks. */
  remaining: string[];
}
