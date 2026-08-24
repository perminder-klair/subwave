// Is an album's year untrustworthy as a RECORDING year? (issue #1418)
//
// #842 built the era pipeline on one signal: Navidrome's `isCompilation` flag.
// On a real library that flag is close to empty — 37 albums out of 27,860 in
// the reported case — because the reissue anthologies the pipeline exists for
// carry no COMPILATION tag. A Light in the Attic collection of 1964-65 Stax
// singles arrives as `isCompilation: false`, `year: 2012`,
// `originalReleaseDate: 2012`: nothing on the record says "these recordings are
// older than this release" except the things a human reads — the cover, the
// artist list, the date range in the title.
//
// So this module reads those. It answers ONE question — "is this album's year
// untrustworthy?" — and it is deliberately a separate module rather than a
// branch inside the walk, because the same judgement is now reached from three
// places (the walk, the lookup gate, and the era resolver's untrusted flag) and
// three copies would drift the way the original single `isCompilation` check
// did.
//
// PRECISION OVER RECALL, on purpose. A false positive costs a MusicBrainz
// request (1/s, so it is a real cost at library scale) and, if the lookup then
// misses, drops the album out of era-bounded shows entirely — the "leave it out
// rather than play it in the wrong decade" rule firing on an album that was
// fine. A false negative just leaves today's behaviour in place.
//
// The artist-count signal is TUNED AGAINST A REAL CATALOGUE (9,216 tracks,
// 3,989 albums, heavy on modern Punjabi and rap) rather than reasoned about,
// because reasoning about it got it badly wrong. Three findings changed the
// shape of it:
//
//  1. `artist` is the raw per-track string and usually carries the features, so
//     a one-artist record reads as many: "Slauson Boy 2" counted 13 artists,
//     "Mr. Morale & The Big Steppers" 9, "Moosetape" 10 — all single-artist
//     albums. Counting artistRootKey (the LEAD) collapses those to 1 and is the
//     single biggest correctness win here.
//  2. A bare "3 or more artists" rule flagged 207 albums / 2,221 tracks — 24%
//     of the library — overwhelmingly ordinary records with guest verses.
//  3. Small releases break any ratio test: a 4-track EP with four collaborators
//     has no dominant artist by arithmetic alone, not because it is an
//     anthology. Hence the track floor.
//
// The tuned rule lands on 5.4% of that library, and reads as DJ mixes,
// soundtracks, label samplers and various-artist collections — which is what it
// is supposed to be. Re-measure before loosening any of the three numbers.

import { artistRootKey } from './recency.js';

/** Album-level facts the walk can read without a single extra request. */
export interface AlbumEraFacts {
  /** Navidrome's OpenSubsonic isCompilation, when it says anything. */
  isCompilation?: boolean | null;
  /** The album artist — Navidrome's own "Various Artists" marker lives here. */
  albumArtist?: string | null;
  title?: string | null;
  /** The album's release year. */
  year?: number | null;
  /**
   * Every track's raw `artist` string, one per track. Raw on purpose: the
   * lead-artist normalisation is this module's job, not the caller's, so the
   * walk cannot accidentally count "Artist feat. Guest" as a second artist.
   */
  trackArtists?: Array<string | null | undefined> | null;
}

export interface EraSuspicion {
  suspect: boolean;
  /** Which marker fired, for the tagger log and the admin row editor. Null when clear. */
  reason:
    | 'compilation-flag'
    | 'various-artists'
    | 'many-artists'
    | 'title-year-range'
    | 'title-compilation'
    | null;
}

const CLEAR: EraSuspicion = { suspect: false, reason: null };

// All three measured together; see the header. Five distinct LEAD artists, on a
// release of at least eight tracks, with no lead accounting for 30% of it.
const MANY_ARTISTS_MIN = 5;
const MANY_ARTISTS_MIN_TRACKS = 8;
const MANY_ARTISTS_MAX_SHARE = 0.30;

// The earliest year a recording could plausibly carry, matching
// musicbrainz.ts MIN_YEAR. Below this a 4-digit number in a title is a
// catalogue number, a lyric or an address, not a date.
const MIN_YEAR = 1900;

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Navidrome writes the album artist for a multi-artist release as one of these.
const VARIOUS = new Set(['variousartists', 'various', 'va', 'verschiedene', 'diversos', 'divers']);

// Titles that SAY the record is a collection. Deliberately a short, specific
// list: on the measured catalogue it fires on 12 albums out of 3,989, and the
// three it catches that no other signal does are single-artist collections
// ("The Collection", "Kaun Nachdi (The Ultimate Collection)", a "Best of") —
// the same shape as the reported Toussaint anthology. Loose words are left out
// on purpose: a bare "Collection" or "Vol." appears in ordinary album titles.
const COMPILATION_TITLE = new RegExp(
  '\\b(?:'
  + 'anthology|rarities|b-sides|greatest hits|best of'
  + '|dj mix|megamix|the ultimate collection|the collection'
  + '|complete[^,;]{0,24}singles|singles collection'
  + ')\\b',
  'i',
);

