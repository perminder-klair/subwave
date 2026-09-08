// Album / block queueing — the pure half (#1622 FR 4).
//
// WHAT THIS FEATURE IS, AND WHAT IT IS NOT
// ----------------------------------------
// It is one press instead of twelve, in the right order, with an honest report
// of what the never-play list refused. It is NOT a bypass feature, and that is
// worth stating because the tracker framed it as one.
//
// Every guard named there was checked against the code: `picker.albumHours`
// (#1485 FR 3) lives in `filterPickerCandidates` and `dj-agent/album-guard.ts`,
// the artist guard in `dj-agent/artist-guard.ts` — all of them are PICK paths,
// and an operator push reaches none of them. What the cooldown does to a queued
// block is the right thing already: `queue.recentAlbumKeys` walks `upcoming`,
// so the block's presence stops the picker adding more of the same record
// behind it. There is nothing there to opt out of.
//
// The exemptions a block DOES need are the ones `POST /dj/queue-track` already
// carries, and it carries them exactly as it did: `allowDuplicate: true` past
// the #619 dedup guard, and `requestedBy: 'studio'` past the #447 length cap,
// the show-boundary cut (#1574) and the bed's request reason (#1465). This
// module invents no new bypass and the queue gains no new gate.
//
// THE ONE THING THAT IS NOT BYPASSED
// ----------------------------------
// The never-play blocklist. It is absolute, requests included, and a block of
// thirty tracks is no different. `hitOf` is read here so the response can NAME
// what was skipped, but the refusal still happens where it always has, in
// `queue.push()` — this is a reporting read of the existing chokepoint, not a
// second rule-filter, and the route pushes every planned track and records a
// `-2` return as a skip whether or not this pass predicted it.
//
// Pure and I/O-free so scripts/queue-block.test.ts can pin the ordering, the
// cap and the partition without a music server. The Subsonic lookups and the
// pushes live in routes/dj.ts.

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
 * An album's own running order.
 *
 * `subsonic.getAlbum` returns what the music server chose to return, which is
 * conventionally disc/track order and contractually nothing at all. This is the
 * one queue where getting that wrong is the entire failure — a shuffled album
 * is not a degraded album block, it is twelve tracks by one artist — so the
 * order is imposed here rather than trusted.
 *
 * Sorts on (discNumber, track) with the SOURCE ORDER as the final tiebreak, so
 * a release that tags neither comes back exactly as the server sent it instead
 * of being re-arranged into a sort's incidental order. A missing disc number
 * reads as disc 1, which is what a single-disc release omits it to mean; a
 * missing track number sorts to the END of its disc rather than the front,
 * because an untagged bonus cut appended to a tagged record is far commoner
 * than an untagged opener.
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
 * Source songs → the queue order, the skips and the truncation, in one pass.
 *
 * Order of operations is load-bearing:
 *
 *   1. ORDER first, so the cap takes the tail of the RECORD rather than the
 *      tail of whatever order the server happened to send.
 *   2. Drop the unplayable (no id — nothing to queue) and the blocked, and
 *      name both. Blocked tracks are removed BEFORE the cap so a record with
 *      two blocked cuts still queues its full length, rather than losing two
 *      more off the end to make room for tracks that were never going to air.
 *   3. Cap last, and report what it took.
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
 * Total seconds of air a planned block asks for.
 *
 * Spans are injected (in production `music/silence-trim.playableSpanSec`, which
 * is the span that will really air after the trim's cue points) rather than
 * read off `duration` here, because "how long is this track" is answered in
 * ONE place and this module is not it — see `music/track-floor.ts`.
 *
 * Returns null when ANY track's span is unknown, which is the honest answer for
 * a forecast: a partly-walked library would otherwise produce a total that is
 * short by however many rows it could not measure, and a show-change warning
 * derived from it would under-state the overrun — the direction that reads as
 * "this fits" when it does not.
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
