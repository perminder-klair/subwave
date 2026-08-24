 
import type { TaggerState, LibraryStatsLite, BudgetMode } from '../LibraryTaggingPanel';

export interface Track {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string | null;
  // Era surface (#842/#1418). `year` is the FILE's year — on a reissue
  // anthology that's the reissue's date. `originalYear` is the resolved
  // recording year when one is known, and `originalYearSource` says who
  // resolved it: 'album-tag' (the album's originalReleaseDate, which on a
  // reissue is just the reissue again), 'musicbrainz', or 'manual' — the
  // operator's own answer, which outranks both. Absent on an older controller.
  originalYear?: number | null;
  originalYearSource?: string | null;
  // Navidrome's raw compilation flag, and the station's own derived verdict
  // (#1418) — an album can be an anthology with the flag unset, which is the
  // whole defect. Era resolution treats either as "the year is the release's".
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
  // Which never-play entry keeps this row off air, null when clear. Stamped server-side
  // (music/blocklist.ts) so the browser never re-implements the match rules. Absent on
  // an older controller — treat undefined and null the same.
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

// Rule entries — attribute/tag predicates beside the id entries, with an
// optional seasonal allow-window and show scope. `active`/`matchCount` are the
// listing stats GET /library/blocklist stamps per rule.
//
// The SHAPE comes from the mirrored schema rather than being re-declared here.
// Both of these were hand-copied from the controller, which is the drift the
// mirror exists to prevent: the field vocabulary in particular is enumerated in
// FIELD_OPTIONS on the card too, and a field added server-side would otherwise
// typecheck cleanly here while being unreachable in the UI.
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

// What a manual tag save or a single-track retag did, applied across every
// cached row list by applyTagEvent (queries.ts). The lists disagree about what
// it means: Search and the Tracks modes patch the row in place, Needs-tags
// DROPS it (a tagged track is no longer untagged), and Browse refetches because
// its MEMBERSHIP can change (a mood filter may stop matching).
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