// Distinct LEAD artists and the biggest one's share of the record. Lead, not
// raw: see finding 1 in the header — the raw string carries the features, so
// counting it reads a one-artist album as a dozen.
//
// A local copy of recency.artistRootKey's split rules would be a second copy of
// a policy that already exists, so this imports it.
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

// The earliest year in an explicit RANGE in the title — "…Singles 1964-65",
// "The Atco/Atlantic Singles 1968-1974", "Recordings 1972–1975". A range is the
// signal, not a bare year: "Woodstock 1969" and "Top 40 Hits of 2015" are both
// single years, and a bare 4-digit number in a title is far more often a band
// name, an album name or a catalogue number ("Studio 1984") than a date.
//
// Both endpoints are returned so the caller can sanity-check them; a two-digit
// close ("1964-65") is expanded against the open year's century.
//
// Exported for the unit test and because the walk uses `from` as a MAX bound
// hint on the MusicBrainz lookup — the recording cannot post-date the range
// the sleeve prints.
export function titleYearRange(title: unknown): { from: number; to: number } | null {
  const t = String(title ?? '');
  // en/em dash and hyphen all appear on real sleeves; \D on either side stops
  // this matching inside a longer digit run.
  const m = /(?:^|\D)(\d{4})\s*[-–—]\s*(\d{2}|\d{4})(?!\d)/.exec(t);
  if (!m) return null;
  const from = Number(m[1]);
  const rawTo = m[2];
  const to = rawTo.length === 4
    ? Number(rawTo)
    // "1964-65" → 1965. Century comes from the open year, and a close that
    // lands BEFORE the open (e.g. "1998-02") rolls into the next century.
    : Math.floor(from / 100) * 100 + Number(rawTo) < from
      ? Math.floor(from / 100) * 100 + Number(rawTo) + 100
      : Math.floor(from / 100) * 100 + Number(rawTo);
  const maxYear = new Date().getUTCFullYear() + 1;
  if (from < MIN_YEAR || from > maxYear) return null;
  if (to < from || to > maxYear) return null;
  return { from, to };
}

/**
 * Should this album's `year` be treated as the reissue's date rather than the
 * recordings'? Order matters only for the `reason` label — any one marker is
 * enough.
 */
export function albumEraSuspect(f: AlbumEraFacts): EraSuspicion {
  // 1. Navidrome said so. The #842 signal, unchanged and still first: when the
  //    flag IS set it is the most direct evidence there is.
  if (f.isCompilation === true) return { suspect: true, reason: 'compilation-flag' };

  // 2. The album artist is the various-artists marker. Navidrome sets this on
  //    multi-artist releases even when it does not set the compilation flag,
  //    which is exactly the gap #1418 is about.
  if (VARIOUS.has(norm(f.albumArtist))) return { suspect: true, reason: 'various-artists' };

  // 3. A record with no one at the front of it. All three conditions were
  //    measured, not guessed (see the header): enough distinct LEAD artists,
  //    on a release long enough for the ratio to mean anything, with nobody
  //    accounting for even a third of it. Ordinary albums — including
  //    features-heavy ones, which is where the naive version failed — always
  //    have a dominant lead.
  const p = leadArtistProfile(f.trackArtists ?? []);
  if (p.leads >= MANY_ARTISTS_MIN && p.tracks >= MANY_ARTISTS_MIN_TRACKS && p.topShare < MANY_ARTISTS_MAX_SHARE) {
    return { suspect: true, reason: 'many-artists' };
  }

  // 4. The title says it is a collection. Catches the single-artist "Best of",
  //    which every artist-count signal misses by construction.
  if (COMPILATION_TITLE.test(String(f.title ?? ''))) {
    return { suspect: true, reason: 'title-compilation' };
  }

  // 5. The sleeve prints a date range that CLOSES before the album's own year.
  //    This is the single-artist anthology the artist-count signals cannot see
  //    — "Allen Toussaint: The Atco/Atlantic Singles 1968-1974" on a 2015
  //    release credits one artist throughout. The close-before-release test is
  //    what keeps it honest: a 2015 album titled "Sessions 2014-2015" is
  //    describing when it was made, not what it collects.
  const range = titleYearRange(f.title);
  if (range && f.year != null && Number.isFinite(f.year) && range.to < f.year) {
    return { suspect: true, reason: 'title-year-range' };
  }

  return CLEAR;
}
