// Global never-play blocklist — entries plus attribute rules (#1300 FR 1),
// persisted to <stateDir>/blocklist.json, deliberately NOT in library.db so
// Library → Reset/Reconcile can't wipe it. Pure matching lives in
// blocklist-rules.ts; this module owns state, persistence and the eval context.
//
// hitOf() is the one entries-then-rules answer; isBlocked() is a predicate over
// it. Matching is id-first with a normalised-name fallback for album/artist
// (library-db rows carry only names); track entries never name-match, since
// covers share titles.
import { config } from '../config.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../util/atomic-file.js';
import { zonedParts } from '../time.js';
import { resolveActiveShow } from '../settings.js';
import { resolvePlaylistMemberSets } from './show-playlist.js';
import { artistNameKey, artistParticipantKeys, nameKey } from './recency.js';
import {
  compileRules,
  coerceStoredRule,
  ruleActive,
  ruleMatches,
  validateRulePatch,
  RULES_MAX,
  type BlockRule,
  type CompiledRule,
  type RuleField,
} from './blocklist-rules.js';

export type { BlockRule, RuleField, SeasonWindow } from './blocklist-rules.js';

export type BlockType = 'track' | 'album' | 'artist';

// Rides admin listing rows as `blockedBy`: enough to render the badge and to
// issue the DELETE (or open the rule editor) that clears it.
export type BlockRef =
  | { kind: 'entry'; type: BlockType; id: string; name: string | null }
  | { kind: 'rule'; field: RuleField; id: string; label: string; seasonal: boolean };

export interface BlockEntry {
  type: BlockType;
  id: string;
  // Display snapshots, so rendering and enforcing need no Navidrome lookup.
  name: string | null;
  artist: string | null;
  album: string | null;
  addedAt: string;
}

const FILE_PATH = `${config.stateDir}/blocklist.json`;

let entries: BlockEntry[] = [];
let rules: BlockRule[] = [];
let compiledRules: CompiledRule[] = [];
let loaded = false;

// In-memory match index, rebuilt on every mutation. Maps rather than Sets
// because matchOf() has to name the entry that matched.
let trackIds = new Map<string, BlockEntry>();
let albumIds = new Map<string, BlockEntry>();
let artistIds = new Map<string, BlockEntry>();
let artistNames = new Map<string, BlockEntry>();   // nameKey'd (as artistNameKey)
let albumKeys = new Map<string, BlockEntry>();     // nameKey'd album + KEY_SEP + artist

// Album keys join two free-text fields, so the separator must be a character
// neither can contain, or ("a b", "c") and ("a", "b c") collide. In-memory
// only, so the value is free to change.
const KEY_SEP = '\u0000';
// Both halves key through `recency.nameKey`, never a local normaliser: this
// tier and the `field: 'album'` rule (schemas/blocklist.ts normText) must
// answer the same way (#1611).
const albumKey = (album: unknown, artist: unknown) => `${nameKey(album)}${KEY_SEP}${nameKey(artist)}`;

function rebuildIndex() {
  trackIds = new Map();
  albumIds = new Map();
  artistIds = new Map();
  artistNames = new Map();
  albumKeys = new Map();
  for (const e of entries) {
    if (e.type === 'track') trackIds.set(e.id, e);
    else if (e.type === 'album') {
      albumIds.set(e.id, e);
      if (e.name) albumKeys.set(albumKey(e.name, e.artist), e);
    } else if (e.type === 'artist') {
      artistIds.set(e.id, e);
      if (e.name) artistNames.set(artistNameKey(e.name), e);
    }
  }
  compiledRules = compileRules(rules);
  ruleCtxCache = null;
}

// The active-rule subset depends only on the station-zone clock and the on-air
// show, so it is memoised rather than recomputed per matchOf() — a per-track
// zonedParts (Intl formatToParts) would cost more than the match.
const RULE_CONTEXT_TTL_MS = 15_000;
let ruleCtxCache: { at: number; active: CompiledRule[] } | null = null;

function activeCompiledRules(): CompiledRule[] {
  if (!compiledRules.length) return [];
  const now = Date.now();
  if (ruleCtxCache && now - ruleCtxCache.at < RULE_CONTEXT_TTL_MS) return ruleCtxCache.active;
  const { month, day } = zonedParts(new Date(now));
  // Settings may not be loaded in auxiliary processes (tagger child). A failed
  // resolve reads as "no show on air", so show-scoped rules go inert
  // (under-blocks rather than over-blocks).
  let activeShowId: string | null = null;
  try {
    activeShowId = resolveActiveShow()?.id ?? null;
  } catch {}
  const ctx = { month, day, activeShowId };
  const active = compiledRules.filter((cr) => ruleActive(cr.rule, ctx));
  ruleCtxCache = { at: now, active };
  maybeRefreshPlaylistMembers();
  return active;
}

// The one async-sourced matcher input, pre-resolved into module state so
// matchOf stays synchronous. Refreshed on load, on rule mutation, and lazily on
// a 30-min TTL. A stale/deleted playlist id resolves to nothing, leaving the
// rule inert rather than wrong.
const PLAYLIST_MEMBERS_TTL_MS = 30 * 60 * 1000;
let playlistMembers = new Map<string, Set<string>>();
let playlistMembersAt = 0;
let playlistRefreshInflight: Promise<void> | null = null;

