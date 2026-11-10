// The operator's durable consolidation rules over `tracks.genres` (#1577).
// library-db/scenes.ts is the other half (the in-place rewrite); without a rule
// the next walk's `upsertTrackMeta` writes the retired spellings straight back,
// so `subsonic.songGenres` applies these on every ingest.
//
// The map is FLAT — a target that is itself aliased resolves through at record
// time, rules pointing at a source are repointed — so `alias()` is one lookup
// and no cycle can be stored. Skipped on a reversal; see planAliases.
//
// A rule's `from` is a fold KEY and `to` a stored spelling, so both sides may
// look identical and still do work ("rock" → "Rock"). Never drop a rule for
// reading like an identity.
//
// Loading is lazy and SYNCHRONOUS: `songGenres` runs in both the controller and
// the tagger child, and a boot hook one of them forgets is a silently inert
// feature. A missing or corrupt file starts empty.

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

const FILE_PATH = `${config.stateDir}/scene-aliases.json`;

/** One consolidation rule: every ingested value keyed `from` becomes `to`. */
export interface SceneAlias {
  /** The folded key of the retired value (see sceneKey). */
  from: string;
  /** The surviving value, verbatim — this is what gets written. */
  to: string;
  at: string;
}

/** Corrupt-file guard, not a curation limit (a noisy 40k library lands in the
 *  low hundreds). */
export const SCENE_ALIASES_MAX = 2000;

// Trim to the cap keeping the NEWEST: rules are held oldest-first, so a head
// slice would discard the rule just recorded while its row rewrite committed.
function capped(list: readonly SceneAlias[]): SceneAlias[] {
  return list.length <= SCENE_ALIASES_MAX ? [...list] : list.slice(-SCENE_ALIASES_MAX);
}

/** Test seam: the cap is only reachable through a 2000-rule file otherwise. */
export const capForTests = capped;

/**
 * Comparison key for a scene value: case and whitespace only. Punctuation is
 * NOT folded — "Hip Hop" and "Hip-Hop" are different labels, and which survives
 * is the operator's call.
 */
