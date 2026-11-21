import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type Database from 'better-sqlite3';

const key = (value: string | null | undefined) => (value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();

/** Called inside encounter/catalogue transactions. Keep knowledge and history,
 * but never carry local bindings across a changed recording/version. */
export function invalidateChangedLocalIdentity(db: Database.Database, id: string, incoming: {
  title: string; artist?: string | null; album?: string | null; mbid?: string | null;
}, authoritative = false): boolean {
  const cached = authoritative ? db.prepare(`SELECT title,artist,album,musicbrainz_recording_id AS mbid
    FROM sleeve_connection_library_tracks WHERE local_track_id=?`).get(id) as typeof incoming | undefined : undefined;
  const previous = cached ?? db.prepare(`SELECT title,artist,release_title AS album,musicbrainz_recording_id AS mbid
    FROM sleeve_local_attachments WHERE local_track_id=?
    UNION ALL SELECT title,artist,album,musicbrainz_recording_id AS mbid
    FROM sleeve_connection_library_tracks WHERE local_track_id=? LIMIT 1`).get(id,id) as typeof incoming | undefined;
  if (!previous) return false;
  // A catalogue row records actual tags; attachment MBIDs can also come from
  // automatic matching. Only a previous catalogue tag proves tag removal.
  const changed = key(previous.title) !== key(incoming.title)
    || ((authoritative || incoming.artist != null) && key(previous.artist) !== key(incoming.artist))
    || ((cached !== undefined || incoming.album != null && previous.album != null) && key(previous.album) !== key(incoming.album))
    || ((cached !== undefined || incoming.mbid != null) && key(previous.mbid) !== key(incoming.mbid));
  if (!changed) return false;
  const now = new Date().toISOString();
  db.prepare(`UPDATE sleeve_local_attachments SET recording_id=NULL,match_state='unmatched',
    title=?,artist=?,release_title=?,musicbrainz_recording_id=?,updated_at=? WHERE local_track_id=?`)
    .run(incoming.title,incoming.artist??null,incoming.album??null,incoming.mbid??null,now,id);
  db.prepare("UPDATE sleeve_brain_album_requests SET release_group_id=NULL,state='failed',last_error='Library track metadata changed; request this album again.' WHERE local_track_id=?").run(id);
  db.prepare('DELETE FROM sleeve_genius_local_tracks WHERE local_track_id=?').run(id);
  db.prepare('DELETE FROM sleeve_genius_library_seeds WHERE local_track_id=?').run(id);
  db.prepare('DELETE FROM sleeve_series_library_claims WHERE local_track_id=?').run(id);
  db.prepare('DELETE FROM sleeve_connection_library_matches WHERE local_track_id=?').run(id);
  db.prepare('DELETE FROM sleeve_connection_library_tracks WHERE local_track_id=?').run(id);
  db.prepare(`UPDATE sleeve_research_jobs SET state='queued',attempts=0,run_after=NULL,
    completed_at=NULL,updated_at=? WHERE subject_type='local-track' AND subject_id=?`).run(now,id);
  return true;
}


/** Credentials are never retained. Password rotation does not change a library. */
export function librarySourceKey(): string {
  return createHash('sha256').update(JSON.stringify([
    config.navidrome.url.trim().replace(/\/+$/u,''),config.navidrome.user,
  ])).digest('hex');
}

/** Local IDs belong to one music server/account. Preserve facts and history,
 * but require a fresh catalogue and matches after changing that namespace. */
export function alignLibrarySource(db: Database.Database, fingerprint: string): void {
  db.transaction(()=>{
    const previous=db.prepare('SELECT fingerprint FROM sleeve_library_source WHERE id=1').get() as {fingerprint:string}|undefined;
    if(previous && previous.fingerprint!==fingerprint) {
      for(const table of ['sleeve_genius_local_tracks','sleeve_genius_library_seeds','sleeve_series_library_claims',
        'sleeve_connection_library_matches','sleeve_connection_library_tracks','sleeve_connection_library_artists',
        'sleeve_connection_library_scan','sleeve_connection_artist_population','sleeve_series_library_albums',
        'sleeve_genius_seed_cursor','sleeve_brain_layers']) db.prepare(`DELETE FROM ${table}`).run();
      db.prepare("UPDATE sleeve_brain_album_requests SET release_group_id=NULL,state='failed',last_error='Music source changed; request this album again.'").run();
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_library_verification'").get()) {
        db.prepare("UPDATE sleeve_library_verification SET state='cancelled' WHERE state='running'").run();
        db.prepare('DELETE FROM sleeve_artist_verification').run();
      }
      const now=new Date().toISOString();
      db.prepare("UPDATE sleeve_local_attachments SET recording_id=NULL,musicbrainz_recording_id=NULL,match_state='unmatched',updated_at=?").run(now);
      db.prepare("UPDATE sleeve_research_jobs SET state='cancelled',run_after=NULL,updated_at=? WHERE subject_type='local-track'").run(now);
      db.prepare('UPDATE sleeve_series_library_scan SET album_offset=0,next_scan_at=?,updated_at=?').run(now,now);
    }
    db.prepare('INSERT INTO sleeve_library_source(id,fingerprint) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint').run(fingerprint);
  }).immediate();
}
