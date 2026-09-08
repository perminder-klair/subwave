// Shared never-play blocklist schema (#1300 FR 1): the rule-entry shape
// (attribute predicate + optional seasonal allow-window + optional show scope)
// and the id-entry create body. Run by music/blocklist-rules.ts's
// validateRulePatch, at the route boundary, and by the mirrored browser copy.
// Rule ids and `addedAt` are minted by the store, so they are absent from the
// schema entirely and z.object strips a submitted one.
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

// The name fold used for DEDUPE only; the stored value keeps its casing.
// Must stay identical to `recency.nameKey` (restated, not imported — zod-only
// module); pinned by scripts/blocklist-name-fold.test.ts. Punctuation beyond
// the apostrophe is deliberately not folded (`trip-hop` != `trip hop`).
export const normText = (s: unknown) =>
  String(s ?? '').toLowerCase().replace(/[‘’ʼ´`]/g, "'").replace(/\s+/g, ' ').trim();

// Number(x) + range test rather than z.number().int(): a numeric STRING from
// <input type=number> has always been accepted.
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

// Seasonal ALLOW-window: inclusive month/day bounds, `from > to` wraps the year
// end (Dec 1 → Jan 6); while in season the rule does NOT block. Deliberately not
// range-checked across the pair — a wrapping window is the feature.
export const blockSeasonSchema = z.object({
  from: blocklistMonthDay('rule.season.from'),
  to: blocklistMonthDay('rule.season.to'),
});

// One rule's add/update payload. Every message names `rule.<field>` because the
// route surfaces it verbatim.
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
      // Blanks dropped and duplicates collapsed, but a non-string or over-long
      // entry is refused: dropping it would block less than the card shows.
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
  // Empty = station-wide. Stale ids are inert (resolved at evaluation time), so
  // a non-string entry is DROPPED rather than refused.
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

// `POST /library/blocklist` — the id-entry create body. Two accepted forms, so
// only `type` is required: `{type, trackId}` (server resolves the rest) or a
// pre-resolved `{type, id, …}`. The route decides which arrived.
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
  // Display snapshots captured at block time. Null is meaningful ("unknown"),
  // so it is preserved rather than folded to undefined.
  name: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  album: z.string().nullable().optional(),
});
