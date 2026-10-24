import { invalidateChangedLocalIdentity } from './local-identity.js';
// Coverage is a local read. Explicit queueing uses the same quiet-time workers
// as encountered tracks, without creating a playback encounter.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { connectionNameKey } from './library-connections.js';

export type BrainCoverageState = 'ready' | 'empty' | 'unexplored' | 'queued' | 'researching' | 'incomplete';
export interface BrainCoverage {
  state: BrainCoverageState;
  usableStories: number;
  lastResearchedAt: string | null;
  canQueue: boolean;
  hasResearchHistory: boolean;
}
const activeStates = new Set(['queued', 'retry-at', 'running']);
export const BRAIN_RESEARCH_PRIORITY = 500;

export function brainCoverageInDatabase(db: Database.Database): Record<string, BrainCoverage> {
  const has = (table: string) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table);
  if (!has('sleeve_artists')) return {};
  const artists = db.prepare('SELECT id, name, musicbrainz_id AS mbid FROM sleeve_artists').all() as Array<{ id: string; name: string; mbid: string | null }>;
  const index = has('sleeve_connection_library_artists') ? db.prepare('SELECT local_artist_id AS id, name FROM sleeve_connection_library_artists').all() as Array<{ id: string; name: string }> : [];
  const byName = new Map<string, string[]>();
  for (const artist of artists) {
    const key = connectionNameKey(artist.name);
    byName.set(key, [...byName.get(key) ?? [], artist.id]);
  }
  const attachmentOwners = db.prepare(`SELECT DISTINCT local.artist AS name, recording.artist_id AS id
    FROM sleeve_local_attachments local JOIN sleeve_recordings recording ON recording.id = local.recording_id
    WHERE local.match_state = 'matched' AND local.artist IS NOT NULL AND recording.artist_id IS NOT NULL`).all() as Array<{ name: string; id: string }>;
  for (const owner of attachmentOwners) {
    const key = connectionNameKey(owner.name);
    const ids = new Set(byName.get(key) ?? []); ids.add(owner.id); byName.set(key, [...ids]);
  }
  const localNames = new Map<string, number>();
  for (const artist of index) {
    const key = connectionNameKey(artist.name);
    localNames.set(key, (localNames.get(key) ?? 0) + 1);
  }
  const stories = new Map<string, Set<string>>();
  const rows = db.prepare(`WITH owners AS (
      SELECT id AS entityId, 'artist' AS entityType, id AS artistId FROM sleeve_artists
      UNION SELECT id, 'recording', artist_id FROM sleeve_recordings WHERE artist_id IS NOT NULL
      UNION SELECT link.release_id, 'release', recording.artist_id FROM sleeve_recording_releases link
        JOIN sleeve_recordings recording ON recording.id = link.recording_id WHERE link.is_canonical_home = 1
      UNION SELECT release.musicbrainz_release_group_id, 'release-group', recording.artist_id
        FROM sleeve_recording_releases link JOIN sleeve_releases release ON release.id = link.release_id
        JOIN sleeve_recordings recording ON recording.id = link.recording_id WHERE link.is_canonical_home = 1
    ) SELECT DISTINCT owners.artistId, claim.id FROM owners
    JOIN sleeve_claims claim ON claim.entity_type = owners.entityType AND claim.entity_id = owners.entityId
    JOIN sleeve_source_documents source ON source.id = claim.source_document_id
    WHERE claim.enabled = 1 AND length(trim(claim.wording)) > 0 AND length(trim(claim.evidence)) > 0
      AND length(trim(source.source_url)) > 0
      AND (claim.airtime_scope = 'general' OR EXISTS (
        SELECT 1 FROM sleeve_local_attachments local JOIN sleeve_recordings recording ON recording.id = local.recording_id
        WHERE recording.artist_id = owners.artistId AND (
          (claim.airtime_scope = 'matching-release-only' AND lower(trim(local.release_title)) = lower(trim(claim.matching_release_title)))
          OR (claim.airtime_scope = 'matching-track-only' AND lower(trim(local.title)) = lower(trim(claim.matching_track_title)))
        )))`).all() as Array<{ artistId: string; id: string }>;
  for (const row of rows) {
    const ids = stories.get(row.artistId) ?? new Set<string>(); ids.add(row.id); stories.set(row.artistId, ids);
  }
  const jobs = db.prepare(`SELECT job.subject_type AS type, job.subject_id AS id, job.state, job.provider,
      job.updated_at AS updatedAt, job.completed_at AS completedAt,
      local.artist AS localArtist, recording.artist_id AS artistId,
      EXISTS (SELECT 1 FROM sleeve_wikipedia_rescan_requests request WHERE request.job_id = job.id) AS rescan
    FROM sleeve_research_jobs job
    LEFT JOIN sleeve_local_attachments local ON job.subject_type = 'local-track' AND local.local_track_id = job.subject_id
    LEFT JOIN sleeve_recordings recording ON recording.id = local.recording_id
    WHERE job.subject_type = 'artist' OR (job.provider = 'musicbrainz' AND job.capability = 'match')`).all() as Array<{
      type: string; id: string; state: string; provider: string; updatedAt: string; completedAt: string | null;
      localArtist: string | null; artistId: string | null; rescan: number;
    }>;
  const artistJobs = new Map<string, typeof jobs>();
  const nameJobs = new Map<string, typeof jobs>();
  for (const job of jobs) {
    const id = job.type === 'artist' ? job.id : job.artistId;
    if (id) artistJobs.set(id, [...artistJobs.get(id) ?? [], job]);
    if (job.type === 'local-track' && !job.artistId && job.localArtist) {
      const key = connectionNameKey(job.localArtist);
      nameJobs.set(key, [...nameJobs.get(key) ?? [], job]);
    }
  }
  function coverage(artistId: string | null, localName: string | null, canQueue: boolean): BrainCoverage {
    const relevant = artistId ? artistJobs.get(artistId) ?? []
      : localName && localNames.get(connectionNameKey(localName)) === 1 ? nameJobs.get(connectionNameKey(localName)) ?? [] : [];
    const usableStories = artistId ? stories.get(artistId)?.size ?? 0 : 0;
    const running = relevant.some(job => job.state === 'running');
    const queued = relevant.some(job => activeStates.has(job.state) || job.rescan);
    const completed = relevant.filter(job => job.provider === 'researcher' && job.state === 'complete' && !job.rescan);
    const lastResearchedAt = completed.map(job => job.completedAt ?? job.updatedAt).sort().at(-1) ?? null;
    const failed = relevant.some(job => job.state === 'failed' || job.state === 'cancelled');
    return { state: running ? 'researching' : queued ? 'queued' : usableStories ? 'ready'
      : completed.length ? 'empty' : failed ? 'incomplete' : 'unexplored', usableStories, lastResearchedAt,
      canQueue: canQueue && !queued, hasResearchHistory: usableStories > 0 || relevant.some(job => job.provider === 'researcher' || ['failed', 'cancelled'].includes(job.state)) };
  }
  const result: Record<string, BrainCoverage> = {};
  for (const artist of artists) result[`artist:${artist.id}`] = coverage(artist.id, null, !!artist.mbid);
  for (const artist of index) {
    const key = connectionNameKey(artist.name);
    const canonical = byName.get(key);
    // Names are only a display projection. The queue action resolves a real
    // library track before trusting its canonical identity.
    const artistId = localNames.get(key) === 1 && canonical?.length === 1 ? canonical[0] : null;
    result[`library-artist:${artist.id}`] = coverage(artistId, artistId ? null : artist.name, true);
  }
  return result;
}

