// Scene vocabulary — the operator's consolidation rules over the library's
// genre tags (issue #1577).
//
// "Scene" is what the Observatory calls a genre tag, and it is the word the
// operator sees; the storage is `tracks.genres`. After a full library pass a
// real catalogue carries near-duplicates and one-off spellings ("Hip Hop",
// "hip-hop", "HipHop") that each hold a handful of tracks, and nothing could
// see or merge them.
//
// WHY A DURABLE RULE AND NOT JUST A REWRITE
// -----------------------------------------
// The merge itself rewrites `tracks.genres` in place (library-db/scenes.ts),
// which answers "consolidate what I have". It cannot answer "keep it
// consolidated": the mirror is rebuilt from Navidrome on every walk, and
// `upsertTrackMeta` writes the walked genres over the stored ones — so a merge
// with no memory is undone by the next tag pass, which is exactly the pass the
// operator just ran. Each merge therefore also records an ALIAS here, and
// `subsonic.songGenres` — the single ingest normaliser — applies it, so every
// later walk lands on the consolidated name.
//
// The map is kept FLAT: a target that is itself aliased resolves through to the
// final value at record time, and existing aliases pointing at a source are
// repointed. So `alias()` is one lookup, never a walk, and a cycle cannot be
// stored.
//
// Loading is lazy and synchronous, deliberately. `songGenres` is called from
// two processes — the controller and the tagger child — and a boot hook that
// one of them forgets is a silently inert feature. The file is small, the read
// happens once per process, and a missing or corrupt file starts empty.

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

/** How many rules one station may hold. A noisy 40k library lands in the low
 *  hundreds; the cap is a corrupt-file guard, not a curation limit. */
export const SCENE_ALIASES_MAX = 2000;

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/**
 * The comparison key for a scene value: case and surrounding/repeated
 * whitespace only. Punctuation is NOT folded — "Hip Hop" and "Hip-Hop" are
 * different labels and which of them survives is the operator's call, not a
 * normaliser's guess. Folding case does mean one rule catches "Rock" and
 * "rock", which arrive as two distinct rows from two differently-tagged files.
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
 * Apply the map to a track's tag list, then dedupe case-insensitively keeping
 * the first spelling — the same dedupe `songGenres` already does, so a track
 * tagged both "Hip Hop" and "Hip-Hop" collapses to one tag after the merge
 * rather than carrying the target twice.
 */
export function applyAliases(values: readonly string[], map: SceneAliasMap): string[] {
  const out: string[] = [];
  for (const v of values) {
    const mapped = aliasValue(v, map).trim();
    if (!mapped) continue;
    if (!out.some((x) => x.toLowerCase() === mapped.toLowerCase())) out.push(mapped);
  }
  return out;
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
 * Fold `sources → target` into an existing rule set, keeping it flat.
 *
 * Three cases the flatness depends on, all of which a real operator reaches by
 * merging twice: the target may already be aliased away (a → b recorded, now
 * x → a, so x must land on b); an existing rule may point AT a source (y → x
 * while x → b is being recorded, so y must be repointed to b); and a source may
 * equal the target under the fold, which is not a rule at all.
 */
export function planAliases(
  existing: readonly SceneAlias[],
  sources: readonly string[],
  target: string,
  now: string,
): AliasPlan {
  const map = aliasMapOf(existing);
  // A target that is itself retired resolves through to the surviving value —
  // otherwise the map grows a chain and `alias()` would have to walk it.
  const finalTarget = (map.get(sceneKey(target)) ?? target).trim();
  const targetKey = sceneKey(finalTarget);
  const keys = new Set(sources.map(sceneKey).filter((k) => k && k !== targetKey));

  const next = new Map<string, string>();
  for (const a of existing) {
    if (keys.has(a.from)) continue; // replaced below
    // Repoint anything that pointed at a value now being retired.
    next.set(a.from, keys.has(sceneKey(a.to)) ? finalTarget : a.to);
  }
  for (const k of keys) next.set(k, finalTarget);

  const stamped = new Map(existing.map((a) => [a.from, a.at]));
  const aliases = [...next.entries()].map(([from, to]) => ({
    from,
    to,
    at: keys.has(from) ? now : (stamped.get(from) ?? now),
  }));
  return { aliases, target: finalTarget, recorded: [...keys] };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let aliases: SceneAlias[] | null = null;
let map: Map<string, string> = new Map();

function coerce(raw: unknown): SceneAlias | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { from?: unknown; to?: unknown; at?: unknown };
  const from = sceneKey(r.from);
  const to = String(r.to ?? '').trim();
  if (!from || !to || sceneKey(to) === from) return null;
  return { from, to, at: typeof r.at === 'string' ? r.at : new Date().toISOString() };
}

function ensureLoaded(): void {
  if (aliases) return;
  aliases = [];
  try {
    const raw = JSON.parse(readFileSync(FILE_PATH, 'utf8')) as { aliases?: unknown };
    const list = Array.isArray(raw?.aliases) ? raw.aliases : [];
    const kept = list.map(coerce).filter((a): a is SceneAlias => a !== null).slice(0, SCENE_ALIASES_MAX);
    if (kept.length < list.length) {
      console.error(`[scenes] dropped ${list.length - kept.length} unusable alias(es) from scene-aliases.json`);
    }
    aliases = kept;
    if (kept.length) console.log(`[scenes] loaded ${kept.length} scene alias(es)`);
  } catch (err) {
    // Missing file is the normal case; a corrupt one starts empty rather than
    // blocking a walk. Either way the library still tags, just unconsolidated.
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
  aliases = next.slice(0, SCENE_ALIASES_MAX);
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
 * Forget one rule. The rows already rewritten keep the target value — undoing
 * those would mean inventing which of several merged spellings each row had.
 * This is "stop consolidating this on the next walk", and the route says so.
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
