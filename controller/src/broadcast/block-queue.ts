// Operator blocks retain ordinary studio queue exemptions; blocklist refusal remains in
// queue.push. This pure planner names skips and orders/caps tracks; routes/dj.ts performs
// lookups and pushes. #1622 FR 4, #1485 FR 3, #619, #447, #1574, #1465,
// scripts/queue-block.test.ts.

import { QUEUE_BLOCK_MAX_TRACKS, type QueueBlockKind, type QueueBlockOrder } from '../schemas/dj.js';

/** As much of a Subsonic child as the plan reads. */
export interface BlockSong {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  /** Subsonic `track` — the position on its disc. */
  track?: number | null;
  discNumber?: number | null;
  duration?: number | null;
  [k: string]: unknown;
}

/** Why a track from the source did not make it into the queue. */
export interface BlockSkip {
  title: string | null;
  artist: string | null;
  reason: 'blocked' | 'unplayable';
  /** blocklist.refOf(hit) — which entry or rule refused it. Null for 'unplayable'. */
  blockedBy: unknown | null;
}

export interface BlockPlan {
  /** In air order. Never shuffled for an album. */
  tracks: BlockSong[];
  skipped: BlockSkip[];
  /** How many the cap removed from the tail. 0 in the ordinary case. */
  truncated: number;
}

/**
 * Sort by disc, then track, preserving source order for ties. Missing discs mean disc 1;
 * missing tracks sort last within their disc.
 */
export function orderAlbumTracks<T extends BlockSong>(songs: readonly T[]): T[] {
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return songs
    .map((song, at) => ({ song, at }))
    .sort((a, b) => {
      const disc = num(a.song.discNumber, 1) - num(b.song.discNumber, 1);
      if (disc !== 0) return disc;
      const track = num(a.song.track, Number.MAX_SAFE_INTEGER) - num(b.song.track, Number.MAX_SAFE_INTEGER);
      if (track !== 0) return track;
      return a.at - b.at;
    })
    .map(({ song }) => song);
}

/**
 * Fisher-Yates over a COPY, with the caller's randomness injected the way
 * `bedPolicy.pickBed` takes it — so the shuffle is a pinned property rather
 * than something a test has to observe statistically.
 *
 * Only ever reached for an artist block: `queueBlockSchema` refuses
 * `order: 'shuffle'` on an album outright.
 */
export function shuffleTracks<T>(songs: readonly T[], rand: () => number = Math.random): T[] {
  const out = songs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface PlanBlockInput<T extends BlockSong> {
  kind: QueueBlockKind;
  songs: readonly T[];
  order: QueueBlockOrder;
  /** Artist blocks only — the schema refuses it on an album. */
  limit?: number | null;
  /**
   * `blocklist.hitOf` as a value, for the same reason `album-guard.ts` takes
   * `albumKeyOf` as one: every read stays at the call site and this module
   * stays testable without the store. Reporting only — `queue.push()` is still
   * what refuses a blocked track.
   */
  hitOf: (song: T) => unknown | null;
  rand?: () => number;
}

/**
 * Order tracks, remove unplayable/blocked entries, then cap. Return named skips and truncation
 * so refused tracks do not consume capacity.
 */
export function planBlock<T extends BlockSong>(input: PlanBlockInput<T>): BlockPlan {
  const { kind, songs, order, limit, hitOf, rand } = input;

  const ordered = kind === 'album'
    ? orderAlbumTracks(songs)
    : (order === 'shuffle' ? shuffleTracks(songs, rand) : songs.slice());

  const keep: T[] = [];
  const skipped: BlockSkip[] = [];
  for (const song of ordered) {
    const named = { title: song.title ?? null, artist: song.artist ?? null };
    if (!song.id) {
      skipped.push({ ...named, reason: 'unplayable', blockedBy: null });
      continue;
    }
    const hit = hitOf(song);
    if (hit) {
      skipped.push({ ...named, reason: 'blocked', blockedBy: hit });
      continue;
    }
    keep.push(song);
  }

  // An artist block's own `limit` binds before the hard cap; the schema already
  // holds it at or under QUEUE_BLOCK_MAX_TRACKS, so the min() is belt over
  // braces rather than a second rule.
  const want = Math.min(
    QUEUE_BLOCK_MAX_TRACKS,
    kind === 'artist' && limit != null && limit > 0 ? limit : QUEUE_BLOCK_MAX_TRACKS,
  );
  const tracks = keep.slice(0, want);
  return { tracks, skipped, truncated: keep.length - tracks.length };
}

/**
 * What the booth log, the response and the admin queue badge call this block.
 *
 * One builder because three surfaces render it and a fourth spelling is how
 * they come to disagree about the same block.
 */
export function blockLabel(input: { kind: QueueBlockKind; name?: string | null; artist?: string | null }): string {
  const name = (input.name || '').trim();
  const artist = (input.artist || '').trim();
  if (input.kind === 'artist') return artist || name || 'Unknown artist';
  if (name && artist) return `${name} — ${artist}`;
  return name || artist || 'Unknown album';
}

/**
 * Sum injected playable spans. Return null if any track's span is unknown rather than
 * understating a block forecast.
 */
export function blockPlayableSec(
  tracks: readonly BlockSong[],
  spanOf: (song: BlockSong) => number | null,
): number | null {
  let total = 0;
  for (const song of tracks) {
    const span = spanOf(song);
    if (span == null || !Number.isFinite(span) || span <= 0) return null;
    total += span;
  }
  return total;
}
