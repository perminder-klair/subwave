// Rule entries for the never-play blocklist (#1300 FR 1, closes #752) — the
// attribute/tag half of blocklist.json, beside the id entries. A rule blocks
// every track matching its field + values, optionally only OUT of a seasonal
// allow-window ("Christmas tracks only air Dec 1–26") and optionally only
// while one of a set of shows is on air. Evaluation is synchronous so it can
// sit inside blocklist.matchOf()'s hot chokepoints; everything here is pure —
// blocklist.ts owns the state, the persistence, and the evaluation context
// (clock parts, active show, playlist member sets).
//
// Pinned by scripts/blocklist-rules.test.ts.

import {
  normGenre,
  genreMatches,
  trackAllTags,
  trackMoods,
  type FilterTrack,
} from './show-filter.js';
// The artist rule reads a credit the way the id list's name fallback does — the
// whole string AND every act ON it, not just the lead (#1603). Both sides of
// that comparison have to be folded by the same normaliser, which is why the
// values compile to their own set below rather than sharing `valueSet`'s
// normText.
import { artistNameKey, artistParticipantKeys } from './recency.js';
// The rule's SHAPE — field vocabulary, caps, the season window and the
// add/update validator — lives in the shared schema so the admin card runs the
// same rules. Imported and re-exported here so no call site moved. This module
// keeps the half a mirrored module cannot have: the MATCHING, which needs
// show-filter's genre/tag normalisers.
import {
  RULES_MAX as RULES_MAX_VALUE,
  RULE_FIELDS as RULE_FIELD_VALUES,
  RULE_TEXT_MAX as RULE_TEXT_MAX_VALUE,
  RULE_VALUES_MAX as RULE_VALUES_MAX_VALUE,
  blockRuleSchema,
  normText as normTextFn,
  type RuleField,
  type SeasonWindow,
} from '../schemas/blocklist.js';

export type { RuleField, SeasonWindow };
export const RULE_FIELDS: readonly RuleField[] = RULE_FIELD_VALUES;
export const RULES_MAX = RULES_MAX_VALUE;
export const RULE_VALUES_MAX = RULE_VALUES_MAX_VALUE;
export const RULE_TEXT_MAX = RULE_TEXT_MAX_VALUE;
export const normText = normTextFn;

export interface BlockRule {
  id: string;            // unique, generated server-side — logs and DELETE key
  label: string;         // operator display name, e.g. "Christmas songs"
  field: RuleField;
  values: string[];      // any-of; playlist → Navidrome playlist ids
  season: SeasonWindow | null;
  // Scope: empty = station-wide. Non-empty = active only while one of these
  // shows is on air. Stale ids are inert (resolved against the live roster).
  showIds: string[];
  addedAt: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate an add/update payload into the persisted shape (minus id/addedAt,
 * which the store owns).
 *
 * A thin wrapper over the shared schema — the store's chokepoint, reached by
 * POST and PUT alike, so a rule that arrives any other way still meets the same
 * rules the route middleware applied. Throws a plain Error with the message
 * VERBATIM: every one already names its own `rule.<field>` path, so routing it
 * through firstMessage would double the location.
 */
export function validateRulePatch(raw: unknown): Omit<BlockRule, 'id' | 'addedAt'> {
  if (!raw || typeof raw !== 'object') throw new Error('rule must be an object');
  const parsed = blockRuleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'invalid rule');
  return parsed.data;
}

// ── Season / scope activity ──────────────────────────────────────────────────

// Month/day key comparison handles the year-end wrap without real dates:
// from <= to is a plain closed interval, from > to wraps (in-window means on
// or after `from` OR on or before `to`).
const mdKey = (month: number, day: number) => month * 100 + day;

export function inSeason(season: SeasonWindow, parts: { month: number; day: number }): boolean {
  const k = mdKey(parts.month, parts.day);
  const f = mdKey(season.from.month, season.from.day);
  const t = mdKey(season.to.month, season.to.day);
  return f <= t ? k >= f && k <= t : k >= f || k <= t;
}

// Evaluation context — computed once per matchOf sweep by blocklist.ts, never
// per track: station-zone clock parts (zonedParts) and the on-air show id.
export interface RuleContext {
  month: number;
  day: number;
  activeShowId: string | null;
}

// Is this rule blocking anything right now? Out of season (or no season) AND
// in scope. A show-scoped rule with no show on air — or another show — is
// inert; a seasonal rule in season is inert.
export function ruleActive(rule: BlockRule, ctx: RuleContext): boolean {
  if (rule.season && inSeason(rule.season, ctx)) return false;
  if (rule.showIds.length) return ctx.activeShowId != null && rule.showIds.includes(ctx.activeShowId);
  return true;
}

