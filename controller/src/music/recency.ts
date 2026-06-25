export const DEFAULT_TRACK_RECENCY_HOURS = 12;
export const DEFAULT_ARTIST_RECENCY_HOURS = 2;
const DIVERSE_LIBRARY_ARTISTS = 48;
const MIN_TRACK_RECENCY_HOURS = 1;
const MIN_ARTIST_RECENCY_HOURS = 0.25;

export interface RecencyWindows {
  trackHours: number;
  artistHours: number;
}

export interface CandidateLike {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  // Track length. Subsonic songs carry `duration`; library-db rows carry
  // `durationSec`. Both optional — unknown length is never grounds to drop.
  duration?: number | null;
  durationSec?: number | null;
}

export interface CandidateFilterState {
  recentIds?: Set<string>;
  recentKeys?: Set<string>;
  recentArtists?: Set<string>;
  seenIds?: Set<string>;
  artistCounts?: Map<string, number>;
  maxPerArtist?: number;
  cap?: number;
  // Hard length cap in seconds (station/show max-track-length, issue #447).
  // null / 0 means "no cap". Tracks longer than this are dropped before the
  // recency relaxation below, so an over-length track never airs even when the
  // pool is starved.
  maxDurationSec?: number | null;
}

// Track length in seconds from whichever field the source carries, or null when
// unknown. Zero/negative/non-finite all read as unknown — we only ever act on a
// positive, trustworthy duration (the hour-long album mixes #447 targets report
// one reliably).
export function durationSeconds(song: CandidateLike): number | null {
  const d = song?.duration ?? song?.durationSec;
  return Number.isFinite(d) && (d as number) > 0 ? Number(d) : null;
}

export function artistKey(song: CandidateLike): string {
  return (song.artist || '').toLowerCase().trim();
}

export function trackKey(song: CandidateLike): string {
  return `${(song.title || '').toLowerCase().trim()}|${artistKey(song)}`;
}

export function recencyWindowsForLibrary(distinctArtists: number | null | undefined): RecencyWindows {
  if (!distinctArtists || distinctArtists <= 0) {
    return {
      trackHours: DEFAULT_TRACK_RECENCY_HOURS,
      artistHours: DEFAULT_ARTIST_RECENCY_HOURS,
    };
  }

  const scale = Math.min(1, Math.max(distinctArtists / DIVERSE_LIBRARY_ARTISTS, 1 / 12));
  const roundToQuarterHour = (hours: number) => Math.round(hours * 4) / 4;

  return {
    trackHours: Math.max(
      MIN_TRACK_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_TRACK_RECENCY_HOURS * scale),
    ),
    artistHours: Math.max(
      MIN_ARTIST_RECENCY_HOURS,
      roundToQuarterHour(DEFAULT_ARTIST_RECENCY_HOURS * scale),
    ),
  };
}

export function filterPickerCandidates<T extends CandidateLike>(
  list: T[],
  {
    recentIds = new Set<string>(),
    recentKeys = new Set<string>(),
    recentArtists = new Set<string>(),
    seenIds = new Set<string>(),
    artistCounts = new Map<string, number>(),
    maxPerArtist = Infinity,
    cap = Infinity,
    maxDurationSec = null,
  }: CandidateFilterState = {},
): T[] {
  // Length cap first, outside the recency loop: a too-long track is never an
  // acceptable autonomous pick, so it must not survive even the fully-relaxed
  // third mode. Unknown-duration tracks pass through untouched.
  const pool = maxDurationSec && maxDurationSec > 0
    ? (list || []).filter((s) => {
        const d = durationSeconds(s);
        return d == null || d <= maxDurationSec;
      })
    : (list || []);

  const modes = [
    { recentTracks: true, recentArtists: true },
    { recentTracks: true, recentArtists: false },
    { recentTracks: false, recentArtists: false },
  ];

  for (const mode of modes) {
    const nextSeen = new Set(seenIds);
    const nextArtistCounts = new Map(artistCounts);
    const out: T[] = [];

    for (const song of pool) {
      if (!song?.id || nextSeen.has(song.id)) continue;
      if (mode.recentTracks && recentIds.has(song.id)) continue;
      if (mode.recentTracks && recentKeys.has(trackKey(song))) continue;

      const key = artistKey(song);
      if (mode.recentArtists && key && recentArtists.has(key)) continue;
      if (key) {
        const count = nextArtistCounts.get(key) || 0;
        if (count >= maxPerArtist) continue;
        nextArtistCounts.set(key, count + 1);
      }

      nextSeen.add(song.id);
      out.push(song);
      if (out.length >= cap) break;
    }

    if (out.length === 0) continue;

    for (const id of nextSeen) seenIds.add(id);
    artistCounts.clear();
    for (const [key, count] of nextArtistCounts) artistCounts.set(key, count);
    return out;
  }

  return [];
}
