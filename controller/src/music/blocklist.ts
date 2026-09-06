// Global never-play blocklist — station-level "never let this air" entries at
// track/album/artist granularity, persisted to <stateDir>/blocklist.json
// (sibling to schedule.json; deliberately NOT in library.db so Library →
// Reset/Reconcile can't wipe it). Enforced through isBlocked() at the subsonic
// reject chokepoint, the library-db song sources, and the final queue.push() gate.
//
// matchOf() is the one matcher; isBlocked() is a predicate over it. The admin
// listing surfaces use annotate() instead of rejectBlocked(), so the operator
// can SEE a blocked track and which entry blocks it, rather than wondering why
// one of two identical songs never airs.
//
// Matching is id-first (song.id / albumId / artistId), with a normalised-name
// fallback for album/artist entries because library-db rows carry only name
// strings — without it an artist block would leak through the mood/vector
// sources. Track entries never name-match (covers/re-recordings share titles).
//
// RULE entries (#1300 FR 1, closes #752) live beside the id entries in the same
// file: attribute/tag predicates ("anything tagged christmas"), an optional
// seasonal allow-window, an optional show scope. Pure matching lives in
// blocklist-rules.ts; this module owns state, persistence, and the evaluation
// context (station-zone clock, active show, playlist member sets). Since every
// song source already flows through rejectBlocked/isBlocked, rules are enforced
// at every chokepoint the id entries cover with zero new enforcement sites.
// hitOf() is the one entries-then-rules answer.
import { config } from '../config.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../util/atomic-file.js';
import { zonedParts } from '../time.js';
import { resolveActiveShow } from '../settings.js';
import { resolvePlaylistMemberSets } from './show-playlist.js';
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

// The slice of a match a listing row needs: enough to render the badge and to
// issue the DELETE (or open the rule editor) that clears it. Rides admin
// listing rows as `blockedBy`. Entries keep their historical {type,id,name}
// shape (plus the kind discriminant); rule refs carry the rule's display
// surface — `seasonal` so the UI can say "lifts on Dec 1" territory vs a
// permanent block.
export type BlockRef =
  | { kind: 'entry'; type: BlockType; id: string; name: string | null }
  | { kind: 'rule'; field: RuleField; id: string; label: string; seasonal: boolean };

export interface BlockEntry {
  type: BlockType;
  id: string;
  // Display snapshots for the admin Blocked tab (and the name-fallback match) —
  // no Navidrome re-lookup needed to render or enforce the list.
  name: string | null;
  artist: string | null;
  album: string | null;
  addedAt: string;
  // The exact song.path this entry also wrote into
  // <NEVER_PLAY_LIBRARY_PATH>/.ndignore (music/never-play-ignore.ts), or null
  // when that feature was disabled/unavailable/inapplicable at block time.
  // Set only by broadcast/never-play-again.ts (POST /dj/never-play-again) —
  // the plain admin Blocked-tab / POST /library/blocklist path never sets it.
  // Persisted so DELETE /library/blocklist/:type/:id can reverse both halves.
  libraryPath?: string | null;
}

const FILE_PATH = `${config.stateDir}/blocklist.json`;

let entries: BlockEntry[] = [];
let rules: BlockRule[] = [];
let compiledRules: CompiledRule[] = [];
let loaded = false;

// In-memory match index, rebuilt on every mutation. Maps rather than Sets
// because matchOf() has to name the entry that matched, so the admin UI can
// offer to remove exactly that one. Lookup stays synchronous and O(1) — it
// sits inside hot candidate-pool filters.
let trackIds = new Map<string, BlockEntry>();
let albumIds = new Map<string, BlockEntry>();
let artistIds = new Map<string, BlockEntry>();
let artistNames = new Map<string, BlockEntry>();   // normalised
let albumKeys = new Map<string, BlockEntry>();     // normalised album + KEY_SEP + artist

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// Album keys join two free-text fields, so the separator must be a character
// neither can contain - otherwise ("a b", "c") and ("a", "b c") collide. It was
// a bare NUL typed into the source, invisible in every editor and in the comment
// beside it; naming it keeps the two call sites greppable and safe to edit. The
// index is in-memory only, so the value is free to change.
const KEY_SEP = '\u0000';
const albumKey = (album: unknown, artist: unknown) => `${norm(album)}${KEY_SEP}${norm(artist)}`;

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
      if (e.name) artistNames.set(norm(e.name), e);
    }
  }
  // Rule side: value normalisation happens once per mutation, and the
  // active-set memo below re-derives from the fresh compile.
  compiledRules = compileRules(rules);
  ruleCtxCache = null;
}

