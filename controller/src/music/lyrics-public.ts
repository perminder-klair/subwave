export interface PublicLyricLine {
  startMs: number | null;
  text: string;
}

export interface PublicLyricsPayload {
  songId: string | null;
  synced: boolean;
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

  const lines = lyrics.lines
    .map((line) => ({
      startMs: Number.isFinite(line.startMs) ? line.startMs : null,
      text: typeof line.text === 'string' ? line.text.trim() : '',
    }))
    .filter((line) => line.text.length > 0);

  return {
    songId,
    synced: lyrics.synced === true && lines.some((line) => line.startMs != null),
    offsetMs,
    lines,
  };
}
