// The picker's per-pick scope + the context every discovery tool runs against.
//
// Scope is ONE value on purpose: every constraint a pick runs under travels from
// pickViaAgent (broadcast/dj-agent.ts) to the tools as a single `PickerScope`
// that is never destructured into per-field lists along the way. A lock named in
// one list and forgotten in another is neither a type error nor a crash — it
// falls through to a null default and stops being enforced on the agent path
// while the pool picker still honours it (#1300 FR 13, vocalLock). Adding a lock
// means adding a field here; do not reintroduce a per-field hand-off.

import * as library from '../../../../music/library.js';
import * as embeddings from '../../../../music/embeddings.js';
import { filterPickerCandidates } from '../../../../music/recency.js';
import { applyStrictLocks, type VocalMode } from '../../../../music/show-filter.js';
import { applyTrackFloor } from '../../../../music/track-floor.js';
import { freshnessBiasedOrder } from '../../../../music/airing.js';
import { SEED_NOT_A_PICK_CLAUSE } from '../../../../util/pick-seed.js';
import { slim } from './slim.js';

export interface PickerScope {
  recentIds: Set<string>;
  // lowercased "title|artist" — backfilled entries lack ids
  recentKeys: Set<string>;
  // Count-based HARD no-repeat set (last N distinct plays), non-relaxable: a
  // track here survives the starvation cascade, so the agent cannot re-pick a
  // just-played song. From queue.recentlyPlayedByCount(N); empty on the request
  // path (requests exempt).
  hardRecentIds: Set<string>;
  // lowercased "title|artist" — blocks id-less backfilled plays
  hardRecentKeys: Set<string>;
  // The five show locks below apply only for a strict show (one filtersStrict
  // toggle governs all of them), are any-of lists, and are HARD in collect() —
  // no per-tool never-starve. null/empty = no lock. None is set on the request
  // path: an explicit listener ask wins.
  genreLock: string[] | null;
  // Unknown-year tracks drop (#929).
  eraLock: { fromYear?: number | null; toYear?: number | null }[] | null;
  moodLock: string[] | null;
  // Analysed bands; unknowns drop.
  energyLock: string[] | null;
  vocalLock: VocalMode | null;
  // Minimum track length in seconds (#1573), show floor else station default,
  // resolved by settings.effectiveMinTrackSec. NOT gated on filtersStrict — it
  // is the twin of the max-track-length cap, which no show opts into either.
  // HARD here; the pool picker never-starves on the same floor behind it.
  // null = no floor, and not set on the request path.
  minTrackSec: number | null;
  // Union of a strict playlist-anchored show's pinned Navidrome playlists; every
  // tool's candidates are intersected with it, HARD with no never-starve to
  // off-playlist, because a playlist is an exact set and showPlaylistTracks is
  // the guaranteed in-set source. null = no lock; not set on the request path.
  playlistLock: Set<string> | null;
  // The show's playlist union tracks; registers the showPlaylistTracks tool. Set
  // in BOTH strict (with playlistLock) and soft (prompt preference only) modes.
  playlistTracks: any[] | null;
  // Ids from the show's excluded playlists, dropped from every tool's results so
  // the agent never sees a blocklisted track. null = no exclusions.
  excludedIds: Set<string> | null;
  // The active sonic journey's waypoint vector. When present the
  // tracksTowardJourney tool is registered closing over it, so the agent sees
  // only the tracks near it.
  audioWaypoint: number[] | null;
  // Request path only: registers identifyRequestedTrack. No-op unless a
  // web-search provider is ready. Never set on the per-track picker.
  resolveReferences: boolean;
}

// Every field defaults to "no constraint". Spread over a partial so there is
// exactly one place a new field's default lives.
const NO_SCOPE: PickerScope = {
  recentIds: new Set(),
  recentKeys: new Set(),
  hardRecentIds: new Set(),
  hardRecentKeys: new Set(),
  genreLock: null,
  eraLock: null,
  moodLock: null,
  energyLock: null,
  vocalLock: null,
  minTrackSec: null,
  playlistLock: null,
  playlistTracks: null,
  excludedIds: null,
  audioWaypoint: null,
  resolveReferences: false,
};

export function pickerScope(partial: Partial<PickerScope> = {}): PickerScope {
  return { ...NO_SCOPE, ...partial };
}

