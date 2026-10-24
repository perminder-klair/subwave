// Lyrics for listeners, and the operator's per-track timing fix.
//
//   GET /lyrics/current            public (station-gated on a private station),
//                                  behind settings.lyrics.enabled
//   PUT /lyrics/offsets/:trackId   admin; the station-wide correction
//
// The read answers for the track the LISTENER hears, which is a stream buffer
// behind the live edge: a player names it with `?songId=`, and the route
// accepts the on-air track or one of the few just before it. Answering only for
// the live edge left a player opened in a song's last `bufferSeconds` asking
// about a track the live edge had already left, which no retry could fix.
//
// The lines are the music server's, or LRCLIB's for a track it has no timed
// lyrics for when the operator has that fallback on; music/lyrics-sources.ts
// decides, and the route never waits on LRCLIB.
import express from 'express';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import { resolveSilenceTrim } from '../music/silence-trim.js';
import { toPublicLyricsPayload } from '../music/lyrics-public.js';
import { LYRICS_RETRY_AFTER_SEC, listenerLyrics } from '../music/lyrics-sources.js';
import { requireAdmin } from '../middleware/auth.js';
import { requireStationAuth } from '../middleware/station-auth.js';
import { validateBody } from '../middleware/validate.js';
import { lyricOffsetBodySchema, lyricsQuerySchema, lyricsTrackIdSchema } from '../schemas/lyrics.js';

export const router = express.Router();

// Plays a listener can still be hearing besides the one on air. The player
// caps its buffer offset at 60s, and a track shorter than that can pass inside
// it, so one is not enough. Every one of them is already public on GET /state.
export const RECENT_PLAYS = 3;

// Which source answers, and the music-server cache, live in
// music/lyrics-sources.ts, shared with the on-air LRCLIB lookup.
export { LYRICS_RETRY_AFTER_SEC };

interface PlayRecord {
  track?: { id?: string | null } | null;
  cueInSec?: number;
  stemSeam?: boolean;
  source?: string;
}

// The play `songId` names among those a listener can be hearing: the queue's
// record of it (null when it is on air with no record yet), or undefined when
// it is none of them.
export function heardPlay(
  songId: string,
  onAirId: string | null,
  current: PlayRecord | null,
  history: readonly PlayRecord[],
): PlayRecord | null | undefined {
  if (songId === onAirId) return current?.track?.id === songId ? current : null;
  return history.slice(0, RECENT_PLAYS).find((p) => p?.track?.id === songId);
}

// Where in the file the listener's clock for this play starts. That clock is
// now-playing's start, so:
//   - a stem-blended play starts at byte 0: its clip IS the track's own head,
//     from byte 0 to the cue, annotated as the track so now-playing flips when
//     the clip begins. Its stamped cueInSec is where the real file resumes
//     AFTER the clip, not where the listener's clock began. (A blend never
//     renders over a trimmed head, so there is no trim to account for either.)
//   - any other drained play starts at the cue the queue stamped, the one
//     Liquidsoap got.
//   - an auto-playlist play has no record of its cue; the playlist line
//     carried the trim policy's, so that is asked again, as /now-playing does.
export function cueInFor(play: PlayRecord | null, policyCueInSec: () => number | null): number | null {
  if (play && play.source !== 'auto') return play.stemSeam ? null : (play.cueInSec ?? null);
  return policyCueInSec();
}

async function lyricsEnabled(_req: express.Request, res: express.Response, next: express.NextFunction) {
  await settings.load();
  if (settings.get()?.lyrics?.enabled === true) return next();
  res.status(403).json({ error: 'Lyrics are switched off on this station', enabled: false });
}

router.get('/lyrics/current', lyricsEnabled, requireStationAuth, async (req, res) => {
  const query = lyricsQuerySchema.safeParse(req.query ?? {});
  if (!query.success) return res.status(400).json({ error: 'songId must be a track id' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const nowPlaying = await queue.getNowPlaying();
    const onAirId = nowPlaying?.subsonic_id ? String(nowPlaying.subsonic_id) : null;
    const songId = query.data.songId ?? onAirId;
    if (!songId) return res.json(toPublicLyricsPayload(null, null));

    const play = heardPlay(songId, onAirId, queue.current, queue.history);
    if (play === undefined) {
      return res.status(409).json({ error: 'That track is no longer on air', songId: onAirId });
    }

    let chosen;
    try {
      chosen = await listenerLyrics(songId);
    } catch {
      // Not "no lyrics": the server did not answer, and the player must say so
      // and ask again rather than tell the listener the library has none.
      res.setHeader('Retry-After', String(LYRICS_RETRY_AFTER_SEC));
      return res.status(503).json({
        error: 'The music server did not answer for lyrics',
        retryAfter: LYRICS_RETRY_AFTER_SEC,
      });
    }

    // An LRCLIB file is moved by the same cue and corrected by the same
    // offset: both are properties of the play and the track, not the source.
    const offsetMs = await library.getLyricOffset(songId);
    const cueInSec = cueInFor(play, () => resolveSilenceTrim(library.get(songId)).cueInSec);
    res.json(toPublicLyricsPayload(songId, chosen.lyrics, {
      offsetMs,
      cueInSec,
      source: chosen.source,
      pending: chosen.pending,
    }));
  } catch (err) {
    queue.log('error', `/lyrics/current failed: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: 'internal error' });
  }
});

router.put('/lyrics/offsets/:trackId', requireAdmin, validateBody(lyricOffsetBodySchema), async (req, res) => {
  const trackId = lyricsTrackIdSchema.safeParse(req.params.trackId);
  if (!trackId.success) return res.status(400).json({ error: 'trackId must be a track id' });
  try {
    const { offsetMs } = req.body as { offsetMs: number };
    await library.setLyricOffset(trackId.data, offsetMs);
    res.json({ ok: true, trackId: trackId.data, offsetMs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not save the offset' });
  }
});
