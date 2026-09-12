// "Spotify refused that track — is the SAME recording on another release?"
//
// Pure: no network, no config, no clock. source.ts does the one search and
// hands the rows here; scripts/spotify-unplayable.test.ts pins the ranking
// without an account.
//
// The premise is narrow on purpose. A track unavailable on one release is very
// often playable on another — a remaster, a deluxe edition, a territory-specific
// pressing — because Spotify licenses per RELEASE, not per recording. What this
// must never do is hand back a DIFFERENT recording that merely shares a title:
// a live cut, a karaoke backing, somebody else's cover. The station would air it
// under the intro the DJ already wrote for the original, and nothing downstream
// would notice. So the matcher is deliberately strict in both directions —
// titles must fold to the same string, the lead artist must fold to the same
// key, and a candidate that ADDS a performance marker is rejected outright.

import { nameKey } from '../../recency.js';
import type { Song } from '../types.js';

// Release-edition noise that does NOT change the recording. Stripped from both
// sides before comparing, which is the whole point: "Hurricane" and
// "Hurricane - 2018 Remaster" are the same performance on two releases.
//
// What is deliberately NOT in here: "single version", "album version", "radio
// edit" and "remix". Those name a different CUT of the material — a different
// length, a different arrangement — so they belong to PERFORMANCE_MARKERS
// below, not here. A term appearing in both lists would also contradict itself:
// the title fold would erase it while the marker test refused it.
const EDITION_SUFFIX = new RegExp(
  String.raw`[\s\-–—]*[([]?\s*`
  + String.raw`(?:\d{4}\s+)?(?:digital\s+)?(?:`
  + String.raw`remaster(?:ed)?(?:\s+\d{4})?`
  + String.raw`|\d{4}\s+mix`
  + String.raw`|mono|stereo`
  + String.raw`|deluxe(?:\s+edition)?|bonus\s+track|expanded(?:\s+edition)?`
  + String.raw`)\s*[)\]]?\s*$`,
  'i',
);

// Markers that DO change the recording. A candidate carrying one the wanted
// title does not is a different performance and is refused, however well the
// rest matches. Kept as whole words so "Unplugged" does not match "plug".
const PERFORMANCE_MARKERS = [
  'live', 'karaoke', 'cover', 'instrumental', 'remix', 'demo', 'acoustic',
  'unplugged', 'sped up', 'slowed', 'reverb', 'edit', 'rerecorded', 're-recorded',
  'workshop', 'rehearsal', 'session', 'alternate', 'outtake',
  'single version', 'album version',
];

/** Fold a title onto its recording: lowercase, edition noise gone, punctuation gone. */
export function trackTitleKey(raw: unknown): string {
  let s = String(raw ?? '').trim();
  // Repeat: "… - 2018 Remaster (Deluxe Edition)" carries two.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(EDITION_SUFFIX, '').trim();
    if (next === s) break;
    s = next;
  }
  return nameKey(s).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/** Performance markers present in a title, as a set of the marker words. */
export function performanceMarkers(raw: unknown): Set<string> {
  const s = nameKey(raw);
  const found = new Set<string>();
  for (const marker of PERFORMANCE_MARKERS) {
    // Word-boundary either side, so "live" matches "(Live)" and "Live at Leeds"
    // but not "Olive" or "Delivery".
    const re = new RegExp(String.raw`(?:^|[^\p{L}])${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^\p{L}]|$)`, 'u');
    if (re.test(s)) found.add(marker);
  }
  return found;
}

// Duration is the strongest signal that two rows are the same performance, and
// Spotify's own master/remaster pairs differ by a second or two. Past this a
// same-titled row is almost always an extended mix or a different take.
export const DURATION_TOLERANCE_SEC = 15;

export interface AlternativeCandidateNote {
  id: string;
  title: string;
  /** Null when accepted; otherwise why it was refused — the verbose log prints these. */
  rejected: string | null;
  score?: number;
}

export interface RankedAlternatives {
  ranked: Song[];
  /** One note per candidate, in input order. Diagnostic only. */
  notes: AlternativeCandidateNote[];
}

/**
 * Order `candidates` by how likely each is to be the same recording as `want`,
 * dropping everything that is not. `known` is the set of ids already refused —
 * the store plus the id that just failed — so a chain of dead releases is never
 * walked twice.
 */
export function rankAlternatives(
  want: Pick<Song, 'id' | 'title' | 'artist' | 'duration' | 'albumId'>,
  candidates: readonly Song[],
  known: ReadonlySet<string> = new Set(),
): RankedAlternatives {
  const wantTitle = trackTitleKey(want.title);
  const wantArtist = nameKey(want.artist);
  const wantMarkers = performanceMarkers(want.title);
  const wantSec = Number(want.duration);

  const notes: AlternativeCandidateNote[] = [];
  const scored: Array<{ song: Song; score: number }> = [];

  for (const song of candidates) {
    const note: AlternativeCandidateNote = { id: song?.id ?? '', title: song?.title ?? '', rejected: null };
    notes.push(note);

    if (!song?.id) { note.rejected = 'no id'; continue; }
    if (song.id === want.id) { note.rejected = 'same track'; continue; }
    if (known.has(song.id)) { note.rejected = 'already known unplayable'; continue; }
    if (nameKey(song.artist) !== wantArtist) { note.rejected = 'different artist'; continue; }

    // The marker test comes BEFORE the title fold, and the order is the whole
    // point of having both. A marker survives the fold, so "Hurricane - Live"
    // would be refused either way — but as "different title", which is not what
    // is wrong with it. The specific reason is what the verbose log prints and
    // what tells an operator the search worked and the catalogue only has the
    // live cut.
    const markers = performanceMarkers(song.title);
    const added = [...markers].filter((m) => !wantMarkers.has(m));
    const lost = [...wantMarkers].filter((m) => !markers.has(m));
    if (added.length) { note.rejected = `adds "${added[0]}"`; continue; }
    if (lost.length) { note.rejected = `missing "${lost[0]}"`; continue; }

    if (trackTitleKey(song.title) !== wantTitle) { note.rejected = 'different title'; continue; }

    const sec = Number(song.duration);
    const drift = Number.isFinite(wantSec) && wantSec > 0 && Number.isFinite(sec) && sec > 0
      ? Math.abs(sec - wantSec)
      : null;
    if (drift != null && drift > DURATION_TOLERANCE_SEC) {
      note.rejected = `${Math.round(drift)}s from the original`;
      continue;
    }

    // Lower is better. Duration drift dominates; an unknown duration is treated
    // as the tolerance rather than as a match, so a row we can measure always
    // outranks one we cannot. A different album is a mild preference — the same
    // album answering again is usually the row that just failed under another id.
    let score = drift ?? DURATION_TOLERANCE_SEC;
    if (song.albumId && want.albumId && song.albumId === want.albumId) score += 5;
    note.score = score;
    scored.push({ song, score });
  }

  scored.sort((a, b) => a.score - b.score);
  return { ranked: scored.map((s) => s.song), notes };
}
