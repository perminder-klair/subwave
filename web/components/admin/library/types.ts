 
import type { TaggerState, LibraryStatsLite, BudgetMode } from '../LibraryTaggingPanel';

export interface Track {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  // Era surface (#842/#1418). `year` is the FILE's year (a reissue's date on an
  // anthology); `originalYear` is the resolved recording year and
  // `originalYearSource` is 'album-tag' | 'musicbrainz' | 'manual' (manual wins).
  // Absent on an older controller.
  originalYear?: number | null;
  originalYearSource?: string | null;
  // Navidrome's raw compilation flag plus the station's derived verdict (#1418);
  // an anthology can have the flag unset. Era resolution treats either as
  // "the year is the release's".
  isCompilation?: boolean | null;
  eraUntrusted?: boolean | null;
  genre?: string | null;
  duration?: number | null;
  moods?: string[];
  energy?: string | null;
  source?: string | null;
  taggedAt?: string;
  // Null/undefined until the analyze pass runs.
  bpm?: number | null;
  musicalKey?: string | null;
  loudnessLufs?: number | null;
  paceMean?: number | null;
  instrumental?: boolean | null;
  // Cosine match vs the query — only on sounds-like search results.
  similarity?: number | null;
  // Likes (#1253). Only /library/liked rows carry these inline; every other listing
  // takes its heart state from the shared LikeIndex.
  likeCount?: number;
  likedByOperator?: boolean;
  lastLikedAt?: string;
  // Which never-play entry keeps this row off air, null when clear. Stamped
  // server-side (music/blocklist.ts). Absent on an older controller: treat
  // undefined and null the same.
  blockedBy?: BlockRef | null;
}

// GET /likes/index, one entry per liked song (the store caps at 5000 records).
export type LikeIndex = Record<string, { count: number; operator: boolean }>;

export interface LikedResponse { rows: Track[]; total: number }

export interface BrowseResponse {
  rows: Track[];
  total: number;
  moodVocab: string[];
  stats: {
    total: number;
    byMood: Record<string, number>;
    byEnergy: Record<string, number>;
    byGenre: Record<string, number>;
    updatedAt: string | null;
  };
}

export interface UntaggedResponse { rows: Track[]; nextCursor: string | null }

// Never-play blocklist (GET /library/blocklist). name/artist/album are display
// snapshots taken at block time, so rendering needs no Navidrome re-lookup.
export type BlockType = 'track' | 'album' | 'artist';

// What POST /dj/queue-block queues as one action (#1622 FR 4). Distinct from
// BlockType above, which is the never-play list's granularity — one puts a
// record ON air, the other keeps it off.
export type QueueBlockKind = 'album' | 'artist';

// POST /dj/queue-block's answer. Every caveat is a field rather than something
// the caller re-derives: `skipped` is what the never-play list refused (a block
// does NOT bypass it), `truncated` what the 30-track cap took, and
// `runsPastShowChange` a warning only — nothing was cut.
export interface QueueBlockResult {
  kind: QueueBlockKind;
  blockId: string;
  label: string;
  queued: number;
  queuePosition: number | null;
  truncated: number;
  skipped: { title: string | null; artist: string | null; reason: string }[];
  runsPastShowChange: { at: string; show: string | null; bySec: number } | null;
}

// What blocks a row: an id entry or an attribute rule (#1300 FR 1). `kind` is
// optional on the entry variant because an older controller omits it — treat
// absent as 'entry'; `ref.kind === 'rule'` is the discriminant either way.
export type BlockRef =
  | { kind?: 'entry'; type: BlockType; id: string; name: string | null }
  | { kind: 'rule'; field: RuleField; id: string; label: string; seasonal: boolean };

export interface BlockEntry {
  type: BlockType;
  id: string;
  name: string | null;
  artist: string | null;
  album: string | null;
  addedAt: string;
}

// Rule entries: attribute/tag predicates beside the id entries, with an optional
// seasonal allow-window and show scope. `active`/`matchCount` are listing stats
// stamped per rule by GET /library/blocklist. The shape comes from the mirrored
// schema, never re-declared here, so a server-side field addition cannot drift.
export type { RuleField, SeasonWindow } from '@/lib/schemas.generated';

