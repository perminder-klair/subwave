export const DEFAULT_TRACK_RECENCY_HOURS = 12;
export const DEFAULT_ARTIST_RECENCY_HOURS = 2;
const DIVERSE_LIBRARY_ARTISTS = 48;
const MIN_TRACK_RECENCY_HOURS = 1;
const MIN_ARTIST_RECENCY_HOURS = 0.25;

// Count-based hard no-repeat guard tuning (effectiveNoRepeatWindow below).
// Never hard-block more than this fraction of the tagged library, so even a
// configured window larger than the catalogue can support still leaves a fresh
// pool to pick from. And below MIN_EFFECTIVE distinct tracks the guard is both
// too weak to matter and too likely to starve a tiny library — so it switches
// off entirely and the relaxable time-window guard carries on alone.
const NO_REPEAT_MAX_LIBRARY_FRACTION = 0.375;
const NO_REPEAT_MIN_EFFECTIVE = 15;

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
  // Count-based hard no-repeat guard (live-repeats fix). Checked OUTSIDE the
  // relaxation cascade's mode loop — like maxDurationSec, a track in here is
  // never an acceptable pick, so it survives every starvation stage. This is
  // what guarantees the last N distinct plays can't re-air even when the
  // relaxable recentIds/recentKeys guard below is dropped to keep the pool from
  // emptying. Populated from queue.recentlyPlayedByCount(N); empty = guard off.
  hardRecentIds?: Set<string>;
  hardRecentKeys?: Set<string>;
  seenIds?: Set<string>;
  artistCounts?: Map<string, number>;
  maxPerArtist?: number;
  cap?: number;
  // Hard length cap in seconds (station/show max-track-length, issue #447).
  // null / 0 means "no cap". Tracks longer than this are dropped before the
  // recency relaxation below, so an over-length track never airs even when the
  // pool is starved.
  maxDurationSec?: number | null;
  // Whether a starved result may relax the recent-ARTIST guard. Default true
  // preserves the pool picker's "never return empty" behaviour. The agent's
  // per-tool collect() passes false: a single-artist tool (topSongsByArtist /
  // similarSongs narrowed to one recent artist) then returns empty instead of
  // handing the just-played artist straight back — the agent reaches for one of
  // its other six discovery tools. This closes the artist-fixation bypass that
  // let one artist re-air every ~1.2h despite the 2h artist window. Tracks may
  // still relax as a last resort, but only for FRESH (non-recent) artists.
  allowArtistRelaxation?: boolean;
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

// Clamp a configured count-based no-repeat window to what the tagged library
// can safely support. Pure + unit-pinned (picker-recency-regression.ts).
//   - configuredN <= 0, or an unknown/empty library  → 0 (guard self-disables)
//   - never block more than NO_REPEAT_MAX_LIBRARY_FRACTION of the library
//   - if the result would be below NO_REPEAT_MIN_EFFECTIVE              → 0
// Examples: (100,1000)→100, (100,40)→15, (100,20)→0, (0,*)→0, (100,null)→0.
export function effectiveNoRepeatWindow(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
): number {
  const n = Math.floor(Number(configuredN) || 0);
  const total = Math.floor(Number(libraryTotal) || 0);
  if (n <= 0 || total <= 0) return 0;
  const ceiling = Math.floor(total * NO_REPEAT_MAX_LIBRARY_FRACTION);
  const eff = Math.min(n, ceiling);
  return eff < NO_REPEAT_MIN_EFFECTIVE ? 0 : eff;
}

export function filterPickerCandidates<T extends CandidateLike>(
  list: T[],
  {
    recentIds = new Set<string>(),
    recentKeys = new Set<string>(),
    recentArtists = new Set<string>(),
    hardRecentIds = new Set<string>(),
    hardRecentKeys = new Set<string>(),
    seenIds = new Set<string>(),
    artistCounts = new Map<string, number>(),
    maxPerArtist = Infinity,
    cap = Infinity,
    maxDurationSec = null,
    allowArtistRelaxation = true,
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

  // Relaxation cascade: each mode drops a guard so a starved pool still yields
  // something rather than nothing. When artist relaxation is disabled the artist
  // guard stays ON in every mode — only the track guard may drop, and only for
  // fresh artists — so the agent is never handed an artist it just played.
  const modes = allowArtistRelaxation
    ? [
        { recentTracks: true, recentArtists: true },
        { recentTracks: true, recentArtists: false },
        { recentTracks: false, recentArtists: false },
      ]
    : [
        { recentTracks: true, recentArtists: true },
        { recentTracks: false, recentArtists: true },
      ];

  for (const mode of modes) {
    const nextSeen = new Set(seenIds);
    const nextArtistCounts = new Map(artistCounts);
    const out: T[] = [];

    for (const song of pool) {
      if (!song?.id || nextSeen.has(song.id)) continue;
      // Hard no-repeat guard — NO mode gate, so it holds through every
      // relaxation stage. A track in the last-N-distinct set never airs, even
      // when the cascade has dropped the relaxable track guard below to avoid an
      // empty pool. (effectiveNoRepeatWindow keeps this set well under the
      // library size so this can't starve the pool to nothing.)
      if (hardRecentIds.has(song.id)) continue;
      if (hardRecentKeys.has(trackKey(song))) continue;
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