export function queueBrainArtistInDatabase(db: Database.Database, artistId: string, now = new Date()): { queued: boolean; state: 'queued' | 'researching' } {
  return db.transaction(() => {
    const artist = db.prepare('SELECT musicbrainz_id AS mbid FROM sleeve_artists WHERE id = ?').get(artistId) as { mbid: string | null } | undefined;
    if (!artist?.mbid) throw new Error('This artist has no confirmed MusicBrainz identity yet. Queue their library artist instead.');
    const active = db.prepare(`SELECT state FROM sleeve_research_jobs WHERE subject_type = 'artist' AND subject_id = ?
      AND provider IN ('wikipedia', 'researcher') AND state IN ('queued', 'retry-at', 'running')`).all(artistId) as Array<{ state: string }>;
    if (active.length) return { queued: false, state: active.some(job => job.state === 'running') ? 'researching' : 'queued' };
    const cached = !!db.prepare(`SELECT 1 FROM sleeve_source_documents WHERE provider = 'wikipedia' AND entity_type = 'artist' AND entity_id = ?`).get(artistId);
    const provider = cached ? 'researcher' : 'wikipedia';
    const capability = cached ? 'extract-wikipedia' : 'biography';
    db.prepare(`INSERT INTO sleeve_research_jobs (id, provider, subject_type, subject_id, capability, state, priority,
        attempts, run_after, created_at, updated_at)
      VALUES (?, ?, 'artist', ?, ?, 'queued', ?, 0, NULL, ?, ?)
      ON CONFLICT(provider, subject_type, subject_id, capability) DO UPDATE SET state = 'queued', priority = excluded.priority,
        attempts = 0, run_after = NULL, completed_at = NULL, updated_at = excluded.updated_at`)
      .run(randomUUID(), provider, artistId, capability, BRAIN_RESEARCH_PRIORITY, now.toISOString(), now.toISOString());
    db.prepare(`UPDATE sleeve_research_jobs SET operator_requested = 1 WHERE provider = ? AND subject_type = 'artist'
      AND subject_id = ? AND capability = ?`).run(provider, artistId, capability);
    if (cached) {
      const job = db.prepare(`SELECT id FROM sleeve_research_jobs WHERE provider = 'researcher' AND subject_type = 'artist' AND subject_id = ? AND capability = 'extract-wikipedia'`).get(artistId) as { id: string };
      // Existing progress is archived by the worker, and existing stories stay
      // available until the replacement scan completes. Operator holds survive.
      db.prepare(`INSERT INTO sleeve_wikipedia_rescan_requests (job_id, encounter_count_at_request, requested_at, refresh_mode)
        VALUES (?, 0, ?, 'replace') ON CONFLICT(job_id) DO NOTHING`).run(job.id, now.toISOString());
    }
    return { queued: true, state: 'queued' };
  }).immediate();
}

