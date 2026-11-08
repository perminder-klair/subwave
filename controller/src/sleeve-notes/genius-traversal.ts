import {libraryArtistIdentity} from './artist-identity.js';
// Durable sample frontier. All network work stays in the existing Genius worker.
import { randomUUID } from 'node:crypto';
import { open } from './db.js';
import { connectionNameKey, connectionArtistNames } from './library-connections.js';
import { enqueueResearchJob, type RecordingForGenius } from './research-repository.js';
import type { SleeveProviderResult } from './provider.js';

const EXPANSION_BATCH = 20;

export function geniusTraversalArtistAllowed(artist: string | null): boolean {
  if (!artist) return false;
  return connectionArtistNames(open()).libraryName(artist)!==null;
}

export function cachedGeniusSong(recording: RecordingForGenius): SleeveProviderResult | null {
  const artistNames=connectionArtistNames(open());
  const saved = open().prepare(`SELECT content FROM sleeve_source_documents WHERE provider='genius'
    AND entity_type='recording' AND entity_id=? ORDER BY retrieved_at DESC,id DESC LIMIT 1`)
    .get(recording.id) as { content: string } | undefined;
  if (saved) {
    try {
      const result = JSON.parse(saved.content) as SleeveProviderResult;
      if (result.identity && Array.isArray(result.relationships) && Array.isArray(result.credits)
        && connectionNameKey(result.identity.title) === connectionNameKey(recording.title)
        && artistNames.key(result.identity.artist) === artistNames.key(recording.artist)) return result;
    } catch { /* Malformed retained metadata cannot supply a cache hit. */ }
  }
  const rows = open().prepare(`SELECT source.content FROM sleeve_genius_traversal frontier
    LEFT JOIN sleeve_source_documents source ON source.id = frontier.source_document_id
    WHERE frontier.title_key = ?`)
    .all(connectionNameKey(recording.title)) as Array<{ content: string | null }>;
  const names=connectionArtistNames(open());
  const matching=rows.filter(row=>{try{return names.key(JSON.parse(row.content??'null')?.identity?.artist)===names.key(recording.artist);}catch{return false;}});
  if (matching.length !== 1 || !matching[0]?.content) return null; // Same-name versions do not establish identity.
  try { return JSON.parse(matching[0].content) as SleeveProviderResult; }
  catch { return null; }
}

export function knownGeniusSongId(recording: RecordingForGenius): string | null {
  const names=connectionArtistNames(open());
  const rows = open().prepare(`SELECT song_id AS id,artist_key AS artist FROM sleeve_genius_traversal WHERE title_key=?`)
    .all(connectionNameKey(recording.title)) as Array<{ id: string;artist:string }>;
  const matching=rows.filter(row=>names.key(row.artist)===names.key(recording.artist));
  return matching.length===1?matching[0].id:null;
}

/** Reuse the shared source recording without duplicating Genius identity rows. */
export function associateCachedGeniusSong(localTrackId: string, songId: string): boolean {
  return open().prepare(`INSERT INTO sleeve_genius_local_tracks(local_track_id,recording_id)
    SELECT ?,recording_id FROM sleeve_genius_traversal WHERE song_id=? AND source_document_id IS NOT NULL
    ON CONFLICT(local_track_id) DO UPDATE SET recording_id=excluded.recording_id`)
    .run(localTrackId, songId).changes > 0;
}