import type { RuleField, SeasonWindow } from '@/lib/schemas.generated';

export interface BlockRule {
  id: string;
  label: string;
  field: RuleField;
  values: string[];
  season: SeasonWindow | null;
  showIds: string[];
  addedAt: string;
}

export interface BlockRuleStat extends BlockRule {
  active: boolean;
  matchCount: number;
}

// What a manual tag save or single-track retag did, applied across every cached
// row list by applyTagEvent (queries.ts). Handling differs per list: Search and
// Tracks patch in place, Needs-tags drops the row, Browse refetches because its
// membership can change.
export interface TagEvent {
  track: Track;
  moods: string[];
  energy: string | null;
  cleared: boolean;
  applyToAlbum: boolean;
  // Mirrors what the server stamped: 'manual' for the inline editor,
  // 'llm' for a single-track retag.
  source: string;
}

// GET /library/history. Title/artist/album are air-time snapshots.
export interface PlayEntry {
  id: number;
  trackId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  playedAt: string;
  source: string | null;       // 'ai' | 'request' | 'auto'
  requestedBy: string | null;
  showId: string | null;
  showName: string | null;
}

export interface SettingsResponse {
  tagger?: TaggerState;
  libraryStats?: LibraryStatsLite;
  values?: {
    audio?: {
      embeddings?: boolean;
      vocalActivity?: boolean;
      analyzeQuietOnly?: boolean;
      analyzeQuietMinutes?: number;
    };
    // Cost-preview attribution (#1162): seed calls bill to the chat LLM, embedding
    // calls to the embedding provider (blank = follows the LLM provider).
    llm?: { provider?: string; model?: string };
    embedding?: { provider?: string; model?: string };
  };
  // Absent on an old controller → treated as 'normal'.
  budget?: { mode: BudgetMode };
}

export type Tab = 'tracks' | 'browse' | 'search' | 'history' | 'blocked';
// TableVariant keys TrackTable's per-view behaviour (empty-state copy, accent Tag
// button) on what's actually shown, independent of the tab's All / Needs-tags toggle.
export type TrackMode = 'all' | 'needs' | 'liked';
export type TableVariant = 'recent' | 'browse' | 'search' | 'untagged' | 'liked';
export type LikedSort = 'recent' | 'count' | 'artist';
export type Sort = 'artist' | 'title' | 'year' | 'taggedAt' | 'bpm' | 'loudness' | 'pace';
export type Energy = 'any' | 'low' | 'medium' | 'high';
export type Vocal = 'any' | 'instrumental' | 'vocal';
// 'library' = Navidrome metadata search (/dj/search); 'sound' = CLAP sounds-like
// search (/library/search-sound), offered only when coverage reports the capability.
export type SearchMode = 'library' | 'sound';

export const PAGE_SIZE = 50;
export const SEARCH_PAGE = 30;

export const TABS: Tab[] = ['tracks', 'browse', 'search', 'history', 'blocked'];
export const SORTS: Sort[] = ['artist', 'title', 'year', 'taggedAt', 'bpm', 'loudness', 'pace'];


// One row of GET /dj/playlists — the Navidrome playlist index the Add-to-playlist
// bar offers.
export interface PlaylistSummary {
  id: string;
  name: string;
  songCount: number;
  durationSec: number;
  owner: string;
  public: boolean;
}


// Scene vocabulary (#1577) — the genre tag set as one curatable list.
// Mirrors controller `music/library-db/scenes.ts SceneCount` and
// `music/scene-vocab.ts SceneAlias`.

/** One distinct genre value in the mirror, with the tracks carrying it. */
export interface SceneCount {
  value: string;
  tracks: number;
}

/** One consolidation rule. `from` is the FOLDED key (case-insensitive,
 *  whitespace-collapsed) matched against ingested values, so it does not read
 *  back as any one retired spelling; `to` is the stored value written. */
export interface SceneAlias {
  from: string;
  to: string;
  at: string;
}

/** The referenced-by warning a merge carries (#1593), from the schema mirror. */
export type { SceneReference, SceneReferenceKind } from '@/lib/schemas.generated';