export interface BrainLibrarySeed { id: string; title: string; artist: string; album: string | null; mbid: string | null; }
export function queueBrainLibrarySeedInDatabase(db: Database.Database, seed: BrainLibrarySeed, now = new Date()): { queued: boolean; state: 'queued' | 'researching' } {
  return db.transaction(() => {
    invalidateChangedLocalIdentity(db,seed.id,{title:seed.title,artist:seed.artist,album:seed.album,mbid:seed.mbid},true);
    const matched = db.prepare(`SELECT recording.artist_id AS id FROM sleeve_local_attachments local
      JOIN sleeve_recordings recording ON recording.id = local.recording_id WHERE local.local_track_id = ? AND local.match_state = 'matched'`).get(seed.id) as { id: string | null } | undefined;
    if (matched?.id) return queueBrainArtistInDatabase(db, matched.id, now);
    const existing = db.prepare(`SELECT state FROM sleeve_research_jobs WHERE provider = 'musicbrainz' AND subject_type = 'local-track'
      AND subject_id = ? AND capability = 'match'`).get(seed.id) as { state: string } | undefined;
    if (existing && activeStates.has(existing.state)) {
      // Mark an already queued automatic match as explicit operator work so
      // its artist lookup will not be suppressed by the automatic queue cap.
      db.prepare(`UPDATE sleeve_research_jobs SET priority = MAX(priority, ?), operator_requested = 1 WHERE provider = 'musicbrainz'
        AND subject_type = 'local-track' AND subject_id = ? AND capability = 'match'`).run(BRAIN_RESEARCH_PRIORITY, seed.id);
      return { queued: false, state: existing.state === 'running' ? 'researching' : 'queued' };
    }
    db.prepare(`INSERT INTO sleeve_local_attachments (local_track_id, title, artist, release_title, musicbrainz_recording_id,
      match_state, first_encountered_at, last_encountered_at, updated_at) VALUES (?, ?, ?, ?, ?, 'unmatched', ?, ?, ?)
      ON CONFLICT(local_track_id) DO UPDATE SET title = excluded.title, artist = excluded.artist,
        release_title = excluded.release_title, musicbrainz_recording_id = COALESCE(excluded.musicbrainz_recording_id, sleeve_local_attachments.musicbrainz_recording_id),
        updated_at = excluded.updated_at`).run(seed.id, seed.title, seed.artist, seed.album, seed.mbid, now.toISOString(), now.toISOString(), now.toISOString());
    db.prepare(`INSERT INTO sleeve_research_jobs (id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at, origin_local_track_id)
      VALUES (?, 'musicbrainz', 'local-track', ?, 'match', 'queued', ?, 0, NULL, ?, ?, ?)
      ON CONFLICT(provider, subject_type, subject_id, capability) DO UPDATE SET state = 'queued', priority = excluded.priority,
        attempts = 0, run_after = NULL, completed_at = NULL, updated_at = excluded.updated_at`)
      .run(randomUUID(), seed.id, BRAIN_RESEARCH_PRIORITY, now.toISOString(), now.toISOString(), seed.id);
    db.prepare(`UPDATE sleeve_research_jobs SET operator_requested = 1 WHERE provider = 'musicbrainz'
      AND subject_type = 'local-track' AND subject_id = ? AND capability = 'match'`).run(seed.id);
    return { queued: true, state: 'queued' };
  }).immediate();
}
