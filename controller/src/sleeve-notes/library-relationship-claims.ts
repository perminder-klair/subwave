// Share one representative fact per directed, intra-library sample/cover
// relationship between the Overview count and its paged facts view.
import type Database from 'better-sqlite3';

export function libraryRelationshipClaimsSql(db: Database.Database): string {
  // Disabled cached browsing must also work before the on-disk store is upgraded.
  const sourceMatches = db.prepare("SELECT 1 FROM pragma_table_info('sleeve_connection_edges') WHERE name='source_local_track_id'").get()
    ? `UNION SELECT edge.source_local_track_id, edge.source_recording_id
        FROM sleeve_connection_edges edge JOIN sleeve_claims claim ON claim.id=edge.claim_id
        WHERE edge.source_local_track_id IS NOT NULL AND claim.enabled=1
          AND claim.evidence=edge.claim_evidence` : '';
  return `
WITH local_recordings AS (
  SELECT local_track_id, recording_id FROM sleeve_local_attachments
    WHERE match_state = 'matched' AND recording_id IS NOT NULL
  UNION SELECT local_track_id, recording_id FROM sleeve_genius_local_tracks
  UNION SELECT local_track_id, recording_id FROM sleeve_genius_library_seeds
  UNION SELECT track.local_track_id, recording.id FROM sleeve_connection_library_tracks track
    JOIN sleeve_recordings recording ON recording.musicbrainz_id = track.musicbrainz_recording_id
  ${sourceMatches}
), track_keys AS (
  SELECT track.local_track_id,
    COALESCE(NULLIF(lower(track.musicbrainz_recording_id), ''),
      MIN(NULLIF(lower(recording.musicbrainz_id), '')), MIN('recording:' || recording.id),
      'track:' || track.local_track_id) AS identity
  FROM sleeve_connection_library_tracks track
  LEFT JOIN local_recordings local ON local.local_track_id = track.local_track_id
  LEFT JOIN sleeve_recordings recording ON recording.id = local.recording_id
  GROUP BY track.local_track_id
), recording_keys AS (
  SELECT local.recording_id, MIN(track.identity) AS identity
  FROM local_recordings local JOIN track_keys track ON track.local_track_id = local.local_track_id
  GROUP BY local.recording_id
), matches AS (
  SELECT edge.claim_id, edge.relationship_type, source.identity AS source_key,
    MIN(target.identity) AS target_key
  FROM sleeve_connection_edges edge
  JOIN sleeve_claims claim ON claim.id = edge.claim_id
  JOIN recording_keys source ON source.recording_id = edge.source_recording_id
  JOIN sleeve_connection_library_matches match ON match.edge_id = edge.id
  JOIN track_keys target ON target.local_track_id = match.local_track_id
  WHERE edge.target_kind = 'recording' AND edge.match_state = 'matched'
    AND edge.relationship_type IN ('samples', 'sampled_in', 'cover_of', 'covered_by')
    AND claim.enabled = 1 AND claim.category = 'musical-connections'
    AND claim.evidence = edge.claim_evidence
  GROUP BY edge.id
  HAVING COUNT(DISTINCT target.identity) = 1
), directed AS (
  SELECT claim_id,
    CASE WHEN relationship_type IN ('samples', 'sampled_in') THEN 'sample' ELSE 'cover' END AS kind,
    CASE WHEN relationship_type IN ('sampled_in', 'covered_by') THEN target_key ELSE source_key END AS from_key,
    CASE WHEN relationship_type IN ('sampled_in', 'covered_by') THEN source_key ELSE target_key END AS to_key
  FROM matches WHERE source_key <> target_key
)
SELECT MIN(claim_id) AS claim_id FROM directed GROUP BY kind, from_key, to_key
`;
}
