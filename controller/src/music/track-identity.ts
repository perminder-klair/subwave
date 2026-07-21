// Metadata-derived track identity — the seam that lets mood/analysis data
// survive an id change. Track rows in library.db are keyed by the ACTIVE
// source's ids, and those ids are not durable: a Navidrome full rescan
// re-mints them, the local source derives them from the file path (a
// move/rename re-mints), and switching sources replaces the whole id space.
// Reconcile used to prune the orphaned rows outright, losing their tags and
// analysis.
//
// This module is the pure half of the fix: an identity key computed from the
// tags themselves (artist|title|album, normalised), and a conservative
// one-to-one matcher pairing orphaned rows with freshly-walked live rows so
// library-db can carry the data across instead of deleting it. It matches
// only when the pairing is unambiguous in BOTH directions and durations are
// compatible — a wrong adoption (stamping tags onto a different song) is
// worse than the old behaviour (re-tag from scratch), so every doubtful case
// falls through to the prune we've always done.
//
// Pure: no DB, no settings, no I/O — unit-pinned by scripts/track-identity.test.ts.

export interface TrackIdentityFields {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationSec: number | null;
}

export interface OrphanMatch {
  orphanId: string;
  liveId: string;
}

// Durations for the same recording differ slightly across sources (Subsonic
// reports integer seconds, the local scanner rounds music-metadata's float,
// Plex converts from ms) — tolerate a few seconds, but treat a larger gap as
// a different recording (radio edit vs album cut) and refuse the match.
const DURATION_TOLERANCE_SEC = 5;

// Normalise one tag field for keying: unicode-normalise, lowercase, collapse
// runs of whitespace. Deliberately nothing cleverer (no stripping of
// "feat." / remaster suffixes) — a near-miss should NOT match.
function norm(v: string | null | undefined): string {
  if (typeof v !== 'string') return '';
  return v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Identity key for a track row, or null when the row lacks the minimum
// (artist + title) to be identifiable. Album is part of the key — the same
// song on two albums is two rows — with a missing album keying as ''.
export function identityKey(t: Pick<TrackIdentityFields, 'title' | 'artist' | 'album'>): string | null {
  const artist = norm(t.artist);
  const title = norm(t.title);
  if (!artist || !title) return null;
  return `${artist}|${title}|${norm(t.album)}`;
}

function durationsCompatible(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true; // unknown on either side — don't block
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= DURATION_TOLERANCE_SEC;
}

// Pair orphaned rows (ids the live walk didn't return, still carrying data)
// with live rows (freshly walked, no data yet) by identity key.
//
// A pair is produced only when a key maps to EXACTLY one orphan and EXACTLY
// one live row, and their durations are compatible. Keys with duplicates on
// either side are skipped wholesale: with two identical candidates there is
// no signal for which one the orphan's tags belong to.
export function matchOrphansToLive(
  orphans: readonly TrackIdentityFields[],
  live: readonly TrackIdentityFields[],
): OrphanMatch[] {
  const orphansByKey = new Map<string, TrackIdentityFields[]>();
  for (const o of orphans) {
    const key = identityKey(o);
    if (!key) continue;
    const list = orphansByKey.get(key);
    if (list) list.push(o);
    else orphansByKey.set(key, [o]);
  }
  if (orphansByKey.size === 0) return [];

  const liveByKey = new Map<string, TrackIdentityFields[]>();
  for (const l of live) {
    const key = identityKey(l);
    if (!key || !orphansByKey.has(key)) continue;
    const list = liveByKey.get(key);
    if (list) list.push(l);
    else liveByKey.set(key, [l]);
  }

  const matches: OrphanMatch[] = [];
  for (const [key, orphanList] of orphansByKey) {
    const liveList = liveByKey.get(key);
    if (!liveList || orphanList.length !== 1 || liveList.length !== 1) continue;
    const [orphan] = orphanList;
    const [target] = liveList;
    if (!durationsCompatible(orphan.durationSec, target.durationSec)) continue;
    matches.push({ orphanId: orphan.id, liveId: target.id });
  }
  return matches;
}
