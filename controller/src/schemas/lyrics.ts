// Shared lyrics shapes: the public `GET /lyrics/current` payload, its query,
// and the operator's per-track timing offset (`PUT /lyrics/offsets/:trackId`).
// Mirrored into the web bundle, so the player and the controller read one
// definition of each and one set of offset bounds.
import { z } from 'zod';

// The offset is a correction for a lyric file that is out of step with its
// audio. Thirty seconds either way covers a mistimed LRC; anything past that is
// a wrong file, not a timing fault.
export const LYRIC_OFFSET_MIN_MS = -30_000;
export const LYRIC_OFFSET_MAX_MS = 30_000;

// Positive advances the highlighting (lines appear sooner), negative delays it.
export const lyricOffsetMsSchema = z
  .number({ error: 'offsetMs must be a number' })
  .int('offsetMs must be a whole number of milliseconds')
  .min(LYRIC_OFFSET_MIN_MS, `offsetMs must be ${LYRIC_OFFSET_MIN_MS} to ${LYRIC_OFFSET_MAX_MS}`)
  .max(LYRIC_OFFSET_MAX_MS, `offsetMs must be ${LYRIC_OFFSET_MIN_MS} to ${LYRIC_OFFSET_MAX_MS}`);

export const lyricOffsetBodySchema = z.strictObject({ offsetMs: lyricOffsetMsSchema });

// A Subsonic id is opaque; the bound only keeps a query from carrying a novel.
export const LYRICS_TRACK_ID_MAX = 200;

export const lyricsTrackIdSchema = z.string().trim().min(1).max(LYRICS_TRACK_ID_MAX);

// `songId` names the track the LISTENER is hearing, which sits a stream buffer
// behind the live edge. Absent means the on-air track.
export const lyricsQuerySchema = z.object({
  songId: lyricsTrackIdSchema.optional(),
});

export const publicLyricLineSchema = z.object({
  // Milliseconds on the PLAYED timeline (a trimmed head already taken off), so
  // a player compares it with elapsed time since the track started. Null on a
  // plain, untimed line.
  startMs: z.number().nullable(),
  text: z.string(),
});

export const publicLyricsPayloadSchema = z.object({
  songId: z.string().nullable(),
  synced: z.boolean(),
  // The station's correction for this track: add it to elapsed time before
  // choosing the active line. Kept out of `startMs` so the operator can see and
  // adjust the value that is in force.
  offsetMs: z.number(),
  lines: z.array(publicLyricLineSchema),
});

export type PublicLyricLine = z.infer<typeof publicLyricLineSchema>;
export type PublicLyricsPayload = z.infer<typeof publicLyricsPayloadSchema>;