export function sceneKey(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export type SceneAliasMap = ReadonlyMap<string, string>;

export function aliasMapOf(list: readonly SceneAlias[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of list) m.set(a.from, a.to);
  return m;
}

/** Resolve one value through the map. Unknown values pass through unchanged. */
export function aliasValue(value: string, map: SceneAliasMap): string {
  return map.get(sceneKey(value)) ?? value;
}

/**
 * Trim, drop blanks, dedupe case-insensitively keeping the FIRST spelling.
 * Shared by ingest (applyAliases) and the in-place merge
 * (`library-db/scenes.ts mergeScenes`); both halves must agree.
 */
export function dedupeScenes(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

/** Apply the map to a track's tag list, then dedupe. The ingest half of a merge. */
export function applyAliases(values: readonly string[], map: SceneAliasMap): string[] {
  return dedupeScenes(values.map((v) => aliasValue(String(v ?? '').trim(), map)));
}

export interface AliasPlan {
  /** The map after the merge, still flat. */
  aliases: SceneAlias[];
  /** The final target, after resolving a target that was itself aliased. */
  target: string;
  /** The source keys actually recorded (self-merges dropped). */
  recorded: string[];
}

/**
 * Fold `sources → target` into an existing rule set, keeping it flat. Four
 * cases: the target is already aliased away (resolve through); an existing rule
 * points AT a source (repoint it); a source IS the target (not a rule); and a
 * REVERSAL, where the target resolves back onto a value this merge is retiring
 * — resolving there would cancel the merge against itself, so it is skipped and
 * the old rule repointed instead (#1580).
 */
export function planAliases(
  existing: readonly SceneAlias[],
  sources: readonly string[],
  target: string,
  now: string,
): AliasPlan {
  const map = aliasMapOf(existing);
  const typed = String(target ?? '').trim();
  const sourceKeys = new Set(sources.map(sceneKey).filter(Boolean));
  // Resolve through, unless the survivor is one of the sources (the reversal).
  const resolved = map.get(sceneKey(typed));
  const finalTarget =
    resolved !== undefined && !sourceKeys.has(sceneKey(resolved)) ? resolved.trim() : typed;
  // A source is "itself" only when it is the target VERBATIM: two spellings
  // sharing a fold key ("rock" onto "Rock") are a real merge (#1580).
  const keys = new Set(
    sources
      .filter((s) => String(s ?? '').trim() !== finalTarget)
      .map(sceneKey)
      .filter(Boolean),
  );

  const next = new Map<string, string>();
  const put = (from: string, to: string) => {
    // Only an empty side is not a rule; identity-looking ones do real work.
    if (!from || !to) return;
    next.set(from, to);
  };
  for (const a of existing) {
    if (keys.has(a.from)) continue; // replaced below
    // Repoint anything that pointed at a value now being retired.
    put(a.from, keys.has(sceneKey(a.to)) ? finalTarget : a.to);
  }
  for (const k of keys) put(k, finalTarget);

  const stamped = new Map(existing.map((a) => [a.from, a.at]));
  const aliases = [...next.entries()].map(([from, to]) => ({
    from,
    to,
    at: keys.has(from) ? now : (stamped.get(from) ?? now),
  }));
  return { aliases, target: finalTarget, recorded: [...keys].filter((k) => next.has(k)) };
}

let aliases: SceneAlias[] | null = null;
let map: Map<string, string> = new Map();

function coerce(raw: unknown): SceneAlias | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { from?: unknown; to?: unknown; at?: unknown };
  const from = sceneKey(r.from);
  const to = String(r.to ?? '').trim();
  // Not `sceneKey(to) === from`: an identity-looking rule still canonicalises
  // every case/spacing variant. Same rule as planAliases' `put`.
  if (!from || !to) return null;
  return { from, to, at: typeof r.at === 'string' ? r.at : new Date().toISOString() };
}

function ensureLoaded(): void {
  if (aliases) return;
  aliases = [];
  try {
    const raw = JSON.parse(readFileSync(FILE_PATH, 'utf8')) as { aliases?: unknown };
    const list = Array.isArray(raw?.aliases) ? raw.aliases : [];
    const kept = capped(list.map(coerce).filter((a): a is SceneAlias => a !== null));
    if (kept.length < list.length) {
      console.error(`[scenes] dropped ${list.length - kept.length} unusable alias(es) from scene-aliases.json`);
    }
    aliases = kept;
    if (kept.length) console.log(`[scenes] loaded ${kept.length} scene alias(es)`);
  } catch (err) {
    // Missing file is normal; a corrupt one starts empty rather than blocking.
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== 'ENOENT') console.error('[scenes] alias load failed, starting empty:', e.message);
  }
  map = aliasMapOf(aliases);
}

/** Every rule, newest-recorded first. */
export function list(): SceneAlias[] {
  ensureLoaded();
  return [...aliases!].sort((a, b) => b.at.localeCompare(a.at));
}

/** The live map — the read `songGenres` takes on every ingested tag. */
export function activeMap(): SceneAliasMap {
  ensureLoaded();
  return map;
}

/** One value through the live map. Unknown values pass through unchanged. */
export function alias(value: string): string {
  ensureLoaded();
  return map.get(sceneKey(value)) ?? value;
}

async function persist(next: SceneAlias[]): Promise<void> {
  aliases = capped(next);
  map = aliasMapOf(aliases);
  await writeFileAtomic(FILE_PATH, JSON.stringify({ aliases }, null, 2));
}

/** Record `sources → target`. Returns the resolved target and the keys stored. */
export async function recordMerge(
  sources: readonly string[],
  target: string,
): Promise<{ target: string; recorded: string[] }> {
  ensureLoaded();
  const plan = planAliases(aliases!, sources, target, new Date().toISOString());
  await persist(plan.aliases);
  return { target: plan.target, recorded: plan.recorded };
}

/**
 * Stop consolidating this on the next walk. Rows already rewritten keep the
 * target value; which spelling each had is not recoverable.
 */
export async function forget(from: string): Promise<boolean> {
  ensureLoaded();
  const key = sceneKey(from);
  const next = aliases!.filter((a) => a.from !== key);
  if (next.length === aliases!.length) return false;
  await persist(next);
  return true;
}

/** Test seam: drop the in-memory copy so the next read re-reads the file. */
export function _resetForTests(): void {
  aliases = null;
  map = new Map();
}
