// The public lyrics payload (`GET /lyrics/current`), built from
// subsonic.fetchStructuredLyrics()'s shape. Pure: the route resolves the cue
// and the offset and hands them in.
import { isInstrumentalMarker } from './lyric-vocal.js';
import { shiftOnsetByCueMs } from './silence-trim.js';
import type { PublicLyricsPayload } from '../schemas/lyrics.js';

export type { PublicLyricLine, PublicLyricsPayload } from '../schemas/lyrics.js';

export interface StructuredLyricsInput {
  synced: boolean;
  lines: Array<{ startMs: number; text: string }>;
}

export interface PublicLyricsOptions {
  /** The station's correction for this track (library-db/lyrics.ts). */
  offsetMs?: number;
  /** Seconds into the file where this play began (`liq_cue_in`), or null when
   *  the file played from byte zero. */
  cueInSec?: number | null;
}

export function toPublicLyricsPayload(
  songId: string | null,
  lyrics: StructuredLyricsInput | null,
  { offsetMs = 0, cueInSec = null }: PublicLyricsOptions = {},
): PublicLyricsPayload {
  if (!songId || !lyrics) {
    return { songId: songId || null, synced: false, offsetMs, lines: [] };
  }

  // Drop blank lines AND instrumental markers. Navidrome/LRC bodies commonly
  // carry `[au: instrumental]` or a bare "Instrumental" as the whole lyric —
  // that is metadata, not sung words. Left in, it renders as a lyric line the
  // player highlights for the entire track (and, being timed at 0, is enough on
  // its own to flip `synced`). An all-marker body reduces to [], which is the
  // same empty payload a track with no lyrics returns.
  //
  // Timings come from the file, measured from byte zero; a player measures from
  // when the track started PLAYING, which with the dead-air trim on is cueInSec
  // into the file. Shifted here so every client gets the played timeline.
  const lines = lyrics.lines
    .map((line) => ({
      startMs: Number.isFinite(line.startMs) ? shiftOnsetByCueMs(cueInSec, line.startMs) : null,
      text: typeof line.text === 'string' ? line.text.trim() : '',
    }))
    .filter((line) => line.text.length > 0 && !isInstrumentalMarker(line.text));

  return {
    songId,
    synced: lyrics.synced === true && lines.some((line) => line.startMs != null),
    offsetMs,
    lines,
  };
}
