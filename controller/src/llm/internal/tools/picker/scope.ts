// The picker's per-pick scope + the context every discovery tool runs against.
//
// SCOPE IS ONE VALUE, ON PURPOSE. Every constraint a pick runs under — recency
// sets, strict show locks, the playlist anchor, the journey waypoint — travels
// from pickViaAgent (broadcast/dj-agent.ts) to the tools as a single
// `PickerScope` object that is never destructured into fields along the way.
//
// That fixes a real defect class, not a style preference. The old shape passed
// ~13 keys through an untyped args bag, listed three times over (pickViaAgent,
// agents.ts's destructure, the buildPickerTools call). A lock named in one list
// and forgotten in another was neither a type error nor a crash — it fell
// through to a `null` default and that whole dimension silently stopped being
// enforced on the agent path while the pool picker still honoured it, so the two
// pick paths disagreed about the same show. That happened for real (#1300 FR 13,
// vocalLock) and needed a source-scraping test to catch, because there was no
// runtime seam between "passed" and "destructured".
//
// With one object there are no lists to disagree. Adding a lock means adding a
// field here; nothing downstream re-names it. Do NOT reintroduce a per-field
// hand-off "for readability" — that is the bug.

import * as library from '../../../../music/library.js';
import * as embeddings from '../../../../music/embeddings.js';
import { filterPickerCandidates } from '../../../../music/recency.js';
import { applyStrictLocks, type VocalMode } from '../../../../music/show-filter.js';
import { freshnessBiasedOrder } from '../../../../music/airing.js';
import { SEED_NOT_A_PICK_CLAUSE } from '../../../../util/pick-seed.js';
import { slim } from './slim.js';

export interface PickerScope {
  recentIds: Set<string>;
  // lowercased "title|artist" — backfilled entries lack ids
  recentKeys: Set<string>;
  // Count-based HARD no-repeat set (last N distinct plays). Non-relaxable — a
  // track in here is filtered out of every tool's results and survives the
  // starvation cascade, so the agent literally cannot re-pick a just-played
  // song even when a thin similarity cluster is all it can see. Populated from
  // queue.recentlyPlayedByCount(N); empty on the request path (requests exempt).
  hardRecentIds: Set<string>;
  // lowercased "title|artist" — blocks id-less backfilled plays
  hardRecentKeys: Set<string>;
  // Hard genre constraint for a strict show (show.filtersStrict) — a list of
  // genres, any-of (#929). When set, every tool's candidates are genre-filtered
  // (onlyGenre — HARD, no per-tool never-starve; see the collect() note) before
  // recency + cap, so the agent path enforces the lock in code, not just the
  // prompt. null/empty = no lock. Deliberately NOT set on the request path: an
  // explicit listener ask wins.
  genreLock: string[] | null;
  // Hard era constraint — a list of decade/year windows, any-of (#929) —
  // applied only for a strict show (same filtersStrict flag — one toggle
  // governs every filter). When set, candidates are year-filtered (inYearRange
  // — HARD, unknown-year tracks drop) before recency + cap. null/empty = no lock.
  eraLock: { fromYear?: number | null; toYear?: number | null }[] | null;
  // Hard mood constraint for a strict show — any-of list: candidates are
  // filtered to tracks tagged with any of the show's moods (onlyMood — HARD).
  // null/empty = no lock.
  moodLock: string[] | null;
  // Hard energy-band constraint for a strict show — any-of list: candidates
  // are filtered to the analysed bands (onlyEnergy — HARD, unknowns dropped).
  energyLock: string[] | null;
  vocalLock: VocalMode | null;
  // Hard playlist constraint for a strict playlist-anchored show. The id set is
  // the union of the show's pinned Navidrome playlists; when set, every tool's
  // candidates are intersected with it (HARD — no never-starve to off-playlist,
  // unlike genreLock, because a playlist is an exact set and the showPlaylistTracks
  // tool is the guaranteed in-set source). So the agent's `seen` map only ever
  // holds playlist tracks — it cannot return an off-playlist id. null = no lock.
  // Deliberately NOT set on the request path: an explicit listener ask wins.
  playlistLock: Set<string> | null;
  // The show's playlist union tracks. Registers the showPlaylistTracks tool —
  // the agent's window into the operator's curation. Set in BOTH strict (with
  // playlistLock) and soft (no lock, just a strong prompt preference) modes.
  playlistTracks: any[] | null;
  // Track ids from the show's excluded playlists (blocklist). Any track whose
  // id is in this set is dropped from every tool's results so the agent never
  // sees — and can never pick — a blocklisted track. null = no exclusions.
  excludedIds: Set<string> | null;
  // The active sonic journey's current waypoint vector (broadcast/dj-agent.ts).
  // When present, the tracksTowardJourney tool is registered, closing over it —
  // the agent never sees the raw vector, only the tracks near it.
  audioWaypoint: number[] | null;
  // Request path only (djAgentRequest): registers identifyRequestedTrack, which
  // resolves a DESCRIBED track via web search and matches it to the LOCAL
  // library. No-op unless a web-search provider is ready (searchReady()). Never
  // set on the per-track picker — see the gating note on that tool.
  resolveReferences: boolean;
}

