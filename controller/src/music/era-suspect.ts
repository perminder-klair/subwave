// Is an album's year untrustworthy as a RECORDING year? (#1418) A policy module,
// since the walk, the lookup gate and the era resolver all ask it. Navidrome's
// `isCompilation` alone misses reissue anthologies, so the album artist,
// lead-artist spread and title are read too. Tuned for PRECISION over recall
// against a real 9,216-track catalogue; re-measure before loosening a threshold.

import { artistRootKey, isVariousArtistsName } from './recency.js';

/** Album-level facts the walk can read without a single extra request. */
export interface AlbumEraFacts {
  /** Navidrome's OpenSubsonic isCompilation, when it says anything. */
  isCompilation?: boolean | null;
  /** The album artist — Navidrome's own "Various Artists" marker lives here. */
  albumArtist?: string | null;
  title?: string | null;
  /** The album's release year. */
  year?: number | null;
  /** Raw per-track `artist` strings; normalising leads is this module's job. */
  trackArtists?: Array<string | null | undefined> | null;
}

export interface EraSuspicion {
  suspect: boolean;
  /** Which marker fired, for the tagger log and admin editor. Null when clear. */
  reason:
    | 'compilation-flag'
    | 'various-artists'
    | 'many-artists'
    | 'title-year-range'
    | 'title-compilation'
    | null;
}

const CLEAR: EraSuspicion = { suspect: false, reason: null };

// Measured together: five distinct LEAD artists on a release of at least eight
// tracks, with no lead accounting for 30% of it.
const MANY_ARTISTS_MIN = 5;
const MANY_ARTISTS_MIN_TRACKS = 8;
const MANY_ARTISTS_MAX_SHARE = 0.30;

// Matches musicbrainz.ts MIN_YEAR. Below this, a 4-digit number in a title is a
// catalogue number rather than a date.
const MIN_YEAR = 1900;

// Titles that SAY the record is a collection. Deliberately short: a bare
// "Collection" or "Vol." appears in ordinary album titles.
const COMPILATION_TITLE = new RegExp(
  '\\b(?:'
  + 'anthology|rarities|b-sides|greatest hits|best of'
  + '|dj mix|megamix|the ultimate collection|the collection'
  + '|complete[^,;]{0,24}singles|singles collection'
  + ')\\b',
  'i',
);

// Distinct LEAD artists and the biggest one's share. Keyed through
// recency.artistRootKey, never a local split: the raw `artist` string carries
// features, so counting it reads a one-artist album as a dozen.
function leadArtistProfile(artists: Array<string | null | undefined>): { leads: number; tracks: number; topShare: number } {
  const counts = new Map<string, number>();
  let tracks = 0;
  for (const raw of artists) {
    const key = artistRootKey(String(raw ?? '')) || '(unknown)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    tracks += 1;
  }
  if (!tracks) return { leads: 0, tracks: 0, topShare: 1 };
  return { leads: counts.size, tracks, topShare: Math.max(...counts.values()) / tracks };
}

// The year RANGE printed in a title ("Singles 1968-1974"). A range is the
// signal, never a bare year. A two-digit close expands against the open year's
// century. The walk uses `from` as a max-bound hint on the MusicBrainz lookup.
export function titleYearRange(title: unknown): { from: number; to: number } | null {
  const t = String(title ?? '');
  // en/em dash and hyphen all appear on sleeves; \D stops a match inside a
  // longer digit run.
  const m = /(?:^|\D)(\d{4})\s*[-–—]\s*(\d{2}|\d{4})(?!\d)/.exec(t);
  if (!m) return null;
  const from = Number(m[1]);
  const rawTo = m[2];
  const to = rawTo.length === 4
    ? Number(rawTo)
    // "1964-65" → 1965; a close landing before the open ("1998-02") rolls on.
    : Math.floor(from / 100) * 100 + Number(rawTo) < from
      ? Math.floor(from / 100) * 100 + Number(rawTo) + 100
      : Math.floor(from / 100) * 100 + Number(rawTo);
  const maxYear = new Date().getUTCFullYear() + 1;
  if (from < MIN_YEAR || from > maxYear) return null;
  if (to < from || to > maxYear) return null;
  return { from, to };
}

/**
 * Treat this album's `year` as the reissue's date rather than the recordings'?
 * Order matters only for the `reason` label; any one marker is enough.
 */
export function albumEraSuspect(f: AlbumEraFacts): EraSuspicion {
  // 1. Navidrome said so (#842).
  if (f.isCompilation === true) return { suspect: true, reason: 'compilation-flag' };

  // 2. Navidrome sets a various-artists album artist on multi-artist releases
  //    even when it leaves the compilation flag off (#1418).
  if (isVariousArtistsName(f.albumArtist)) return { suspect: true, reason: 'various-artists' };

  // 3. No one at the front of it; ordinary albums always have a dominant lead.
  const p = leadArtistProfile(f.trackArtists ?? []);
  if (p.leads >= MANY_ARTISTS_MIN && p.tracks >= MANY_ARTISTS_MIN_TRACKS && p.topShare < MANY_ARTISTS_MAX_SHARE) {
    return { suspect: true, reason: 'many-artists' };
  }

  // 4. The title says so: the single-artist "Best of" no artist count can see.
  if (COMPILATION_TITLE.test(String(f.title ?? ''))) {
    return { suspect: true, reason: 'title-compilation' };
  }

  // 5. A title date range closing before the album's own year. The
  //    close-before-release test keeps "Sessions 2014-2015" on a 2015 release
  //    from firing.
  const range = titleYearRange(f.title);
  if (range && f.year != null && Number.isFinite(f.year) && range.to < f.year) {
    return { suspect: true, reason: 'title-year-range' };
  }

  return CLEAR;
}