function playlistRuleIds(): string[] {
  return [...new Set(rules.filter((r) => r.field === 'playlist').flatMap((r) => r.values))];
}

export async function refreshPlaylistMembers(): Promise<void> {
  const ids = playlistRuleIds();
  if (!ids.length) {
    playlistMembers = new Map();
    playlistMembersAt = Date.now();
    return;
  }
  playlistMembers = await resolvePlaylistMemberSets(ids);
  playlistMembersAt = Date.now();
}

function maybeRefreshPlaylistMembers() {
  if (!playlistRuleIds().length) return;
  if (Date.now() - playlistMembersAt < PLAYLIST_MEMBERS_TTL_MS) return;
  if (playlistRefreshInflight) return;
  playlistRefreshInflight = refreshPlaylistMembers()
    .catch((err) => console.warn(`[blocklist] playlist member refresh failed: ${err.message}`))
    .finally(() => {
      playlistRefreshInflight = null;
    });
}

export async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await readFile(FILE_PATH, 'utf8'));
    const list = Array.isArray(raw?.entries) ? raw.entries : [];
    entries = list.filter(
      (e: any) => e && ['track', 'album', 'artist'].includes(e.type) && typeof e.id === 'string' && e.id,
    ).map((e: any) => ({
      type: e.type as BlockType,
      id: e.id,
      name: e.name ?? null,
      artist: e.artist ?? null,
      album: e.album ?? null,
      addedAt: e.addedAt ?? new Date().toISOString(),
    }));
    // Pre-rules files carry no `rules` key. Unparseable records drop loudly;
    // a state file never blocks boot.
    const rawRules = Array.isArray(raw?.rules) ? raw.rules : [];
    rules = rawRules.map(coerceStoredRule).filter((r: BlockRule | null): r is BlockRule => r !== null);
    if (rules.length < rawRules.length) {
      console.error(`[blocklist] dropped ${rawRules.length - rules.length} unparseable rule(s) from blocklist.json`);
    }
  } catch (err: any) {
    // Missing file is the normal first boot; corrupt JSON starts empty.
    if (err?.code !== 'ENOENT') console.error('[blocklist] load failed, starting empty:', err.message);
    entries = [];
    rules = [];
  }
  rebuildIndex();
  if (entries.length || rules.length) {
    console.log(`[blocklist] loaded ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
  }
  // Member sets need Subsonic; never block boot on it. A miss leaves those
  // rules inert until the lazy TTL refresh.
  if (playlistRuleIds().length) {
    refreshPlaylistMembers().catch((err) => console.warn(`[blocklist] playlist member load failed: ${err.message}`));
  }
}

async function persist() {
  await writeFileAtomic(FILE_PATH, JSON.stringify({ entries, rules }, null, 2));
}

export function list(): BlockEntry[] {
  return entries.slice();
}

export function listRules(): BlockRule[] {
  return rules.slice();
}

// Hot-path skip. Activity (season/show scope) is the memo's business, so an
// out-of-season rule still counts as non-empty.
export function isEmpty(): boolean {
  return entries.length === 0 && rules.length === 0;
}

// Add an entry; returns it, or null when (type, id) is already blocked.
export async function add(input: { type: BlockType; id: string; name?: string | null; artist?: string | null; album?: string | null }): Promise<BlockEntry | null> {
  if (entries.some((e) => e.type === input.type && e.id === input.id)) return null;
  const entry: BlockEntry = {
    type: input.type,
    id: input.id,
    name: input.name ?? null,
    artist: input.artist ?? null,
    album: input.album ?? null,
    addedAt: new Date().toISOString(),
  };
  entries.push(entry);
  rebuildIndex();
  await persist();
  return entry;
}

export async function remove(type: BlockType, id: string): Promise<boolean> {
  const before = entries.length;
  entries = entries.filter((e) => !(e.type === type && e.id === id));
  if (entries.length === before) return false;
  rebuildIndex();
  await persist();
  return true;
}

// Bulk unblock in one rewrite and one persist. Not N concurrent remove() calls:
// each persists on a later tick, so two in flight can land the file in the
// earlier of the two states.
export async function removeMany(
  targets: Array<{ type: BlockType; id: string }>,
): Promise<{ removed: number; missing: Array<{ type: BlockType; id: string }> }> {
  const wanted = new Set(targets.map((t) => `${t.type}:${t.id}`));
  const present = new Set(entries.map((e) => `${e.type}:${e.id}`));
  const missing = targets.filter((t) => !present.has(`${t.type}:${t.id}`));
  const before = entries.length;
  entries = entries.filter((e) => !wanted.has(`${e.type}:${e.id}`));
  const removed = before - entries.length;
  if (removed) {
    rebuildIndex();
    await persist();
  }
  return { removed, missing };
}

// Which entry blocks this row, or null. Accepts anything song-shaped (a raw
// Subsonic song, or a library-db row with only id/artist/album).
//
// The order is part of the contract: the admin UI offers to remove exactly the
// entry named, so a row must always resolve to the same one. Ids first, then
// the name fallback for rows without Subsonic ids — album by (name, artist)
// pair, so "Greatest Hits" can't cross-match another artist's album.
export function matchOf(song: any): BlockEntry | null {
  if (!song || entries.length === 0) return null;
  return (
    (song.id ? trackIds.get(song.id) : undefined)
    ?? (song.albumId ? albumIds.get(song.albumId) : undefined)
    ?? (song.artistId ? artistIds.get(song.artistId) : undefined)
    ?? (artistNames.size && song.artist ? artistNameHit(song.artist) : undefined)
    ?? (albumKeys.size && song.album ? albumKeys.get(albumKey(song.album, song.artist)) : undefined)
    ?? null
  );
}

// Which entry blocks any act credited on this row. The whole credit is probed
// first (#1603), then each act in credit order. The whole-credit probe is
// load-bearing: an entry's stored `name` is the display CREDIT of the row it
// was created from ("Host feat. Guest"), a key no participant walk produces.
function artistNameHit(artist: unknown): BlockEntry | undefined {
  const raw = String(artist ?? '');
  const whole = artistNames.get(artistNameKey(raw));
  if (whole) return whole;
  for (const key of artistParticipantKeys(raw)) {
    const hit = artistNames.get(key);
    if (hit) return hit;
  }
  return undefined;
}

// Which active rule blocks this row, or null. First match in list order, so the
// badge a row shows doesn't wander between polls.
export function ruleMatchOf(song: any): BlockRule | null {
  const active = activeCompiledRules();
  if (!active.length || !song) return null;
  for (const cr of active) {
    if (ruleMatches(cr, song, playlistMembers)) return cr.rule;
  }
  return null;
}

// The one enforcement/visibility answer: entries first (most specific), then
// active rules.
export function hitOf(song: any): BlockRef | null {
  const entry = matchOf(song);
  if (entry) return refOf(entry);
  const rule = ruleMatchOf(song);
  return rule ? ruleRefOf(rule) : null;
}

export function isBlocked(song: any): boolean {
  return hitOf(song) !== null;
}

export function refOf(entry: BlockEntry): BlockRef {
  return { kind: 'entry', type: entry.type, id: entry.id, name: entry.name };
}

export function ruleRefOf(rule: BlockRule): BlockRef {
  return { kind: 'rule', field: rule.field, id: rule.id, label: rule.label, seasonal: !!rule.season };
}

// Array filter for song-source returns; identity when nothing is blocked.
export function rejectBlocked<T>(arr: T[]): T[] {
  if (isEmpty()) return arr;
  return (arr || []).filter((s) => !isBlocked(s));
}

// The admin-listing opposite of rejectBlocked: keep every row and stamp what
// blocks it. Always stamps the field (null when clear), so one row shape.
export function annotate<T extends object>(arr: T[]): Array<T & { blockedBy: BlockRef | null }> {
  return (arr || []).map((row) => ({ ...row, blockedBy: hitOf(row) }));
}

export async function addRule(input: unknown): Promise<BlockRule> {
  if (rules.length >= RULES_MAX) throw new Error(`at most ${RULES_MAX} rules`);
  const patch = validateRulePatch(input);
  const rule: BlockRule = { id: randomUUID(), addedAt: new Date().toISOString(), ...patch };
  rules.push(rule);
  rebuildIndex();
  await persist();
  refreshPlaylistMembers().catch((err) => console.warn(`[blocklist] playlist member refresh failed: ${err.message}`));
  return rule;
}

// Full-replace update (the editor round-trips the whole rule). Returns null
// when the id is unknown.
export async function updateRule(id: string, input: unknown): Promise<BlockRule | null> {
  const idx = rules.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const patch = validateRulePatch(input);
  const rule: BlockRule = { id, addedAt: rules[idx]!.addedAt, ...patch };
  rules[idx] = rule;
  rebuildIndex();
  await persist();
  refreshPlaylistMembers().catch((err) => console.warn(`[blocklist] playlist member refresh failed: ${err.message}`));
  return rule;
}

export async function removeRule(id: string): Promise<boolean> {
  const before = rules.length;
  rules = rules.filter((r) => r.id !== id);
  if (rules.length === before) return false;
  rebuildIndex();
  await persist();
  return true;
}

// Admin Blocked tab: each rule with whether it blocks right now (season + show
// scope) and how many of the caller's rows (db.ruleMatchRows()) it matches.
// matchCount is activity-agnostic ("what WOULD this block"), so a typo reads 0.
export function rulesWithStats(
  rows: any[],
): Array<BlockRule & { active: boolean; matchCount: number }> {
  const activeIds = new Set(activeCompiledRules().map((cr) => cr.rule.id));
  return compiledRules.map((cr) => {
    let matchCount = 0;
    for (const row of rows) {
      if (ruleMatches(cr, row, playlistMembers)) matchCount++;
    }
    return { ...cr.rule, active: activeIds.has(cr.rule.id), matchCount };
  });
}
