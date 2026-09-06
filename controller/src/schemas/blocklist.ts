// Shared never-play blocklist schema (#1300 FR 1) — the shape of a RULE entry
// (attribute predicate + optional seasonal allow-window + optional show scope)
// and of the id-entry create body, executed on BOTH sides. The controller runs
// it in music/blocklist-rules.ts's validateRulePatch (the store's chokepoint,
// reached by POST and PUT alike) and at the route boundary; the browser runs
// the mirrored copy so BlockRulesCard can pre-flight a save.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle, so a project import or a node builtin here breaks the mirror.
// music/blocklist-rules.ts itself cannot be a schema module — it imports
// show-filter's genre/tag normalisers for the MATCHING half — which is exactly
// why the validation half moved here and is re-exported from there.
//
// WHAT DELIBERATELY DID NOT MOVE
// ------------------------------
// Rule ids and `addedAt` are minted by the store, not submitted, so they are
// absent from the schema entirely (rather than optional): a client that sends
// one is not describing a rule, and z.object strips it before the store sees it
// — the same posture as a show's server-minted id, one step stricter because
// nothing downstream points at a rule id the way a schedule slot points at a
// show id.
import { z } from 'zod';

export const RULE_FIELDS = [
  'genre',
  'tag',
  'mood',
  'artist',
  'album',
  'title',
  'playlist',
] as const;

export type RuleField = (typeof RULE_FIELDS)[number];

export const RULES_MAX = 50;
export const RULE_VALUES_MAX = 12;
export const RULE_TEXT_MAX = 64;

/** Id-entry granularity — a blocked track, its album, or its artist. */
export const BLOCK_TYPES = ['track', 'album', 'artist'] as const;

export interface SeasonWindow {
  from: { month: number; day: number };
  to: { month: number; day: number };
}

/**
 * Trim, lowercase, collapse whitespace — the normalisation the `tag`, `mood`,
 * `album` and `title` rule fields compare with. Used here only for DEDUPE; the
 * stored value keeps its original casing.
 *
 * NOT what the `artist` field compares with any more (#1603): an artist value
 * and an incoming credit are both keyed by `recency.artistNameKey`, which folds
 * curly apostrophes as well, and the credit is additionally read as every act
 * ON it. So two artist values differing only in apostrophe style survive the
 * dedupe here and compile to one matching key — harmless, but the two are no
 * longer the same rule.
 */
export const normText = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// A month/day pair. Both halves are `Number(x)` + an integer/range test, not
// z.number().int(), because the admin card posts them from <input type=number>
// and a numeric STRING has always been accepted.
function blocklistMonthDay(where: string) {
  return z.unknown().optional().transform((raw, ctx) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const month = Number(o.month);
    const day = Number(o.day);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      ctx.addIssue({ code: 'custom', message: `${where}.month must be 1-12` });
      return z.NEVER;
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      ctx.addIssue({ code: 'custom', message: `${where}.day must be 1-31` });
      return z.NEVER;
    }
    return { month, day };
  });
}

/**
 * A seasonal ALLOW-window: inclusive month/day bounds, `from > to` wrapping the
 * year end (Dec 1 → Jan 6). While in season the rule does NOT block.
 *
 * Deliberately NOT range-checked beyond each half: a wrapping window is the
 * feature, so "from after to" is meaningful rather than backwards — unlike a
 * show's era window, where the same shape IS an error.
 */
export const blockSeasonSchema = z.object({
  from: blocklistMonthDay('rule.season.from'),
  to: blocklistMonthDay('rule.season.to'),
});

/**
 * The add/update payload for one rule, in the persisted shape minus the
 * store-owned id/addedAt.
 *
 * Every message names `rule.<field>` because the route surfaces it verbatim,
 * the same convention validateShowsStrict follows.
 */
export const blockRuleSchema = z.object({
  label: z
    .unknown()
    .optional()
    .transform((raw, ctx) => {
      const v = String(raw ?? '').trim();
      if (!v) {
        ctx.addIssue({ code: 'custom', message: 'rule.label is required' });
        return z.NEVER;
      }
      if (v.length > RULE_TEXT_MAX) {
        ctx.addIssue({
          code: 'custom',
          message: `rule.label must be at most ${RULE_TEXT_MAX} chars`,
        });
        return z.NEVER;
      }
      return v;
    }),
  field: z.enum(RULE_FIELDS, {
    error: `rule.field must be one of: ${RULE_FIELDS.join(', ')}`,
  }),
  values: z
    .array(z.unknown(), { error: 'rule.values must be an array' })
    .transform((items, ctx) => {
      // A blank entry is dropped and a duplicate is silently collapsed (same
      // value twice is one value), but a NON-STRING entry and an over-long one
      // are both refused — the operator typed something that isn't a value, and
      // silently discarding it would block less than the card shows.
      const out: string[] = [];
      const seen = new Set<string>();
      for (const v of items) {
        if (typeof v !== 'string') {
          ctx.addIssue({ code: 'custom', message: 'rule.values entries must be strings' });
          return z.NEVER;
        }
        const t = v.trim();
        if (!t) continue;
        if (t.length > RULE_TEXT_MAX) {
          ctx.addIssue({
            code: 'custom',
            message: `rule.values entries must be at most ${RULE_TEXT_MAX} chars`,
          });
          return z.NEVER;
        }
        const key = normText(t);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
      if (!out.length) {
        ctx.addIssue({ code: 'custom', message: 'rule.values must have at least one entry' });
        return z.NEVER;
      }
      if (out.length > RULE_VALUES_MAX) {
        ctx.addIssue({
          code: 'custom',
          message: `rule.values must have at most ${RULE_VALUES_MAX} entries`,
        });
        return z.NEVER;
      }
      return out;
    }),
  // Absent or null = no season, i.e. the rule always blocks.
  season: z.preprocess((v) => (v == null ? undefined : v), blockSeasonSchema.nullable().default(null)),
  // Empty = station-wide. Stale ids are inert by design (resolved against the
  // live roster at evaluation time), so a non-string entry is DROPPED rather
  // than refused — the same call persona.skills makes for the same reason.
  showIds: z.preprocess(
    (v) => (v == null ? undefined : v),
    z
      .array(z.unknown(), { error: 'rule.showIds must be an array of strings' })
      .transform((items) => [
        ...new Set(
          items.filter((v): v is string => typeof v === 'string' && !!v.trim()),
        ),
      ])
      .default([]),
  ),
});

export type BlockRulePatch = z.output<typeof blockRuleSchema>;

/**
 * `POST /library/blocklist` — the id-entry create body.
 *
 * TWO accepted forms, which is why nothing but `type` is required: the UI flow
 * posts `{type, trackId}` and the server resolves the album/artist ids and
 * display snapshots from the track row, while a direct entry posts a
 * pre-resolved `{type, id, …}`. Which of the two arrived is decided by the
 * route (it needs Subsonic to resolve one of them), so the schema's job is only
 * to pin the shape both share.
 */
export const blockEntrySchema = z.object({
  type: z.enum(BLOCK_TYPES, { error: "type must be 'track', 'album' or 'artist'" }),
  trackId: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.string({ error: 'trackId must be a string' }).optional(),
  ),
  id: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.string({ error: 'id must be a string' }).optional(),
  ),
  // Display snapshots — free text captured at block time so the Blocked tab can
  // name a row whose source has since vanished. Null is meaningful ("unknown"),
  // so it is preserved rather than folded to undefined.
  name: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  album: z.string().nullable().optional(),
});