// ── Compilation + matching ───────────────────────────────────────────────────

// Per-mutation compile: normalise values once so the per-track cost at the
// chokepoints is set lookups + (for genre) the word-boundary walk — the same
// order as the strict-lock filters already running in those paths.
export interface CompiledRule {
  rule: BlockRule;
  genreTargets: string[];  // field=genre — normGenre'd, for genreMatches
  artistKeys: Set<string>; // field=artist — artistNameKey'd, matched per credited act
  valueSet: Set<string>;   // every other field — normText'd exact match
}

export function compileRules(rules: BlockRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    rule,
    genreTargets: rule.field === 'genre' ? rule.values.map(normGenre).filter(Boolean) : [],
    artistKeys: rule.field === 'artist' ? new Set(rule.values.map(artistNameKey).filter(Boolean)) : new Set<string>(),
    valueSet: new Set(rule.values.map(normText).filter(Boolean)),
  }));
}

// The track shape rules read — FilterTrack's tag surface plus the name fields
// the id blocklist already matches on.
export type RuleTrack = FilterTrack & { artist?: string | null; album?: string | null; title?: string | null; name?: string | null };

// Does this track match the rule's field + values? Activity (season/scope) is
// the caller's job via ruleActive — split so listing surfaces can show "what
// WOULD this rule block" independent of the clock.
//
// Semantics per field:
//   genre  — genreMatches: exact-normalised or the track's tag REFINES the
//            target on word boundaries (blocking "Punk" drops "Punk Rock";
//            blocking "Pop Punk" keeps plain "Pop"; blocking "Rap" keeps
//            "Trap") — the same direction the show filters use.
//   tag    — normalised EXACT match across every tag namespace we ingest
//            (trackAllTags: genres ∪ moods ∪ audioMoods ∪ Last.fm tags).
//            Exact, not substring — Last.fm tags are noisy free text.
//   mood   — normalised exact over trackMoods (editorial + audio union).
//   artist — the whole credit, then every act CREDITED on the row, each
//            matched exact-normalised (recency.artistParticipantKeys —
//            `feat.`/`ft.`/`featuring` split, nothing else), so blocking X also
//            blocks "Y feat. X" without stranding a value that is itself a
//            composite credit. Same semantics as the id blocklist's name
//            fallback, minus the id; the two must not drift.
//   album/title — normalised exact on the row's own fields (the id blocklist's
//            name-fallback semantics, minus the id).
//   playlist — track id ∈ the pre-resolved member set for any listed playlist
//            id; an unresolved playlist contributes nothing (stale ids inert).
export function ruleMatches(
  cr: CompiledRule,
  track: RuleTrack | null | undefined,
  playlistMembers: Map<string, Set<string>> | null,
): boolean {
  if (!track) return false;
  const { rule } = cr;
  switch (rule.field) {
    case 'genre':
      return cr.genreTargets.length > 0 && genreMatches(track, cr.genreTargets);
    case 'tag':
      return trackAllTags(track).some((t) => cr.valueSet.has(normText(t)));
    case 'mood':
      return trackMoods(track).some((m) => cr.valueSet.has(normText(m)));
    case 'artist':
      return !!track.artist && (
        // The WHOLE credit first — the pre-#1603 comparison, kept because a
        // rule value can itself be a pasted composite ("Host feat. Guest"),
        // which no participant key can ever equal. See artistNameHit.
        cr.artistKeys.has(artistNameKey(track.artist))
        || artistParticipantKeys(track.artist).some((k) => cr.artistKeys.has(k))
      );
    case 'album':
      return !!track.album && cr.valueSet.has(normText(track.album));
    case 'title': {
      const title = track.title ?? track.name;
      return !!title && cr.valueSet.has(normText(title));
    }
    case 'playlist': {
      if (!track.id || !playlistMembers) return false;
      for (const pid of rule.values) {
        if (playlistMembers.get(pid)?.has(track.id)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

// ── Persistence coercion ─────────────────────────────────────────────────────

// Coerce a raw persisted rule (blocklist.json is operator-visible state, so
// treat it like any other state file: drop what doesn't parse rather than
// refusing to boot). Returns null for an unusable record.
export function coerceStoredRule(raw: unknown): BlockRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  try {
    const patch = validateRulePatch(o);
    return { id: o.id, addedAt: typeof o.addedAt === 'string' ? o.addedAt : new Date().toISOString(), ...patch };
  } catch {
    return null;
  }
}