// Every field defaults to "no constraint", so a caller states only what it
// actually constrains. Spread over a partial rather than defaulted per-parameter
// so there is exactly ONE place a new field's default lives.
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
  playlistLock: null,
  playlistTracks: null,
  excludedIds: null,
  audioWaypoint: null,
  resolveReferences: false,
};

export function pickerScope(partial: Partial<PickerScope> = {}): PickerScope {
  return { ...NO_SCOPE, ...partial };
}

// What each tool module is handed. Holds the scope plus the shared machinery
// every tool needs: the `seen` accumulator, the filter/slim/record pipeline, the
// empty-result note builder, and the index-coverage flags the conditional tools
// gate on.
export interface PickerContext {
  scope: PickerScope;
  // id → slim song, accumulated across all tool calls. The picker resolves the
  // agent's final id choice against this.
  seen: Map<string, any>;
  collect(list: any, cap?: number, opts?: { maxPerArtist?: number }): any[];
  emptyResult(matched: number, hint: string): { tracks: any[]; note: string; rule: string };
  seedSimilarity(songId: string, primary: 'audio' | 'text'): { tracks: any[]; matched: number; fellBack: boolean };
  // Id-level union of the recency sets (recentIds + hardRecentIds), for
  // pushing INTO KNN queries (library.tracksByVector et al) — the key-based
  // sets can't ride along (vec0 rows carry only ids); collect() still catches
  // those post-hoc.
  knnExclude: Set<string>;
  stats: { total?: number; withEmbedding?: number; withAudioEmbedding?: number; [k: string]: any };
  hasTextEmbeddings: boolean;
  hasAudioEmbeddings: boolean;
  hasEmbeddingProvider: boolean;
  // True when most of the text index is label-only vectors (artist/title/album
  // text with no tags/lyrics/acoustics), i.e. "semantic similarity" is really
  // artist-string proximity. The text-similarity tools adjust their
  // descriptions so the model weighs their results for what they actually are.
  textIndexDegraded: boolean;
}

