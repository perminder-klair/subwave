// Provisional Genius songs share a verified library artist, not one artist per song.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { connectionArtistNames } from './library-connections.js';

type Artist = { id: string; name: string; musicbrainzId: string | null };

/** Match only an unambiguous library name; distinct canonical artists stay separate. */
export function libraryArtistIdentity(
  db: Database.Database,
  name: string,
  now: string,
  names = connectionArtistNames(db),
): string | null {
  const libraryName = names.libraryName(name);
  if (!libraryName) return null;
  const variants = [libraryName, libraryName.replace(/^the\s+/i, ''), `The ${libraryName}`, names.canonicalName(libraryName)??libraryName];
  const artists = db
    .prepare(
      `SELECT id,name,musicbrainz_id AS musicbrainzId FROM sleeve_artists
    WHERE lower(name) IN (lower(?),lower(?),lower(?),lower(?)) ORDER BY created_at,id`,
    )
    .all(...variants) as Artist[];
  const canonical = artists.filter(artist => artist.musicbrainzId);
  if (new Set(canonical.map(artist => artist.musicbrainzId)).size > 1) return null;
  const target = canonical[0] ?? artists[0];
  if (target) {
    for (const artist of artists) {
      if (artist.id === target.id || artist.musicbrainzId) continue;
      // Preserve artist-level research, operator decisions and provenance. Only
      // relocate provisional Genius children; recordings and their evidence keep ids.
      if (
        db
          .prepare(
            `SELECT 1 FROM sleeve_claims WHERE entity_type='artist' AND entity_id=?
        UNION ALL SELECT 1 FROM sleeve_source_documents WHERE entity_type='artist' AND entity_id=?
        UNION ALL SELECT 1 FROM sleeve_research_jobs WHERE subject_type='artist' AND subject_id=? LIMIT 1`,
          )
          .get(artist.id, artist.id, artist.id)
      )
        continue;
      db.prepare(
        `UPDATE sleeve_recordings SET artist_id=?,updated_at=? WHERE artist_id=?
        AND musicbrainz_id IS NULL AND match_state='unmatched' AND (
          EXISTS(SELECT 1 FROM sleeve_genius_traversal WHERE recording_id=sleeve_recordings.id)
          OR EXISTS(SELECT 1 FROM sleeve_genius_library_seeds WHERE recording_id=sleeve_recordings.id)
          OR EXISTS(SELECT 1 FROM sleeve_genius_local_tracks WHERE recording_id=sleeve_recordings.id))`,
      ).run(target.id, now, artist.id);
    }
    // Empty artist rows are retained for historical references, and no longer
    // produce duplicate Browse Library rows because their children have moved.
    return target.id;
  }
  const id = randomUUID();
  db.prepare('INSERT INTO sleeve_artists(id,name,created_at,updated_at) VALUES (?,?,?,?)').run(
    id,
    libraryName,
    now,
    now,
  );
  return id;
}

/** Bounded repair in the existing quiet-time catalogue worker; no provider calls. */
export function reconcileProvisionalArtists(db: Database.Database, after = ''): string {
  const names = db
    .prepare(
      `SELECT a.name,lower(a.name) AS key FROM sleeve_artists a WHERE lower(a.name)>? AND EXISTS (
      SELECT 1 FROM sleeve_recordings r WHERE r.artist_id=a.id)
    GROUP BY lower(a.name) HAVING COUNT(*)>1
      AND COUNT(DISTINCT a.musicbrainz_id)<=1 ORDER BY lower(a.name) LIMIT 5`,
    )
    .all(after) as { name: string; key: string }[];
  const identities = connectionArtistNames(db);
  db.transaction(() => {
    for (const { name } of names) libraryArtistIdentity(db, name, new Date().toISOString(), identities);
  })();
  return names.at(-1)?.key ?? '';
}

export function artistIsLocal(
  db: Database.Database,
  id: string,
  names = connectionArtistNames(db),
): boolean {
  const linked = !!db
    .prepare(
      `SELECT 1 FROM sleeve_recordings r JOIN sleeve_local_attachments l ON l.recording_id=r.id
    WHERE r.artist_id=? UNION ALL
    SELECT 1 FROM sleeve_recordings r JOIN sleeve_genius_local_tracks l ON l.recording_id=r.id
      JOIN sleeve_local_attachments a ON a.local_track_id=l.local_track_id WHERE r.artist_id=? LIMIT 1`,
    )
    .get(id, id);
  if (linked) return true;
  const artist = db.prepare('SELECT name FROM sleeve_artists WHERE id=?').get(id) as
    { name: string } | undefined;
  return !!artist && names.libraryName(artist.name) !== null;
}