// ── Rule evaluation context ─────────────────────────────────────────────────

// The active-rule subset is a function of the station-zone clock and the
// on-air show, neither of which changes per track — so it's computed at most
// once per RULE_CONTEXT_TTL_MS, not per matchOf() call. rejectBlocked sweeps
// hundreds of tracks through the chokepoints; a per-track zonedParts (an Intl
// formatToParts round-trip) would dominate the cost of the match itself. The
// TTL bounds season/show-boundary staleness at 15s, well inside the accepted
// boundary races (spec: pick/push-time evaluation, minutes-wide).
const RULE_CONTEXT_TTL_MS = 15_000;
let ruleCtxCache: { at: number; active: CompiledRule[] } | null = null;

function activeCompiledRules(): CompiledRule[] {
  if (!compiledRules.length) return [];
  const now = Date.now();
  if (ruleCtxCache && now - ruleCtxCache.at < RULE_CONTEXT_TTL_MS) return ruleCtxCache.active;
  const { month, day } = zonedParts(new Date(now));
  // Settings may not be loaded in auxiliary processes (tagger child) — a
  // failed resolve reads as "no show on air", which leaves show-scoped rules
  // inert (under-blocking in a listing context, never over-blocking).
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

// ── Playlist member sets (field: 'playlist' rules) ──────────────────────────

// The one async-sourced matcher input, pre-resolved into module state so
// matchOf stays synchronous. Refreshed on load, on rule mutation, and lazily
// on a 30-min TTL (the same horizon show-playlist's memo uses — and the fetch
// IS show-playlist's memoised getPlaylist, so a playlist used as both anchor
// and rule is fetched once). A stale/deleted playlist id resolves to nothing:
// the rule is inert for that id rather than wrong.
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
      libraryPath: typeof e.libraryPath === 'string' && e.libraryPath ? e.libraryPath : null,
    }));
    // Rules: pre-rules files carry no `rules` key → []. Records that don't
    // parse are dropped (state files never block boot), loudly.
    const rawRules = Array.isArray(raw?.rules) ? raw.rules : [];
    rules = rawRules.map(coerceStoredRule).filter((r: BlockRule | null): r is BlockRule => r !== null);
    if (rules.length < rawRules.length) {
      console.error(`[blocklist] dropped ${rawRules.length - rules.length} unparseable rule(s) from blocklist.json`);
    }
  } catch (err: any) {
    // Missing file is the normal first-boot case; anything else (corrupt JSON)
    // starts empty rather than blocking boot — the station keeps playing.
    if (err?.code !== 'ENOENT') console.error('[blocklist] load failed, starting empty:', err.message);
    entries = [];
    rules = [];
  }
  rebuildIndex();
  if (entries.length || rules.length) {
    console.log(`[blocklist] loaded ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
  }
  // Playlist-rule member sets need Subsonic; never block boot on it. A miss
  // leaves those rules inert until the lazy TTL refresh lands.
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

// "Nothing can block anything" — the hot-path skip. A seasonal rule currently
// in season still counts as non-empty (activity is the memo's business, and
// cheapness comes from the compiled index, not from pretending the list is
// empty).
export function isEmpty(): boolean {
  return entries.length === 0 && rules.length === 0;
}

// Add an entry; returns it, or null when (type, id) is already blocked.
export async function add(input: { type: BlockType; id: string; name?: string | null; artist?: string | null; album?: string | null; libraryPath?: string | null }): Promise<BlockEntry | null> {
  if (entries.some((e) => e.type === input.type && e.id === input.id)) return null;
  const entry: BlockEntry = {
    type: input.type,
    id: input.id,
    name: input.name ?? null,
    artist: input.artist ?? null,
    album: input.album ?? null,
    addedAt: new Date().toISOString(),
    libraryPath: input.libraryPath ?? null,
  };
  entries.push(entry);
  rebuildIndex();
  await persist();
  return entry;
}

// Direct (type, id) lookup — an exact key read, unlike matchOf() which takes
// a song-shaped row and applies the id-then-name precedence. Used by the
// never-play-again unblock path (routes/library.ts) to read an entry's
// libraryPath before remove() discards it.
export function getEntry(type: BlockType, id: string): BlockEntry | null {
  return entries.find((e) => e.type === type && e.id === id) ?? null;
}

// Narrow update: set (or clear) ONLY libraryPath on an existing entry —
// never addedAt, name, artist or album — so an "already blocked" hit in
// never-play-again (routes/dj.ts) can be UPGRADED with the Navidrome-side
// exclusion path once it resolves, without a remove()+add() round trip that
// would mint a new addedAt and briefly make the track unblocked. A no-op
// (returns the entry unchanged, no write) when the value already matches, so
// re-running never-play-again on an already-upgraded entry costs nothing.
// Returns null when (type, id) isn't blocked at all — mirrors getEntry().
export async function setLibraryPath(type: BlockType, id: string, libraryPath: string | null): Promise<BlockEntry | null> {
  const entry = entries.find((e) => e.type === type && e.id === id);
  if (!entry) return null;
  if (entry.libraryPath === libraryPath) return entry;
  entry.libraryPath = libraryPath;
  // libraryPath plays no part in trackIds/albumIds/artistIds/name-fallback
  // matching, so no rebuildIndex() is needed — only the persisted snapshot
  // needs to change.
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

// Bulk unblock, one rewrite and one persist. Deliberately not N concurrent
// remove() calls: each filters `entries` synchronously but persists on a later
// tick, so two in flight can land the file in the earlier of the two states.
// Reports what was actually removed and what was already gone.
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

// Which entry blocks this row, or null. Accepts anything song-shaped — a raw
// Subsonic song (id/albumId/artistId/artist/album) or a library-db row
// (id/artist/album only). Synchronous and cheap; isEmpty() lets hot paths skip
// mapping work.
//
// The order below is the answer's contract, not an implementation detail: the
// admin UI names the matched entry and offers to remove exactly it, so the same
// row must always resolve to the same entry. Ids first, then the name fallback
// for rows without Subsonic ids (library-db sources, queue items) — artist by
// name, album by (name, artist) pair so generic titles like "Greatest Hits"
// can't cross-match another artist's album.
export function matchOf(song: any): BlockEntry | null {
  if (!song || entries.length === 0) return null;
  return (
    (song.id ? trackIds.get(song.id) : undefined)
    ?? (song.albumId ? albumIds.get(song.albumId) : undefined)
    ?? (song.artistId ? artistIds.get(song.artistId) : undefined)
    ?? (artistNames.size && song.artist ? artistNames.get(norm(song.artist)) : undefined)
    ?? (albumKeys.size && song.album ? albumKeys.get(albumKey(song.album, song.artist)) : undefined)
    ?? null
  );
}

// Which ACTIVE rule blocks this row, or null. First match in list order —
// stable per mutation, so the badge a row shows doesn't wander between polls.
export function ruleMatchOf(song: any): BlockRule | null {
  const active = activeCompiledRules();
  if (!active.length || !song) return null;
  for (const cr of active) {
    if (ruleMatches(cr, song, playlistMembers)) return cr.rule;
  }
  return null;
}

// The one enforcement/visibility answer: id/name entries first (most
// specific — the UI names the entry and unblocks exactly it), then active
// rules. Every consumer that needs to SAY what blocked a track reads this;
// isBlocked is a predicate over it.
export function hitOf(song: any): BlockRef | null {
  const entry = matchOf(song);
  if (entry) return refOf(entry);
  const rule = ruleMatchOf(song);
  return rule ? ruleRefOf(rule) : null;
}

// The enforcement predicate.
export function isBlocked(song: any): boolean {
  return hitOf(song) !== null;
}

// Display slice of an entry — what a listing row carries as `blockedBy`.
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

// The opposite of rejectBlocked, for the ADMIN listing surfaces: keep every row
// and stamp what blocks it — an id entry or a currently-active rule. The
// library browser shows the library — the operator has to be able to see a
// blocked track in order to review or unblock it, and without this marking two
// copies of the same song on different albums are indistinguishable. Always
// stamps the field, null when clear — one row shape whether or not the station
// blocks anything.
export function annotate<T extends object>(arr: T[]): Array<T & { blockedBy: BlockRef | null }> {
  return (arr || []).map((row) => ({ ...row, blockedBy: hitOf(row) }));
}

// ── Rule CRUD ───────────────────────────────────────────────────────────────

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

// Listing surface for the admin Blocked tab: each rule with whether it is
// blocking RIGHT NOW (season + show scope) and how many of the caller's rows
// it matches. matchCount is deliberately activity-AGNOSTIC — "what would this
// rule block" — so a typo'd value reads 0 and a seasonal rule shows its reach
// while in season. The caller supplies the rows (db.ruleMatchRows()); this
// module doesn't reach into library-db.
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