export function buildPickerContext(scope: PickerScope): PickerContext {
  const {
    recentIds, recentKeys, hardRecentIds, hardRecentKeys,
    genreLock, eraLock, moodLock, energyLock, vocalLock,
    playlistLock, excludedIds,
  } = scope;

  const seen = new Map<string, any>();

  // See the PickerContext note: the id-level recency union, pushed into every
  // KNN query so a heavily-aired cluster answers with its next neighbours out
  // instead of thinning toward empty.
  const knnExclude: Set<string> = new Set([...recentIds, ...hardRecentIds]);

  // Filter recents, slim, and record into `seen` so the picker can resolve
  // the agent's final id choice to a full track. Drops only recently-played
  // tracks (by id/key) and tracks already surfaced this pick; artists are NOT
  // filtered (see the buildPickerTools note in index.ts). cap=8 keeps per-tool
  // input tokens lower for the picker agent — see picker-latency notes in
  // dj-agent.js. The seen map still accumulates across the whole loop, so the
  // agent's id space grows with each tool call regardless.
  // `maxPerArtist` (default 3) is a CAP, deliberately not an artist-recency
  // strip (#618 — a strip gutted the similarity tools to ~1 survivor on niche
  // catalogues): a similarity tool may still surface the seed artist's
  // neighbours, it just can't fill all 8 slots with one artist — which is
  // exactly what a label-only embedding index does on a keyless install, where
  // "semantic similarity" degrades to artist-string matching. The two
  // single-artist tools (topSongsByArtist, recentByArtist) opt out: capping
  // them would neuter the question they exist to answer.
  //
  // A strict PLAYLIST show opts out wholesale, for the same reason and at the
  // same seam as music/picker.ts: `playlistLock` below hard-intersects every
  // tool's pool with the operator's pinned set BEFORE this filter runs, so what
  // survives is already an exact hand-picked universe — a single-artist or
  // single-album playlist is the point of pinning it, not an artist dominating
  // a discovery pool. With the cap on, a show pinned to one artist handed the
  // agent 3 tracks from showPlaylistTracks (of a cap of 12) and 3 from every
  // other tool, which is the fallback pool picker's bug on the DEFAULT path.
  const collect = (list: any, cap = 8, opts: { maxPerArtist?: number } = {}) => {
    // Strict show: filter candidates BEFORE recency + cap, so the 8 the agent
    // sees are genre-/era-/mood-/energy-pure. Each lock is HARD (starve:true) —
    // a tool whose results contain no match contributes nothing (emptyResult
    // steers the model to another tool), mirroring playlistLock below. The old
    // per-tool never-starve passed a tool's ENTIRE unfiltered result through on
    // zero matches; the similarity tools cluster on the (possibly off-filter)
    // current track, so strict shows leaked off-filter picks constantly.
    // Dead-air is still guarded at wider scopes: a run with zero candidates
    // fails into the pool picker (which never-starves on its final pool), and
    // behind that the auto.m3u coast. The locks are pre-resolved + coverage-
    // gated in pickViaAgent (genres → library tags, mood/energy dropped when the
    // library has no such tags) so an un-analysed library can't starve every
    // tool for the whole show.
    //
    // The ordering is a freshness-biased shuffle (music/airing.ts): a random
    // base per candidate — a KNN tool's top-60 must not reach the model in
    // similarity order, or the cap of 8 pins the same nearest neighbours every
    // pick — nudged up for tracks the station has never aired or hasn't aired
    // in weeks, so the cap favours the library's unexplored shelf. Randomness
    // stays dominant; with no play history this IS a plain shuffle.
    let pool = applyStrictLocks(freshnessBiasedOrder((list || []) as any[], library.lastAiredInfo(), Date.now()), {
      genres: genreLock, eras: eraLock, moods: moodLock, energies: energyLock, vocals: vocalLock,
    }, { starve: true });
    // Strict playlist: HARD-intersect with the lock set, with NO never-starve to
    // off-playlist (a playlist is an exact set, so a tool with no overlap simply
    // contributes nothing). The guaranteed in-set source is showPlaylistTracks,
    // so `seen` is normally non-empty and the agent's pick is in-playlist
    // — unless the blocklist below drops it too (see next).
    if (playlistLock) pool = pool.filter((s: any) => s?.id && playlistLock.has(s.id));
    // Excluded playlists (blocklist): hard-drop tracks from any blocklisted
    // playlist, AFTER the playlist lock so it overrides the anchor (this runs on
    // every source, showPlaylistTracks included). No never-starve: if a show
    // excludes its whole pool `seen` can end up empty and the LLM pick is
    // skipped — the auto.m3u coast (scheduler.ts) is the dead-air backstop.
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

  // When a tool comes up empty, say WHY and what to try next instead of a bare
  // [] — the observed fabrication pattern is "tool returned nothing → model
  // invents a plausible-looking id anyway" (7 of gpt-5-mini's 32 picks in one
  // day). `matched` is the pre-recency-filter count, so the note distinguishes
  // "nothing matches" from "matches exist but were all played recently or
  // already shown this pick" — opposite next moves for the model.
  // A strict lock is anything that can drop a candidate the source DID return:
  // the music filters, the playlist intersection, and the blocklist. Any of
  // them makes "matches exist but were filtered" a real cause the note should
  // name, not just recency.
  const hasStrictLock = !!(genreLock?.length || eraLock?.length || moodLock?.length || energyLock?.length || vocalLock || playlistLock || excludedIds);
  // The seed clause rides HERE as well as on the schema field (#1247): this is
  // the message sitting in the model's context at the exact moment it fails, and
  // "never invent a song id" is literally satisfied by echoing the on-air id
  // from the event message — a real id, just not one a tool returned. Shared
  // wording from util/pick-seed.ts.
  const emptyResult = (matched: number, hint: string) => ({
    tracks: [] as any[],
    note: matched > 0
      ? `${matched} matching track(s) exist but were all played recently, already shown this pick${hasStrictLock ? ', or outside this show\'s strict filters' : ''} — ${hint}`
      : hint,
    rule: `Never invent a song id — only ids returned by a tool are valid picks. ${SEED_NOT_A_PICK_CLAUSE}`,
  });

  // Snapshot the embedding index counts once at tool-build time (synchronous
  // after library.load() — pickViaAgent awaits library.load() before reaching
  // buildPickerTools, so stats() never returns its empty-sentinel zeros here).
  // Tools whose backing index is empty are conditionally registered: offering a
  // dead tool steers the model into a ~75 s timeout before the pool-fallback
  // rescues it (the "DJ Latency 75s" spike, 18% pick failure).
  const stats = library.stats();
  const hasTextEmbeddings = (stats.withEmbedding ?? 0) > 0;
  const hasAudioEmbeddings = (stats.withAudioEmbedding ?? 0) > 0;
  const hasEmbeddingProvider = embeddings.isAvailable();
  // Same 50% threshold the coverage UI calls similarityThin.
  const labelShare = library.labelOnlyShare();
  const textIndexDegraded = labelShare != null && labelShare > 0.5;

  // Seed-similarity with a cross-index rescue (#1247).
  //
  // An empty seed tool is far more expensive than a slow one: on a forced-tool
  // provider the harness allows exactly ONE discovery call and then pins
  // activeTools to `done`, so an empty result corners the model with nothing to
  // commit — and the only real, well-formed track id in its context is the
  // on-air seed it was handed. Both salvage stages in pickViaAgent then no-op on
  // an empty `seen`, so the whole run is discarded to the pool picker.
  //
  // Both indexes answer the same question, and each is registered on whether it
  // holds ANY vectors — never on whether it covers THIS seed. Coverage is
  // routinely partial and uneven (CLAP backfills over days; the text index needs
  // the tagger to have reached the track), so the seed falling in the other
  // index's gap is ordinary. When the index the model reached for doesn't cover
  // the seed, answer from the other one and SAY so, rather than handing back a
  // result that can only end the run.
  //
  // Deliberately gated on the primary index returning NOTHING AT ALL (matched
  // === 0 — the seed has no vector there). A primary that DID match but whose
  // hits were all filtered by recency keeps today's emptyResult: that note
  // ("N exist but were all played recently") steers the model correctly and is a
  // different situation from a dead index.
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
        // Only report the rescue if something SURVIVED the recency/lock
        // filters. Reporting the raw alt count with empty tracks would render
        // emptyResult's matched>0 message — "N exist but were all played
        // recently" — about hits from an index the model never asked, glued to
        // a "no embedding yet" hint about the one it did: two contradictory
        // clauses. Falling through to matched 0 keeps the coherent hint, whose
        // "try similarSongs / tracksByMood" steer is right here anyway.
        if (rescued.length) return { tracks: rescued, matched: alt.length, fellBack: true };
      }
    }
    return { tracks: [] as any[], matched: 0, fellBack: false };
  };

  return { scope, seen, collect, emptyResult, seedSimilarity, knnExclude, stats, hasTextEmbeddings, hasAudioEmbeddings, hasEmbeddingProvider, textIndexDegraded };
}
