// Shared shapes for the studio's own queue actions (#1622 FR 4) — the block
// queue, `POST /dj/queue-block` — and the targeted skip, `POST /dj/skip`.
//
// HARD RULE: this file may import ONLY from 'zod'. It is copied verbatim into
// the web bundle by `npm run gen:schemas`, so a project import or a node
// builtin here breaks the mirror. Everything impure — resolving an album id
// from a track, reading the blocklist, ordering the songs, reading what is on
// air — lives in broadcast/block-queue.ts, broadcast/skip-policy.ts and
// routes/dj.ts.
import { z } from 'zod';

/** What a block is a block OF. */
export const QUEUE_BLOCK_KINDS = ['album', 'artist'] as const;
export type QueueBlockKind = (typeof QUEUE_BLOCK_KINDS)[number];

/**
 * How many tracks one press may queue.
 *
 * A double album is ~25 tracks, so 30 covers the case the feature exists for
 * with room over. A longer record is TRUNCATED and the truncation is reported,
 * never refused and never silently dropped: refusing "queue this album" over
 * its length is the wrong answer to an explicit operator action, and dropping
 * six tracks without saying so is worse than either.
 */
export const QUEUE_BLOCK_MAX_TRACKS = 30;

/** Tracks an artist block takes when the caller names no `limit`. */
export const QUEUE_BLOCK_ARTIST_LIMIT_DEFAULT = 10;

/**
 * Ordering.
 *
 * `'natural'` is the source's own order — for an album that is disc-then-track
 * (imposed by `orderAlbumTracks`, because a music server's return order is
 * conventional rather than contractual), for an artist it is whatever ranking
 * the lookup returned.
 */
export const QUEUE_BLOCK_ORDERS = ['natural', 'shuffle'] as const;
export type QueueBlockOrder = (typeof QUEUE_BLOCK_ORDERS)[number];

const idField = z.string().trim().min(1).max(200);

/**
 * Body for `POST /dj/queue-block`.
 *
 * Two accepted ways to say which block, mirroring `POST /library/blocklist`'s
 * precedent: a `trackId` from any admin track row (the server resolves the
 * album/artist from it, because the row UI never sees those ids), or a
 * pre-resolved `id`. An artist may also be named outright, since
 * `subsonic.getTopSongs` is keyed by NAME.
 *
 * Two fields are REFUSED rather than ignored where they cannot mean anything,
 * which is the same both-halves-of-one-rule posture `schemas/schedule.ts` takes
 * with `until`/`minutes`: silently discarding a field the caller sent is how
 * two fields come to disagree about what was asked for, with nothing telling
 * the caller its value went nowhere.
 *
 *   * `order: 'shuffle'` on an album. An album IS its running order — that is
 *     the whole of what distinguishes this from queueing twelve tracks — so a
 *     shuffled album is not a smaller version of the request, it is a different
 *     one.
 *   * `limit` on an album. A record is a whole; a count would cut it at an
 *     arbitrary track. The length bound is QUEUE_BLOCK_MAX_TRACKS, which
 *     truncates and says so.
 *
 * Messages name their own field, so the route validates with
 * `{ messages: 'verbatim' }` — see middleware/validate.ts for why that
 * exception exists.
 */
export const queueBlockSchema = z
  .object({
    kind: z.enum(QUEUE_BLOCK_KINDS, { message: "kind must be 'album' or 'artist'" }),
    /** Any admin track row's id — the server resolves the album/artist off it. */
    trackId: idField.optional(),
    /** A pre-resolved album or artist id. */
    id: idField.optional(),
    /** An artist by name (getTopSongs is name-keyed). Artist blocks only. */
    artist: idField.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(QUEUE_BLOCK_MAX_TRACKS, { message: `limit must be between 1 and ${QUEUE_BLOCK_MAX_TRACKS}` })
      .optional(),
    order: z.enum(QUEUE_BLOCK_ORDERS, { message: "order must be 'natural' or 'shuffle'" }).default('natural'),
  })
  .refine((b) => !!(b.trackId || b.id || b.artist), {
    message: 'trackId, id or artist is required',
  })
  .refine((b) => !(b.kind === 'album' && b.artist), {
    message: 'artist names an artist block — an album block takes trackId or id',
  })
  .refine((b) => !(b.kind === 'album' && b.order === 'shuffle'), {
    message: "order 'shuffle' is not valid for an album — a record plays in its own order",
  })
  .refine((b) => !(b.kind === 'album' && b.limit != null), {
    message: 'limit is not valid for an album — a record is queued whole',
  });

export type QueueBlockBody = z.infer<typeof queueBlockSchema>;

/**
 * Why a targeted skip skipped nothing (#2017), the `reason` of its 409.
 *
 *   * `track-changed` — now-playing no longer names the track the caller
 *     meant: it ended, during the commit wait or before the request arrived.
 *   * `jingle-on-air` — a jingle is on air, or waiting in the crossfade
 *     buffer behind the outgoing track's tail. Now-playing names the song
 *     before it, or (from that song's closing seam) the song after it, and a
 *     skip would cut the jingle or the tail, not the song. The window that
 *     decides it also covers the first seconds of the song after the jingle,
 *     so that song is about to play, or has just started: try again once it
 *     is playing.
 *   * `bed-on-air` / `break-on-air` — now-playing still names it, but the
 *     mixer has since placed a bed or a pause-and-talk break after it.
 *     Neither rewrites now-playing, so the name is stale and a skip would cut
 *     the item, not the song.
 */
export const SKIP_REFUSAL_REASONS = ['track-changed', 'jingle-on-air', 'bed-on-air', 'break-on-air'] as const;
export type SkipRefusalReason = (typeof SKIP_REFUSAL_REASONS)[number];

/**
 * Body for `POST /dj/skip`.
 *
 * `expectId` is the on-air track's `subsonic_id` as the caller saw it on
 * `/now-playing`. With it, the skip lands only if that track is still what is
 * on air; without it (absent or null) the skip is the bare one it always was.
 * The route took no body before this, so anything that is not a JSON object
 * — no body, a text body, an array — still reads as no target, and other keys
 * are dropped rather than refused. The shape is exported on its own for the
 * MCP tool's input, which takes a raw shape rather than a schema.
 */
export const skipBodyShape = { expectId: idField.nullish() };

export const skipBodySchema = z.preprocess(
  (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
  z.object(skipBodyShape),
);

export type SkipBody = z.infer<typeof skipBodySchema>;
