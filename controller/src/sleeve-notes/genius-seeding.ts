import {libraryArtistIdentity} from './artist-identity.js';
// Fill spare Genius capacity from the cached catalogue, never from a fake play
// or a MusicBrainz job. One seed at a time, bounded artist scans per turn.
import * as settings from '../settings.js';
import { randomUUID } from 'node:crypto';
import { open } from './db.js';
import { enqueueResearchJob, type RecordingForGenius } from './research-repository.js';

export function enqueueNextGeniusLibrarySeed(): boolean {
  if (!settings.get().sleeveNotes.providers.genius.enabled) return false;
  const db = open();
  if (!db.prepare('SELECT 1 FROM sleeve_connection_artist_population WHERE id=1').get()
    || !db.prepare('SELECT 1 FROM sleeve_connection_library_scan WHERE completed_at IS NOT NULL').get()) return false;
  if (db.prepare(`SELECT 1 FROM sleeve_research_jobs WHERE provider='genius' AND capability='library-seed'
    AND state IN ('queued','retry-at','running') LIMIT 1`).get()) return false;
  return db.transaction(() => {
    const cursor = db.prepare('SELECT artist_key AS key FROM sleeve_genius_seed_cursor WHERE id=1').get() as { key: string } | undefined;
    const readArtists = (after: string) => db.prepare(`SELECT name_key AS key FROM sleeve_connection_library_artists
      WHERE name_key>? GROUP BY name_key HAVING COUNT(*)=1 ORDER BY name_key LIMIT 10`)
      .all(after) as Array<{ key: string }>;
    let artists = readArtists(cursor?.key ?? '');
    if (!artists.length && cursor?.key) artists = readArtists('');
    for (const artist of artists) {
      db.prepare(`INSERT INTO sleeve_genius_seed_cursor VALUES (1,?) ON CONFLICT(id) DO UPDATE SET artist_key=excluded.artist_key`).run(artist.key);
      const track = db.prepare(`SELECT track.local_track_id AS id,track.title,track.artist,track.title_key AS titleKey
        FROM sleeve_connection_library_tracks track WHERE track.artist_key=?
        AND NOT EXISTS (SELECT 1 FROM sleeve_connection_library_tracks seen
          JOIN sleeve_local_attachments local ON local.local_track_id=seen.local_track_id
          WHERE seen.artist_key=track.artist_key AND seen.title_key=track.title_key)
        AND NOT EXISTS (SELECT 1 FROM sleeve_genius_library_seeds seed WHERE seed.local_track_id=track.local_track_id)
        AND NOT EXISTS (SELECT 1 FROM sleeve_genius_library_seeds seed WHERE seed.artist_key=track.artist_key AND seed.title_key=track.title_key)
        AND NOT EXISTS (SELECT 1 FROM sleeve_genius_traversal frontier WHERE frontier.artist_key=track.artist_key AND frontier.title_key=track.title_key)
        ORDER BY track.title_key,track.local_track_id LIMIT 1`).get(artist.key) as {
          id: string; title: string; artist: string; titleKey: string;
        } | undefined;
      if (!track) continue;
      const now = new Date().toISOString(), recordingId = randomUUID();
      const artistId = libraryArtistIdentity(db, track.artist, now);
      if (!artistId) continue;
      db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at)
        VALUES (?,?,?,'unmatched',?,?)`).run(recordingId, track.title, artistId, now, now);
      db.prepare('INSERT INTO sleeve_genius_library_seeds VALUES (?,?,?,?)').run(track.id, recordingId, track.titleKey, artist.key);
      enqueueResearchJob({ provider: 'genius', subjectType: 'recording', subjectId: recordingId,
        capability: 'library-seed', priority: 10, originLocalTrackId: track.id });
      return true;
    }
    return false;
  })();
}

export function librarySeedRecording(id: string): RecordingForGenius | null {
  return open().prepare(`SELECT recording.id,recording.title,track.artist FROM sleeve_genius_library_seeds seed
    JOIN sleeve_recordings recording ON recording.id=seed.recording_id
    JOIN sleeve_connection_library_tracks track ON track.local_track_id=seed.local_track_id
      AND track.title_key=seed.title_key AND track.artist_key=seed.artist_key
    WHERE seed.recording_id=? LIMIT 1`).get(id) as RecordingForGenius | undefined ?? null;
}

export function associateCachedLibrarySeed(localTrackId: string, songId: string): boolean {
  return open().prepare(`UPDATE sleeve_genius_library_seeds SET recording_id=(
    SELECT recording_id FROM sleeve_genius_traversal WHERE song_id=? AND source_document_id IS NOT NULL)
    WHERE local_track_id=? AND EXISTS (SELECT 1 FROM sleeve_genius_traversal WHERE song_id=? AND source_document_id IS NOT NULL)`)
    .run(songId, localTrackId, songId).changes > 0;
}