export function registerGeniusTraversal(recording: RecordingForGenius, result: SleeveProviderResult): void {
  if (!/^\d+$/.test(result.identity.providerId)) return;
  const db = open();
  db.transaction(() => {
    const source = db.prepare(`SELECT id FROM sleeve_source_documents WHERE provider='genius'
      AND entity_type='recording' AND entity_id=? AND source_url=? ORDER BY retrieved_at DESC,id DESC LIMIT 1`)
      .get(recording.id, result.identity.canonicalUrl) as { id: string } | undefined;
    if (!source) return;
    db.prepare(`INSERT INTO sleeve_genius_traversal(song_id,recording_id,title_key,artist_key,source_document_id)
      VALUES (?,?,?,?,?) ON CONFLICT(song_id) DO UPDATE SET
      source_document_id=COALESCE(sleeve_genius_traversal.source_document_id,excluded.source_document_id)`)
      .run(result.identity.providerId, recording.id, connectionNameKey(result.identity.title),
        connectionNameKey(recording.artist??result.identity.artist), source.id);
    const frontier = db.prepare('SELECT recording_id AS id FROM sleeve_genius_traversal WHERE song_id=?')
      .get(result.identity.providerId) as { id: string };
    enqueueResearchJob({ provider: 'genius', subjectType: 'recording', subjectId: frontier.id,
      capability: 'expand-samples', priority: 40 });
  })();
}

export function traversalRecording(id: string): RecordingForGenius | null {
  const row=open().prepare(`SELECT recording.id,recording.title,artist.name AS artist,
    artist.musicbrainz_id AS artistMbid,frontier.song_id AS geniusSongId
    FROM sleeve_genius_traversal frontier JOIN sleeve_recordings recording ON recording.id=frontier.recording_id
    JOIN sleeve_artists artist ON artist.id=recording.artist_id WHERE frontier.recording_id=?`)
    .get(id) as (RecordingForGenius & {artistMbid:string|null}) | undefined;
  if(!row)return null;
  const {artistMbid,...recording}=row;
  return {...recording,artist:artistMbid?recording.artist:connectionArtistNames(open()).libraryName(recording.artist)??recording.artist};
}

export function traversalHasSource(id: string): boolean {
  return !!open().prepare(`SELECT 1 FROM sleeve_genius_traversal WHERE recording_id=? AND source_document_id IS NOT NULL`).get(id);
}

/** One bounded transaction per turn; caller checks broadcast priority again on
 * the next turn. Off-library boundary relationships remain in the source. */
export function expandGeniusSamples(recordingId: string): boolean {
  const db = open();
  if (!db.prepare('SELECT 1 FROM sleeve_connection_artist_population WHERE id=1').get()) return false;
  const artistNames=connectionArtistNames(db);
  return db.transaction(() => {
    const source = db.prepare(`SELECT source.content,frontier.song_id AS songId,frontier.next_relationship AS offset
      FROM sleeve_genius_traversal frontier JOIN sleeve_source_documents source ON source.id=frontier.source_document_id
      WHERE frontier.recording_id=?`).get(recordingId) as { content: string; songId: string; offset: number } | undefined;
    if (!source) return true;
    const result = JSON.parse(source.content) as SleeveProviderResult;
    const batch = result.relationships.slice(source.offset, source.offset + EXPANSION_BATCH);
    for (const relationship of batch) {
      if (!['samples', 'sampled_in'].includes(relationship.type)) continue;
      const target = relationship.target;
      if (!/^\d+$/.test(target.providerId) || !target.artist?.trim()) continue;
      if (!artistNames.libraryName(target.artist)) continue; // Unknown or ambiguous library artist: stop this branch.
      if (db.prepare('SELECT 1 FROM sleeve_genius_traversal WHERE song_id=?').get(target.providerId)) continue;
      const now = new Date().toISOString(), id = randomUUID();
      const artistId = libraryArtistIdentity(db, target.artist, now, artistNames);
      if (!artistId) continue;

      db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at)
        VALUES (?,?,?,'unmatched',?,?)`).run(id, target.title, artistId, now, now);
      db.prepare(`INSERT INTO sleeve_genius_traversal(song_id,recording_id,title_key,artist_key) VALUES (?,?,?,?)`)
        .run(target.providerId, id, connectionNameKey(target.title), connectionNameKey(target.artist));
      enqueueResearchJob({ provider: 'genius', subjectType: 'recording', subjectId: id,
        capability: 'sample-traversal', priority: 50 });
    }
    const offset = source.offset + batch.length;
    db.prepare('UPDATE sleeve_genius_traversal SET next_relationship=? WHERE song_id=?').run(offset, source.songId);
    return offset >= result.relationships.length;
  })();
}
