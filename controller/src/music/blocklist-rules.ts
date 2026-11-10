// Attribute/tag half of blocklist.json (#752). Pure and SYNCHRONOUS so it can sit
// inside blocklist.matchOf()'s hot chokepoints; blocklist.ts owns the state and
// the evaluation context (clock, active show, playlist members).

import {
  normGenre,
  genreMatches,
  trackAllTags,
  trackMoods,
  type FilterTrack,
} from './show-filter.js';
// The artist rule must fold through the same normaliser as the id list's name
// fallback (#1603), hence its own compiled set rather than valueSet's normText.
import { artistNameKey, artistParticipantKeys } from './recency.js';
// Shape lives in the shared schema so the admin card runs the same rules;
// re-exported here. This module keeps the half a mirrored module cannot: matching.
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

// Chokepoint for POST and PUT alike. Throws the schema message VERBATIM: each
// already names its `rule.<field>` path, so firstMessage would double it.
export function validateRulePatch(raw: unknown): Omit<BlockRule, 'id' | 'addedAt'> {
  if (!raw || typeof raw !== 'object') throw new Error('rule must be an object');
  const parsed = blockRuleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'invalid rule');
  return parsed.data;
}

// from <= to is a closed interval; from > to wraps the year end.
const mdKey = (month: number, day: number) => month * 100 + day;

export function inSeason(season: SeasonWindow, parts: { month: number; day: number }): boolean {
  const k = mdKey(parts.month, parts.day);
  const f = mdKey(season.from.month, season.from.day);
  const t = mdKey(season.to.month, season.to.day);
  return f <= t ? k >= f && k <= t : k >= f || k <= t;
}

// Computed once per matchOf sweep by blocklist.ts, never per track.
export interface RuleContext {
  month: number;
  day: number;
  activeShowId: string | null;
}

// Blocking now? Out of season (or seasonless) AND in scope. A show-scoped rule
// with no show on air is inert.
export function ruleActive(rule: BlockRule, ctx: RuleContext): boolean {
  if (rule.season && inSeason(rule.season, ctx)) return false;
  if (rule.showIds.length) return ctx.activeShowId != null && rule.showIds.includes(ctx.activeShowId);
  return true;
}

// Per-mutation compile: normalise once so the per-track cost is set lookups.
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

// FilterTrack's tag surface plus the name fields the id blocklist matches on.
export type RuleTrack = FilterTrack & { artist?: string | null; album?: string | null; title?: string | null; name?: string | null };

// Field/value match only; activity (season/scope) is the caller's job via
// ruleActive, so listings can show what a rule WOULD block off the clock.
//   genre    - genreMatches' refine direction ("Punk" drops "Punk Rock", not the reverse)
//   tag/mood/album/title - normalised exact, never substring
//   artist   - whole credit, then every act credited on the row
//   playlist - track id in the pre-resolved member set; a stale id is inert
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
        // Whole credit first: a rule value can be a pasted composite (#1603).
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

// null for an unusable record: blocklist.json is operator-editable, so a bad
// record is dropped rather than fatal at boot.
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
