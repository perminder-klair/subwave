import { isInstrumentalMarker } from './lyric-vocal.js';

export interface PublicLyricLine {
  startMs: number | null;
  text: string;
}

export interface PublicLyricsPayload {
  songId: string | null;
  synced: boolean;
  /** Add this to the player's measured elapsed time before choosing a line. */
  offsetMs: number;
  lines: PublicLyricLine[];
}

export interface StructuredLyricsInput {
  synced: boolean;
  lines: Array<{ startMs: number; text: string }>;
}

export function toPublicLyricsPayload(
  songId: string | null,
  lyrics: StructuredLyricsInput | null,
  offsetMs = 0,
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
  const lines = lyrics.lines
    .map((line) => ({
      startMs: Number.isFinite(line.startMs) ? line.startMs : null,
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
