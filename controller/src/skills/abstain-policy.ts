// Grounded skills stand down when fetched data is unusable (#1412), including
// manual, cron and programme runs. This checks facts, not operator authorization:
// POST /dj/skill returns aired:false with a reason rather than inventing a script.

// A skill data tool's return value, as far as this policy cares. Everything
// else in it is the skill's own business.
export type SkillData = { error?: unknown; available?: unknown } | null | undefined;

// Skills whose tool treats "no external item" as a cue to write one from its
// own knowledge rather than as a reason to stay quiet. curiosity is the shipped
// example: its `{ available: false }` is the designed hand-off to free
// generation (see skills/curiosity.ts), so standing it down would silence a
// skill that works exactly as intended.
//
// Keyed by kind in code, not read from the skill's files, because state/skills
// is seeded ONCE and never re-seeded: an upgraded station keeps the SKILL.md and
// tool.mjs it was first booted with, so a declaration shipped in a new image
// would not reach the installs this fixes. A skill may still override the
// default for itself — see requiresGrounding.
const FREE_GENERATION_KINDS = new Set(['curiosity']);

// Read a frontmatter/tool-module boolean. Frontmatter values arrive as strings
// (skills/loader.ts flattens every YAML scalar), a tool.mjs export arrives as a
// real boolean, and anything unrecognised means "not declared" — which falls
// through to the default rather than guessing a direction.
export function declaredBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  return undefined;
}

interface GroundedCap {
  kind?: string;
  toolFn?: unknown;
  // tool.mjs `export const requiresData = true|false` — the skill author's
  // declaration, for custom skills that don't want the kind default.
  requiresData?: unknown;
  // The skill's own frontmatter, so an operator can settle it per install with
  // a `requiresData:` line in SKILL.md. Operator wins over skill author, same
  // precedence as every other knob that appears in both places.
  config?: Record<string, unknown>;
}

// True when this capability's forced run must not speak without usable data.
//
// A skill with no data tool is never grounded — it writes from the moment and
// its brief, which is all it ever had, so there is nothing for missing data to
// invalidate. Everything else defaults to grounded: the generated tool
// description already promises callers that `{ available: false }` means
// "nothing fresh worth airing", and airing anyway is precisely the bug.
export function requiresGrounding(cap: GroundedCap | null | undefined): boolean {
  if (!cap || typeof cap.toolFn !== 'function') return false;
  const operator = declaredBool(cap.config?.requiresData);
  if (operator !== undefined) return operator;
  const author = declaredBool(cap.requiresData);
  if (author !== undefined) return author;
  return !FREE_GENERATION_KINDS.has(String(cap.kind || ''));
}

// Why the fetched data can't be written from, or null when it can.
//
// `null` data is NOT unusable: that is what fetchSegmentData returns for a
// capability with no tool at all, and a skill without a data tool has nothing
// to be ungrounded about (requiresGrounding already returns false for it, so
// this only matters for a caller asking directly).
export function unusableDataReason(data: SkillData): string | null {
  if (data == null) return null;
  if (typeof data !== 'object') return null;
  if (data.error) return `data fetch failed (${String(data.error).slice(0, 120)})`;
  if (data.available === false) return 'the skill found nothing fresh worth airing';
  return null;
}

// The two decisions together: the reason this forced run should stand down, or
// null to go ahead and speak.
export function standDownReason(cap: GroundedCap | null | undefined, data: SkillData): string | null {
  if (!requiresGrounding(cap)) return null;
  return unusableDataReason(data);
}

// Whole-word, case-insensitive: a substring test lets an artist called "Low"
// match "below". Twin of mentionsArtist in skills/builtins/now-playing-dig/
// tool.mjs, which must stay self-contained because it is copied into
// state/skills; the two must keep the same semantics.
export function mentionsArtist(text: string, artist: string): boolean {
  const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
  } catch {
    return text.toLowerCase().includes(artist.toLowerCase());
  }
}

// Legacy result repair (#1687). state/skills is seeded once, so a station keeps
// the tool.mjs it first booted with, and two shipped tools used to report
// "nothing usable" in shapes the checks above cannot read as unavailable: news
// returned an empty `headlines` array, and now-playing-dig / web-search
// returned snippets that never named the current artist (live: an empty answer
// plus unrelated pages for "Missed the Boat", which the Direct runtime then
// aired as "I'm not aware of any facts"). Repairing them HERE, keyed by kind
// like the rest of this policy, means an upgrade never has to replace an
// operator-owned file to get the stand-down. Only a result with no
// `available` verdict of its own is touched, and a custom web-search query is
// left alone because it is not about the artist at all.
export function repairLegacySkillData(cap: { kind?: unknown } | null | undefined, data: any, input: { query?: unknown } = {}): any {
  const kind = String(cap?.kind || '');
  if (!data || typeof data !== 'object' || data.available !== undefined) return data;
  if (kind === 'web-search' && typeof input.query === 'string' && input.query.trim()) return data;
  if (kind === 'news' && Array.isArray(data.headlines) && data.headlines.length === 0) {
    return { ...data, available: false };
  }
  if ((kind === 'now-playing-dig' || kind === 'web-search')
      && !String(data.answer || '').trim()
      && typeof data.artist === 'string'
      && Array.isArray(data.sources)
      && !data.sources.some((source: unknown) => mentionsArtist(String(source), data.artist))) {
    return { ...data, available: false };
  }
  return data;
}