// What each tool module is handed: the scope plus the shared machinery — the
// `seen` accumulator, the filter/slim/record pipeline, the empty-result note
// builder, and the index-coverage flags the conditional tools gate on.
export interface PickerContext {
  scope: PickerScope;
  // id → slim song across all tool calls; the picker resolves the agent's final
  // id choice against this.
  seen: Map<string, any>;
  collect(list: any, cap?: number, opts?: { maxPerArtist?: number }): any[];
  emptyResult(matched: number, hint: string): { tracks: any[]; note: string; rule: string };
  seedSimilarity(songId: string, primary: 'audio' | 'text'): { tracks: any[]; matched: number; fellBack: boolean };
  // Id-level union of the recency sets, pushed INTO KNN queries. The key-based
  // sets can't ride along (vec0 rows carry only ids); collect() catches those
  // post-hoc.
  knnExclude: Set<string>;
  stats: { total?: number; withEmbedding?: number; withAudioEmbedding?: number; [k: string]: any };
  hasTextEmbeddings: boolean;
  hasAudioEmbeddings: boolean;
  hasEmbeddingProvider: boolean;
  // True when most of the text index is label-only vectors, i.e. "semantic
  // similarity" is really artist-string proximity. The text-similarity tools
  // adjust their descriptions accordingly.
  textIndexDegraded: boolean;
}

