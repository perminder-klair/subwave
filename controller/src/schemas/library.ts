// Shared library-maintenance schemas — the operator-facing bodies under
// /library that carry typed input rather than a bare id: `POST
// /library/manual-tag` (tag this track, or its whole album, by hand — no LLM
// involved) and `POST /library/original-year` (the operator's own answer to
// "what year was this actually recorded", behind the same row editor).
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
//
// WHY A FACTORY
// -------------
// Moods are operator-editable (settings.moodVocab()), so a manual tag can only
// be judged against the LIVE vocabulary — the same reason showSchema takes a
// context. `moodNames: null` means "this caller cannot check that rule", which
// is what lets the browser pre-flight the shape of a body whose vocabulary it
// may not have fetched yet while the route still enforces membership.
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
    // `!id || typeof id !== 'string'` — so a blank string is refused too, and
    // with the same message, which is what the route has always answered.
    id: z.unknown().optional().transform((raw, c) => {
      if (typeof raw !== 'string' || !raw) {
        c.addIssue({ code: 'custom', message: 'id is required' });
        return z.NEVER;
      }
      return raw;
    }),
    // An EMPTY array is meaningful: it clears the track's tags entirely and
    // returns it to the untagged pool. So this is required-but-may-be-empty,
    // never defaulted — a missing key and an explicit [] must not be the same
    // request.
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
    // null is the explicit "no energy", distinct from an omission only in that
    // both land on null — matching `req.body?.energy ?? null`.
    energy: z.preprocess(
      (v) => (v === undefined ? null : v),
      z
        .enum(MANUAL_TAG_ENERGIES, {
          error: "energy must be 'low', 'medium', 'high' or null",
        })
        .nullable(),
    ),
    // `=== true`, so anything else reads as off — unchanged.
    applyToAlbum: z.unknown().optional().transform((v) => v === true),
  });
}

// ── POST /library/original-year ──────────────────────────────────────────────
// The operator's manual era override (issue #1418). The automatic pipeline
// resolves an original year from the album tag or MusicBrainz, and on a reissue
// anthology both are wrong by construction — the tag carries the reissue's date
// and MB is never asked, because the lookup is gated on a compilation flag
// those albums do not set. This is the escape hatch: someone holding the sleeve
// types the real year.

/** Floor for a plausible recording year — mirrors musicbrainz.ts MIN_YEAR.
 *  Duplicated rather than imported: this file may import only 'zod'. */
export const ORIGINAL_YEAR_MIN = 1900;

export function originalYearSchema() {
  // Evaluated per request, not at module load: a schema frozen at boot would
  // start refusing next January.
  const max = new Date().getUTCFullYear() + 1;
  return z.object({
    // Same wording and same blank-string refusal as manualTagSchema — one
    // editor posts to both routes and must not get two dialects of "no id".
    id: z.unknown().optional().transform((raw, c) => {
      if (typeof raw !== 'string' || !raw) {
        c.addIssue({ code: 'custom', message: 'id is required' });
        return z.NEVER;
      }
      return raw;
    }),
    // null CLEARS the override and hands the track back to the automatic
    // pipeline, so it is a real value here rather than an omission: a missing
    // key is a malformed request, not "clear it". Numeric strings are accepted
    // because the field is typed into an <input>, but a non-integer or an
    // out-of-window year is refused rather than rounded — a silently repaired
    // year is indistinguishable on air from a correct one.
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
    // `=== true`, matching manualTagSchema. An anthology is wrong a whole album
    // at a time, so this is the common case here rather than the exception.
    applyToAlbum: z.unknown().optional().transform((v) => v === true),
  });
}
