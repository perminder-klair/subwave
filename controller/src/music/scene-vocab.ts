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
// stored. The one case where the resolve-through is skipped is a REVERSAL — a
// target that resolves back onto a value this same merge is retiring — because
// there the resolve would cancel the merge against itself; see planAliases.
//
// A rule's `from` is a fold KEY and its `to` a stored spelling, so the two
// sides can look identical and still do work ("rock" → "Rock" canonicalises
// every case and spacing variant). Nothing may drop a rule for looking like an
// identity: that is what a pure case merge IS, and dropping it let the next
// walk write the retired spelling straight back.
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

/**
 * Trim a rule set to the cap, keeping the NEWEST.
 *
 * Rules are held oldest-first (planAliases appends new keys after the existing
 * ones), so a head slice would discard the rule just recorded while the row
 * rewrite that came with it still committed — the merge would then unwind at
 * the next walk, which is the one failure this file exists to prevent. When
 * something has to go it is the oldest fold, whose rows were consolidated long
 * ago and whose sources a walk has had every chance to stop producing.
 */
function capped(list: readonly SceneAlias[]): SceneAlias[] {
  return list.length <= SCENE_ALIASES_MAX ? [...list] : list.slice(-SCENE_ALIASES_MAX);
}

/** Test seam: the cap is only reachable through a 2000-rule file otherwise. */
export const capForTests = capped;

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
 * Trim, drop blanks, and dedupe case-insensitively keeping the FIRST spelling.
 *
 * This is the tag-list rule, stated once. Three callers reach it: ingest
 * (`subsonic.songGenres`, via applyAliases), the in-place merge
 * (`library-db/scenes.ts mergeScenes`) and the merge preview in the tests. A
 * track tagged both "Hip Hop" and "Hip-Hop" must end up carrying the survivor
 * once, not twice, whichever half of the merge got there first — which is only
 * true while all three say it the same way.
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

/**
 * Apply the map to a track's tag list, then dedupe. The ingest half of a merge:
 * `songGenres` calls this on every walked track, so a track tagged both "Hip
 * Hop" and "Hip-Hop" collapses to one tag rather than carrying the target
 * twice.
 */
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
 * Fold `sources → target` into an existing rule set, keeping it flat.
 *
 * Four cases the flatness depends on, all of which a real operator reaches by
 * merging twice:
 *
 *  - the target may already be aliased away (a → b recorded, now x → a, so x
 *    must land on b);
 *  - an existing rule may point AT a source (y → x while x → b is being
 *    recorded, so y must be repointed to b);
 *  - a source may BE the target, which is not a rule at all;
 *  - and the operator may REVERSE an earlier merge (a → b recorded, now b → a).
 *    Resolving the target through the map would send it straight back to a
 *    source of this very merge, cancelling the call against itself: every
 *    source drops out as a self-merge, no rule is recorded, no row is
 *    rewritten, and the route still answers 200 (#1580 review). So the
 *    resolve-through is skipped exactly when it lands on a value being
 *    retired, and the old rule is repointed by the loop below instead.
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
  // A target that is itself retired resolves through to the surviving value —
  // otherwise the map grows a chain and `alias()` would have to walk it. Unless
  // that survivor is one of the sources: see the reversal case above.
  const resolved = map.get(sceneKey(typed));
  const finalTarget =
    resolved !== undefined && !sourceKeys.has(sceneKey(resolved)) ? resolved.trim() : typed;
  // A source is only "itself" when it is the target VERBATIM. Two spellings
  // that merely share a fold key ("rock" ticked onto "Rock") are a real merge:
  // the stored strings differ, so the rows need rewriting, and the rule is what
  // stops the next walk writing the retired spelling straight back. Dropping
  // those was how a pure case merge survived until the next tag pass and no
  // further (#1580 review).
  const keys = new Set(
    sources
      .filter((s) => String(s ?? '').trim() !== finalTarget)
      .map(sceneKey)
      .filter(Boolean),
  );

  const next = new Map<string, string>();
  const put = (from: string, to: string) => {
    // `from` is a fold KEY and `to` a stored spelling, so even a rule whose two
    // sides look identical does work — it canonicalises every case and spacing
    // variant onto the survivor. Only an empty side is not a rule.
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
  // Deliberately NOT `sceneKey(to) === from`: `from` is a fold key, so a rule
  // that reads like an identity ("rock" → "Rock", or even "rock" → "rock")
  // still canonicalises every case and spacing variant onto one spelling. The
  // stricter test dropped exactly those rules on reload, so a case-only merge
  // came back at the next restart. Same rule as planAliases' `put`.
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