export function buildPickerContext(scope: PickerScope): PickerContext {
  const {
    recentIds, recentKeys, hardRecentIds, hardRecentKeys,
    genreLock, eraLock, moodLock, energyLock, vocalLock,
    minTrackSec, playlistLock, excludedIds,
  } = scope;

  const seen = new Map<string, any>();

  // Pushed into every KNN query so a heavily-aired cluster answers with its next
  // neighbours out instead of thinning toward empty.
  const knnExclude: Set<string> = new Set([...recentIds, ...hardRecentIds]);

  // Filter recents, slim, and record into `seen` so the picker can resolve the
  // agent's final id choice to a full track. Drops recently-played tracks (by
  // id/key) and tracks already surfaced this pick; artists are NOT filtered (see
  // the buildPickerTools note in index.ts). cap=8 keeps per-tool input tokens
  // down; `seen` still accumulates across the whole loop.
  //
  // `maxPerArtist` (default 3) is a CAP, deliberately not an artist-recency strip
  // (#618 — a strip gutted the similarity tools to ~1 survivor on niche
  // catalogues): one artist just can't fill all 8 slots, which is what a
  // label-only embedding index does on a keyless install. The two single-artist
  // tools (topSongsByArtist, recentByArtist) opt out. A strict PLAYLIST show opts
  // out wholesale — playlistLock has already intersected the pool with the
  // operator's pinned set, and a single-artist playlist is the point of pinning.
  const collect = (list: any, cap = 8, opts: { maxPerArtist?: number } = {}) => {
    // Strict show: filter BEFORE recency + cap, so the 8 the agent sees are
    // genre-/era-/mood-/energy-pure. Each lock is HARD (starve:true) — a tool
    // with no match contributes nothing and emptyResult steers the model
    // elsewhere. Dead-air is guarded at wider scopes: a run with zero candidates
    // falls to the pool picker, and behind that the auto.m3u coast. The locks are
    // pre-resolved and coverage-gated in pickViaAgent, so an un-analysed library
    // can't starve every tool for the whole show.
    //
    // Ordering is a freshness-biased shuffle (music/airing.ts): a KNN tool's
    // top-60 must not reach the model in similarity order, or the cap of 8 pins
    // the same neighbours every pick. Randomness stays dominant; with no play
    // history this is a plain shuffle.
    let pool = applyStrictLocks(freshnessBiasedOrder((list || []) as any[], library.lastAiredInfo(), Date.now()), {
      genres: genreLock, eras: eraLock, moods: moodLock, energies: energyLock, vocals: vocalLock,
    }, { starve: true });
    // Minimum track length (#1573): hard, and BEFORE the playlist lock, so a
    // pinned playlist's own 40-second interlude drops too — the floor is about
    // what the station will AIR, not which source a track came from.
    pool = applyTrackFloor(pool, minTrackSec, { starve: true });
    if (playlistLock) pool = pool.filter((s: any) => s?.id && playlistLock.has(s.id));
    // Blocklisted playlists drop AFTER the playlist lock, so exclusion overrides
    // the anchor. No never-starve: a show that excludes its whole pool leaves
    // `seen` empty and the LLM pick is skipped, with the auto.m3u coast behind it.
    if (excludedIds) pool = pool.filter((s: any) => s?.id && !excludedIds.has(s.id));
    const accepted = filterPickerCandidates(pool, {
      recentIds,
      recentKeys,
      hardRecentIds,
      hardRecentKeys,
      seenIds: new Set(seen.keys()),
      maxPerArtist: opts.maxPerArtist ?? (playlistLock ? Infinity : 3),
      cap,
    });
    const out: any[] = [];
    for (const s of accepted) {
      const slimmed = slim(s);
      seen.set(s.id, slimmed);
      out.push(slimmed);
    }
    return out;
  };

  // On an empty tool result, say WHY and what to try next: a bare [] draws a
  // fabricated id. `matched` is the pre-recency-filter count, so the note can
  // distinguish "nothing matches" from "matches exist but were all filtered" —
  // opposite next moves. A strict lock is anything that can drop a candidate the
  // source DID return, so all of them count here, not just recency.
  const hasStrictLock = !!(genreLock?.length || eraLock?.length || moodLock?.length || energyLock?.length || vocalLock || playlistLock || excludedIds || minTrackSec);
  // The seed clause rides here as well as on the schema field (#1247): this is
  // the message in context at the moment the model fails, and "never invent a
  // song id" is satisfied by echoing the on-air seed. Wording from
  // util/pick-seed.ts.
  const emptyResult = (matched: number, hint: string) => ({
    tracks: [] as any[],
    note: matched > 0
      ? `${matched} matching track(s) exist but were all played recently, already shown this pick${hasStrictLock ? ', or outside this show\'s strict filters' : ''} — ${hint}`
      : hint,
    rule: `Never invent a song id — only ids returned by a tool are valid picks. ${SEED_NOT_A_PICK_CLAUSE}`,
  });

  // Index counts snapshotted once at tool-build time; pickViaAgent awaits
  // library.load() first, so stats() never returns its empty-sentinel zeros
  // here. Tools whose backing index is empty are conditionally registered —
  // offering a dead tool spends the discovery call on a guaranteed-empty result.
  const stats = library.stats();
  const hasTextEmbeddings = (stats.withEmbedding ?? 0) > 0;
  const hasAudioEmbeddings = (stats.withAudioEmbedding ?? 0) > 0;
  const hasEmbeddingProvider = embeddings.isAvailable();
  // Same 50% threshold the coverage UI calls similarityThin.
  const labelShare = library.labelOnlyShare();
  const textIndexDegraded = labelShare != null && labelShare > 0.5;

  // Seed-similarity with a cross-index rescue (#1247). An empty seed tool corners
  // a forced-tool provider — it gets one discovery call, and the only well-formed
  // id left in context is the on-air seed. Index registration keys on whether an
  // index holds ANY vectors, never on whether it covers THIS seed, and coverage
  // is routinely partial, so answer from the other index and say so.
  //
  // Gated on the primary returning NOTHING AT ALL (no vector for the seed). A
  // primary that matched but was filtered by recency keeps emptyResult, whose
  // note steers correctly and describes a different situation.
  const seedSimilarity = (songId: string, primary: 'audio' | 'text') => {
    const K = 60;
    const audioFirst = primary === 'audio';
    const lookup = (which: 'audio' | 'text') =>
      which === 'audio'
        ? library.tracksLikeThisAudio(songId, K, { excludeIds: knnExclude })
        : library.tracksLikeThis(songId, K, { excludeIds: knnExclude });
    const list = lookup(primary);
    if (list.length) return { tracks: collect(list), matched: list.length, fellBack: false };
    const other = audioFirst ? 'text' : 'audio';
    const otherIndexed = audioFirst ? hasTextEmbeddings : hasAudioEmbeddings;
    if (otherIndexed) {
      const alt = lookup(other);
      if (alt.length) {
        const rescued = collect(alt);
        // Only report the rescue if something SURVIVED the recency/lock filters.
        // A raw alt count with empty tracks would render emptyResult's matched>0
        // note about an index the model never asked, glued to a "no embedding
        // yet" hint about the one it did. Falling through to 0 keeps it coherent.
        if (rescued.length) return { tracks: rescued, matched: alt.length, fellBack: true };
      }
    }
    return { tracks: [] as any[], matched: 0, fellBack: false };
  };

  return { scope, seen, collect, emptyResult, seedSimilarity, knnExclude, stats, hasTextEmbeddings, hasAudioEmbeddings, hasEmbeddingProvider, textIndexDegraded };
}
