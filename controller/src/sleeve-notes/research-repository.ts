import {connectionArtistNames} from './library-connections.js';
import {libraryArtistIdentity, artistIsLocal} from './artist-identity.js';
import { invalidateChangedLocalIdentity } from './local-identity.js';
import { libraryRelationshipClaimsSql } from './library-relationship-claims.js';
import type { ClaimSignal } from './claim-signal.js';
import * as settings from '../settings.js';
import { geniusAccessToken } from './genius-token.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { open } from './db.js';
import { handledCandidate, markCandidateRetained, suppressedTopic } from './moderation.js';
import { exemptFromAutomaticRecycleBin } from './recycle-policy.js';
import { connectionNameKey, libraryConnectionsInDatabase } from './library-connections.js';
import type { CanonicalMusicBrainzRecording, MusicBrainzSeriesSnapshot } from '../music/musicbrainz.js';
import type { ResearchCandidate } from './researcher.js';
import type { ProviderRelationship, SleeveProviderResult } from './provider.js';
import {
  type DefaultMusicBrainzSeries,
} from './musicbrainz-series-catalog.js';
import { activeSeriesMap, seriesCatalogInDatabase, seedSuppliedSeries } from './series-catalog-store.js';

export interface LocalEncounterInput {
  localTrackId: string;
  title: string;
  artist: string | null;
  releaseTitle: string | null;
  musicbrainzRecordingId: string | null;
  source: 'queue' | 'played';
  priority: number;
  autopilot?: boolean;
  listenerPresent?: boolean;
  encounteredAt?: string;
  host?: {id:string;name:string} | null;
}

export const AUTOPILOT_RESEARCH_QUEUE_CAP = 10;

/** With no confirmed listener, let active research drain before collecting fresh autopilot tracks. */
function hasActiveResearchJobsInDatabase(db: Database.Database): boolean {
  return !!(db.prepare(`SELECT 1 FROM sleeve_research_jobs job
    WHERE (job.state IN ('queued', 'retry-at', 'running')
      OR EXISTS (SELECT 1 FROM sleeve_wikipedia_rescan_requests request WHERE request.job_id = job.id))
      AND (job.provider <> 'genius' OR ?)
    LIMIT 1`).get(Number(settings.get().sleeveNotes.providers.genius.enabled && !!geniusAccessToken())));
}

/** Count active article jobs once per artist or album, reserving two slots for
 * each unmatched track waiting for identity resolution. */
export function activeResearchQueueSizeInDatabase(db: Database.Database, excludeMatchingTrackId?: string): number {
  const articles = (db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT subject_type, subject_id FROM sleeve_research_jobs
      WHERE (state IN ('queued', 'retry-at', 'running') OR EXISTS (
          SELECT 1 FROM sleeve_wikipedia_rescan_requests request WHERE request.job_id = sleeve_research_jobs.id
        )) AND (
        (provider = 'wikipedia' AND capability IN ('biography', 'release-group-biography'))
        OR (provider = 'researcher' AND capability IN (
          'extract-wikipedia', 'extract-wikipedia-release-group', 'extract-genius-album'))
        OR (provider = 'genius' AND capability = 'album-biography' AND ?)
      ) GROUP BY subject_type, subject_id
    )`).get(Number(settings.get().sleeveNotes.providers.genius.enabled && !!geniusAccessToken())) as { count: number }).count;
  const matchingRow = (excludeMatchingTrackId
    ? db.prepare(`SELECT COUNT(*) AS count FROM sleeve_research_jobs
      WHERE provider = 'musicbrainz' AND capability = 'match'
        AND state IN ('queued', 'retry-at', 'running') AND subject_id <> ?`)
      .get(excludeMatchingTrackId)
    : db.prepare(`SELECT COUNT(*) AS count FROM sleeve_research_jobs
    WHERE provider = 'musicbrainz' AND capability = 'match'
      AND state IN ('queued', 'retry-at', 'running')`).get()) as { count: number };
  // Reserve two article slots for each unresolved match, since one result can
  // create both an artist job and an album job.
  return articles + matchingRow.count * 2;
}

/**
 * Record a station encounter and arrange its first, low-cost identity task.
 * It is intentionally idempotent for a local track: repeated queue/watch
 * notifications update recency and raise priority, but never create a flood
 * of MusicBrainz work.
 */
export function admitLocalEncounter(input: LocalEncounterInput): void {
  admitLocalEncounterInDatabase(open(), input);
}

export function admitLocalEncounterInDatabase(db: Database.Database, input: LocalEncounterInput): void {
  const now = input.encounteredAt ?? new Date().toISOString();
  const priority = Math.max(0, Math.trunc(input.priority));
  const transaction = db.transaction(() => {
    const alreadyKnown = !!db.prepare('SELECT 1 FROM sleeve_local_attachments WHERE local_track_id = ?')
      .get(input.localTrackId);
    if (input.autopilot && !input.listenerPresent && !alreadyKnown && hasActiveResearchJobsInDatabase(db)) return;
    invalidateChangedLocalIdentity(db,input.localTrackId,{
      title:input.title,artist:input.artist,album:input.releaseTitle,mbid:input.musicbrainzRecordingId,
    });
    db.prepare(`INSERT INTO sleeve_local_attachments (
      local_track_id, recording_id, title, artist, release_title,
      musicbrainz_recording_id, match_state, first_encountered_at,
      last_encountered_at, updated_at
    ) VALUES (?, NULL, ?, ?, ?, ?, 'unmatched', ?, ?, ?)
    ON CONFLICT(local_track_id) DO UPDATE SET
      title = excluded.title,
      artist = COALESCE(excluded.artist, sleeve_local_attachments.artist),
      release_title = COALESCE(excluded.release_title, sleeve_local_attachments.release_title),
      musicbrainz_recording_id = COALESCE(excluded.musicbrainz_recording_id, sleeve_local_attachments.musicbrainz_recording_id),
      last_encountered_at = excluded.last_encountered_at,
      updated_at = excluded.updated_at`)
      .run(input.localTrackId, input.title, input.artist, input.releaseTitle,
        input.musicbrainzRecordingId, now, now, now);
    db.prepare(`INSERT INTO sleeve_encounters (id, local_track_id, source, encountered_at, host_id, host_name)
      VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), input.localTrackId, input.source, now,
        input.source === 'played' ? input.host?.id ?? null : null,
        input.source === 'played' ? input.host?.name ?? null : null);
    db.prepare(`INSERT INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at
    ) VALUES (?, 'musicbrainz', 'local-track', ?, 'match', 'queued', ?, 0, NULL, ?, ?)
    ON CONFLICT(provider, subject_type, subject_id, capability) DO UPDATE SET
      priority = MAX(sleeve_research_jobs.priority, excluded.priority),
      state = CASE WHEN sleeve_research_jobs.state IN ('failed', 'cancelled') THEN 'queued' ELSE sleeve_research_jobs.state END,
      updated_at = excluded.updated_at`)
      .run(randomUUID(), input.localTrackId, priority, now, now);
    if (input.artist?.trim()) enqueueResearchJobInDatabase(db, {
      provider: 'genius', subjectType: 'local-track', subjectId: input.localTrackId,
      capability: 'connections', priority: 110, now, originLocalTrackId: input.localTrackId,
    });
    if (input.source === 'played') queueWikipediaRefreshForEncounterInDatabase(db, input.localTrackId, now);
  });
  transaction();
}

/** Queue one cached-article refresh only after a matching artist or album is played. */
function queueWikipediaRefreshForEncounterInDatabase(
  db: Database.Database, localTrackId: string, now: string,
): number {
  const plan = db.prepare(`SELECT requested_at AS requestedAt
    FROM sleeve_wikipedia_refresh_plan WHERE id = 1`).get() as { requestedAt: string } | undefined;
  if (!plan) return 0;

  const entities = db.prepare(`SELECT 'artist' AS entityType, recording.artist_id AS entityId
      FROM sleeve_local_attachments attachment
      JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
      WHERE attachment.local_track_id = ? AND recording.artist_id IS NOT NULL
    UNION
    SELECT 'release-group' AS entityType, release.musicbrainz_release_group_id AS entityId
      FROM sleeve_local_attachments attachment
      JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
      JOIN sleeve_recording_releases link ON link.recording_id = recording.id
        AND link.is_canonical_home = 1 AND link.is_compilation = 0
      JOIN sleeve_releases release ON release.id = link.release_id
      WHERE attachment.local_track_id = ? AND release.primary_type = 'Album'
        AND release.musicbrainz_release_group_id IS NOT NULL`)
    .all(localTrackId, localTrackId) as Array<{
      entityType: 'artist' | 'release-group'; entityId: string;
    }>;
  let queued = 0;
  for (const entity of entities) {
    const latestSource = db.prepare(`SELECT source.id FROM sleeve_source_documents source
      WHERE source.provider = 'wikipedia' AND source.entity_type = ? AND source.entity_id = ?
        AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
          WHERE latest.provider = 'wikipedia' AND latest.entity_type = source.entity_type
            AND latest.entity_id = source.entity_id ORDER BY latest.retrieved_at DESC LIMIT 1)
        AND source.retrieved_at <= ? LIMIT 1`)
      .get(entity.entityType, entity.entityId, plan.requestedAt);
    if (!latestSource) continue;

    const encounters = db.prepare(entity.entityType === 'artist'
      ? `SELECT COUNT(DISTINCT CASE WHEN encounter.encountered_at <= ? THEN encounter.id END) AS beforeCount,
          COUNT(DISTINCT CASE WHEN encounter.encountered_at > ? THEN encounter.id END) AS afterCount
        FROM sleeve_encounters encounter
        JOIN sleeve_local_attachments attachment ON attachment.local_track_id = encounter.local_track_id
        JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
        WHERE encounter.source = 'played' AND recording.artist_id = ?`
      : `SELECT COUNT(DISTINCT CASE WHEN encounter.encountered_at <= ? THEN encounter.id END) AS beforeCount,
          COUNT(DISTINCT CASE WHEN encounter.encountered_at > ? THEN encounter.id END) AS afterCount
        FROM sleeve_encounters encounter
        JOIN sleeve_local_attachments attachment ON attachment.local_track_id = encounter.local_track_id
        JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
        JOIN sleeve_recording_releases appearance ON appearance.recording_id = recording.id
        JOIN sleeve_releases release ON release.id = appearance.release_id
        WHERE encounter.source = 'played' AND release.musicbrainz_release_group_id = ?`)
      .get(plan.requestedAt, plan.requestedAt, entity.entityId) as { beforeCount: number; afterCount: number };
    if (encounters.afterCount < 1) continue;

    const subjectType = entity.entityType === 'artist' ? 'artist' : 'release';
    const capability = entity.entityType === 'artist'
      ? 'extract-wikipedia' : 'extract-wikipedia-release-group';
    const existing = db.prepare(`SELECT id, state,
        wikipedia_refreshed_at AS wikipediaRefreshedAt
      FROM sleeve_research_jobs WHERE provider = 'researcher' AND subject_type = ?
        AND subject_id = ? AND capability = ?`)
      .get(subjectType, entity.entityId, capability) as {
        id: string; state: string; wikipediaRefreshedAt: string | null;
      } | undefined;
    if (existing?.wikipediaRefreshedAt
      && Date.parse(existing.wikipediaRefreshedAt) >= Date.parse(plan.requestedAt)) continue;

    enqueueResearchJobInDatabase(db, {
      provider: 'researcher', subjectType, subjectId: entity.entityId, capability,
      priority: entity.entityType === 'artist' ? 300 : 350, now, originLocalTrackId: localTrackId,
    });
    const job = db.prepare(`SELECT id FROM sleeve_research_jobs
      WHERE provider = 'researcher' AND subject_type = ? AND subject_id = ? AND capability = ?`)
      .get(subjectType, entity.entityId, capability) as { id: string } | undefined;
    if (!job) continue;
    const pending = db.prepare(`SELECT 1 FROM sleeve_wikipedia_rescan_requests WHERE job_id = ?`)
      .get(job.id);
    if (pending) continue;
    db.prepare(`INSERT INTO sleeve_wikipedia_rescan_requests
      (job_id, encounter_count_at_request, requested_at, refresh_mode) VALUES (?, ?, ?, 'replace')`)
      .run(job.id, encounters.beforeCount, plan.requestedAt);
    queued++;
  }
  return queued;
}

export interface PendingResearchJob {
  id: string;
  provider: string;
  subjectType: 'local-track' | 'artist' | 'recording' | 'release';
  subjectId: string;
  capability: string;
  priority: number;
  attempts: number;
  originLocalTrackId: string | null;
}

/** The later quiet-time worker takes only one durable task at a time. */
export function nextPendingResearchJob(provider: string, filter?: {
  subjectType?: PendingResearchJob['subjectType'];
  capability?: string;
  promotedOnly?: boolean;
}): PendingResearchJob | null {
  return nextPendingResearchJobInDatabase(open(), provider, filter);
}

export function nextPendingResearchJobInDatabase(db: Database.Database, provider: string, filter?: {
  subjectType?: PendingResearchJob['subjectType'];
  capability?: string;
  promotedOnly?: boolean;
}): PendingResearchJob | null {
  const clauses = ['provider = ?', "state IN ('queued', 'retry-at')", '(run_after IS NULL OR run_after <= ?)'];
  const values: Array<string> = [provider, new Date().toISOString()];
  if (filter?.promotedOnly) clauses.push('id IN (SELECT job_id FROM sleeve_queue_promotions)');
  if (filter?.subjectType) { clauses.push('subject_type = ?'); values.push(filter.subjectType); }
  if (filter?.capability) { clauses.push('capability = ?'); values.push(filter.capability); }
  const row = db.prepare(`SELECT id, provider, subject_type AS subjectType,
      subject_id AS subjectId, capability, priority, attempts,
      origin_local_track_id AS originLocalTrackId
    FROM sleeve_research_jobs
    WHERE ${clauses.join(' AND ')} ORDER BY (SELECT requested_at FROM sleeve_queue_promotions WHERE job_id=sleeve_research_jobs.id) DESC, priority DESC, created_at ASC LIMIT 1`)
    .get(...values) as PendingResearchJob | undefined;
  return row ?? null;
}

export interface LocalAttachmentForMatch {
  localTrackId: string;
  title: string;
  artist: string | null;
  musicbrainzRecordingId: string | null;
}

export function localAttachmentForMatch(localTrackId: string): LocalAttachmentForMatch | null {
  const row = open().prepare(`SELECT local_track_id AS localTrackId, title, artist,
      musicbrainz_recording_id AS musicbrainzRecordingId
    FROM sleeve_local_attachments WHERE local_track_id = ?`).get(localTrackId) as LocalAttachmentForMatch | undefined;
  return row ?? null;
}

export interface ArtistForResearch { id: string; name: string; musicBrainzId: string; }

export function artistForResearch(id: string): ArtistForResearch | null {
  const row = open().prepare('SELECT id, name, musicbrainz_id AS musicBrainzId FROM sleeve_artists WHERE id = ?').get(id) as ArtistForResearch | undefined;
  return row ?? null;
}

export function startProviderRequest(input: { provider: string; capability: string }): string {
  const id = randomUUID();
  open().prepare(`INSERT INTO sleeve_provider_requests (id, provider, capability, requested_at, outcome)
    VALUES (?, ?, ?, ?, 'started')`).run(id, input.provider, input.capability, new Date().toISOString());
  return id;
}

export function finishProviderRequest(id: string, outcome: 'ready' | 'no-match' | 'failed' | 'rate-limited', statusCode: number | null = null): void {
  open().prepare(`UPDATE sleeve_provider_requests SET outcome = ?, status_code = ?, completed_at = ? WHERE id = ?`)
    .run(outcome, statusCode, new Date().toISOString(), id);
}

export interface CanonicalReleaseForResearch {
  id: string;
  title: string;
  musicbrainzReleaseId: string;
  releaseGroupId: string | null;
  primaryType: string | null;
  status: string | null;
  date: string | null;
  country: string | null;
  selectionReason: string | null;
}

export function canonicalReleaseForResearch(id: string): CanonicalReleaseForResearch | null {
  return canonicalReleaseForResearchInDatabase(open(), id);
}

export function canonicalReleaseForResearchInDatabase(db: Database.Database, id: string): CanonicalReleaseForResearch | null {
  const row = db.prepare(`SELECT r.id, r.title, r.musicbrainz_release_id AS musicbrainzReleaseId,
    r.musicbrainz_release_group_id AS releaseGroupId, r.primary_type AS primaryType, r.status,
    rr.release_date AS date, rr.country, rr.selection_reason AS selectionReason
    FROM sleeve_releases r JOIN sleeve_recording_releases rr ON rr.release_id = r.id
    WHERE r.id = ? AND rr.is_canonical_home = 1`).get(id) as CanonicalReleaseForResearch | undefined;
  return row ?? null;
}

/** Return the station's selected canonical release for a matched local track. */
export function canonicalReleaseForLocalTrack(localTrackId: string): { title: string; date: string | null } | null {
  const id = String(localTrackId ?? '').trim();
  if (!id) return null;
  const row = open().prepare(`SELECT release.title, rr.release_date AS date
    FROM sleeve_local_attachments attachment
    JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
    JOIN sleeve_recording_releases rr ON rr.recording_id = recording.id AND rr.is_canonical_home = 1
    JOIN sleeve_releases release ON release.id = rr.release_id
    WHERE attachment.local_track_id = ? AND attachment.match_state = 'matched'
      AND recording.match_state = 'matched'
    LIMIT 1`).get(id) as { title: string; date: string | null } | undefined;
  return row ?? null;
}

export interface RecordingForGenius { id: string; title: string; artist: string | null; geniusSongId?: string | null; }

export function recordingForGenius(id: string): RecordingForGenius | null {
  const row = open().prepare(`SELECT r.id, r.title, a.name AS artist,
      (SELECT CASE WHEN json_valid(source.content) THEN CAST(json_extract(source.content, '$.identity.providerId') AS TEXT) END
        FROM sleeve_source_documents source
        WHERE source.provider = 'genius' AND source.entity_type = 'recording' AND source.entity_id = r.id
        ORDER BY source.retrieved_at DESC, source.id DESC LIMIT 1) AS geniusSongId
    FROM sleeve_recordings r LEFT JOIN sleeve_artists a ON a.id = r.artist_id
    WHERE r.id = ? AND r.match_state = 'matched' AND a.name IS NOT NULL`).get(id) as RecordingForGenius | undefined;
  if (!row) return null;
  return { ...row, geniusSongId: typeof row.geniusSongId === 'string' && /^\d+$/.test(row.geniusSongId)
    ? row.geniusSongId : null };
}

/** Local research identity is not a MusicBrainz confirmation. Never repoint the
 * canonical attachment or move existing claims when the other provider resolves. */
export function localRecordingForGenius(localTrackId: string): RecordingForGenius | null {
  const db = open();
  return db.transaction(() => {
    const local = db.prepare(`SELECT title, artist, recording_id AS recordingId
      FROM sleeve_local_attachments WHERE local_track_id = ?`).get(localTrackId) as {
        title: string; artist: string | null; recordingId: string | null;
      } | undefined;
    if (!local?.artist?.trim()) return null;
    if (local.recordingId) {
      const canonical = recordingForGenius(local.recordingId);
      if (canonical) return canonical;
    }
    const saved = db.prepare(`SELECT recording.id, recording.title, artist.name AS artist
      FROM sleeve_genius_local_tracks local JOIN sleeve_recordings recording ON recording.id = local.recording_id
      LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id WHERE local.local_track_id = ?`)
      .get(localTrackId) as { id: string; title: string; artist: string | null } | undefined;
    const sameMetadata = saved && connectionNameKey(saved.title) === connectionNameKey(local.title)
      && connectionNameKey(saved.artist) === connectionNameKey(local.artist);
    if (saved && !sameMetadata) db.prepare('DELETE FROM sleeve_genius_local_tracks WHERE local_track_id = ?').run(localTrackId);
    let id = sameMetadata ? saved.id : undefined;
    if (!id) {
      const now = new Date().toISOString();
      const artistId = local.artist ? libraryArtistIdentity(db, local.artist, now) ?? randomUUID() : randomUUID();
      id = randomUUID();
      db.prepare(`INSERT OR IGNORE INTO sleeve_artists(id,name,created_at,updated_at) VALUES (?,?,?,?)`)
        .run(artistId, local.artist, now, now);
      db.prepare(`INSERT INTO sleeve_recordings(id,title,artist_id,match_state,created_at,updated_at)
        VALUES (?,?,?,'unmatched',?,?)`).run(id, local.title, artistId, now, now);
      db.prepare(`INSERT INTO sleeve_genius_local_tracks(local_track_id,recording_id) VALUES (?,?)`).run(localTrackId, id);
    }
    const source = db.prepare(`SELECT content FROM sleeve_source_documents
      WHERE provider = 'genius' AND entity_type = 'recording' AND entity_id = ?
      ORDER BY retrieved_at DESC, id DESC LIMIT 1`).get(id) as { content: string } | undefined;
    let geniusSongId: string | null = null;
    try {
      const identity = JSON.parse(source?.content ?? '{}').identity;
      if (/^\d+$/.test(String(identity?.providerId ?? ''))) geniusSongId = String(identity.providerId);
    } catch { /* Invalid cached metadata does not establish an identity. */ }
    return { id, title: local.title, artist: local.artist, geniusSongId };
  })();
}

export function retainSourceDocument(input: {
  entityType: 'artist' | 'recording' | 'release' | 'release-group';
  entityId: string;
  provider: string;
  sourceUrl: string;
  revisionId: string | null;
  contentKind: 'bounded-text' | 'structured-json';
  content: string;
  attribution: string;
}): string {
  return retainSourceDocumentInDatabase(open(), input);
}

function retainSourceDocumentInDatabase(db: Database.Database, input: {
  entityType: 'artist' | 'recording' | 'release' | 'release-group';
  entityId: string;
  provider: string;
  sourceUrl: string;
  revisionId: string | null;
  contentKind: 'bounded-text' | 'structured-json';
  content: string;
  attribution: string;
}): string {
  const contentHash = createHash('sha256').update(input.content).digest('hex');
  return db.transaction(()=>{
    // SQLite UNIQUE permits repeated NULL revisions. Resolve identity explicitly
    // so an unchanged article can rehydrate its existing citations after pruning.
    const existing=db.prepare(`SELECT id,wikipedia_pruned_at AS prunedAt FROM sleeve_source_documents
      WHERE provider=? AND entity_type=? AND entity_id=? AND source_url=? AND revision_id IS ? AND content_hash=? LIMIT 1`)
      .get(input.provider,input.entityType,input.entityId,input.sourceUrl,input.revisionId,contentHash) as {id:string;prunedAt:string|null}|undefined;
    const now=new Date().toISOString();
    if(existing) {
      db.prepare(`UPDATE sleeve_source_documents SET content=?,wikipedia_pruned_at=NULL,wikipedia_completed_at=NULL,retrieved_at=?,attribution=? WHERE id=?`)
        .run(input.content,now,input.attribution,existing.id);
      if(existing.prunedAt) {
        db.prepare('DELETE FROM sleeve_wikipedia_scan_progress WHERE source_document_id=?').run(existing.id);
        db.prepare('DELETE FROM sleeve_wikipedia_scan_chunks WHERE source_document_id=?').run(existing.id);
      }
      return existing.id;
    }
    const id=randomUUID();
    db.prepare(`INSERT INTO sleeve_source_documents (id,entity_type,entity_id,provider,source_url,revision_id,
      content_hash,content_kind,content,attribution,retrieved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,input.entityType,input.entityId,input.provider,input.sourceUrl,input.revisionId,contentHash,input.contentKind,input.content,input.attribution,now);
    return id;
  }).immediate();
}

const MUSICBRAINZ_SERIES_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const MUSICBRAINZ_SERIES_LEASE_MS = 15 * 60 * 1000;

export interface DueMusicBrainzSeries extends DefaultMusicBrainzSeries {
  attempts: number;
}

function ensureDefaultMusicBrainzSeriesRows(db: Database.Database, now: Date): void {
  seedSuppliedSeries(db, now);
}

/** Reserve one due allowlisted Series refresh; the short lease survives a process restart. */
export function reserveDueMusicBrainzSeries(now = new Date()): DueMusicBrainzSeries | null {
  const db = open();
  return db.transaction((): DueMusicBrainzSeries | null => {
    ensureDefaultMusicBrainzSeriesRows(db, now);
    const row = db.prepare(`SELECT series_mbid AS id, attempts
      FROM sleeve_musicbrainz_series WHERE enabled = 1 AND removed = 0 AND next_refresh_at <= ?
      ORDER BY series_order ASC LIMIT 1`).get(now.toISOString()) as { id: string; attempts: number } | undefined;
    if (!row) return null;
    const series = activeSeriesMap(db).get(row.id);
    if (!series) return null;
    const leaseUntil = new Date(now.getTime() + MUSICBRAINZ_SERIES_LEASE_MS).toISOString();
    db.prepare(`UPDATE sleeve_musicbrainz_series
      SET next_refresh_at = ?, attempts = attempts + 1, last_error = NULL, updated_at = ?
      WHERE series_mbid = ?`).run(leaseUntil, now.toISOString(), row.id);
    return { ...series, attempts: row.attempts + 1 };
  }).immediate();
}

/** Retry a failed Series fetch without blocking other MusicBrainz capabilities. */
export function deferMusicBrainzSeriesRefresh(id: string, error: string, delayMs: number, now = new Date()): void {
  const boundedError = error.slice(0, 500);
  const next = new Date(now.getTime() + Math.max(60_000, delayMs)).toISOString();
  open().prepare(`UPDATE sleeve_musicbrainz_series
    SET next_refresh_at = ?, last_error = ?, updated_at = ? WHERE series_mbid = ?`)
    .run(next, boundedError, now.toISOString(), id);
}

export interface RetainedMusicBrainzSeriesSnapshot { members: number; claimsEnabled: number; }

/** Replace one cached list snapshot and refresh only already matched local entities. */
export function retainMusicBrainzSeriesSnapshot(
  series: DefaultMusicBrainzSeries,
  snapshot: MusicBrainzSeriesSnapshot,
  now = new Date(),
): RetainedMusicBrainzSeriesSnapshot {
  if (snapshot.id !== series.id) throw new Error('MusicBrainz Series response ID did not match the requested list');
  const db = open();
  return db.transaction((): RetainedMusicBrainzSeriesSnapshot => {
    ensureDefaultMusicBrainzSeriesRows(db, now);
    const configured = activeSeriesMap(db).get(series.id);
    if (!configured) return { members: snapshot.members.length, claimsEnabled: 0 };
    series = configured;
    const previous = db.prepare(`SELECT entity_mbid AS entityMbid, entity_title AS title, rank_value AS rank
      FROM sleeve_musicbrainz_series_members WHERE series_mbid = ?`).all(series.id) as Array<{ entityMbid: string; title: string; rank: string | null }>;
    const incoming = new Map(snapshot.members.map((member) => [member.id, member]));
    const fetchedAt = now.toISOString();
    const nextRefresh = new Date(now.getTime() + MUSICBRAINZ_SERIES_REFRESH_MS).toISOString();
    db.prepare(`UPDATE sleeve_musicbrainz_series SET fetched_at = ?, next_refresh_at = ?,
      attempts = 0, last_error = NULL, updated_at = ? WHERE series_mbid = ?`)
      .run(fetchedAt, nextRefresh, fetchedAt, series.id);
    // A successful check of an unchanged list does not invalidate saved matches.
    if (configured.fetchedAt && previous.length === incoming.size && previous.every(member => {
      const next = incoming.get(member.entityMbid);
      return next && next.title === member.title && next.rank === member.rank;
    })) return { members: snapshot.members.length, claimsEnabled: 0 };
    const affected = new Set([...previous.map((member) => member.entityMbid), ...incoming.keys()]);

    db.prepare('DELETE FROM sleeve_musicbrainz_series_members WHERE series_mbid = ?').run(series.id);
    const insertMember = db.prepare(`INSERT INTO sleeve_musicbrainz_series_members
      (series_mbid, entity_mbid, entity_title, rank_value) VALUES (?, ?, ?, ?)`);
    for (const member of incoming.values()) {
      insertMember.run(series.id, member.id, member.title, member.rank);
    }

    // A refreshed list may remove a member or change its rank/edition wording.
    // Rebuild library links from exact identities rather than offering a stale claim.
    db.prepare('DELETE FROM sleeve_series_library_claims WHERE series_mbid = ?').run(series.id);
    db.prepare(`UPDATE sleeve_claims SET enabled = 0 WHERE operator_state = 'auto'
      AND source_document_id IN (SELECT id FROM sleeve_source_documents
        WHERE provider = 'musicbrainz-series' AND source_url = ?)`).run(seriesSourceUrl(series.id));
    db.prepare(`UPDATE sleeve_series_library_scan SET album_offset = 0,
      next_scan_at = ?, updated_at = ? WHERE id = 1`).run(now.toISOString(), now.toISOString());

    let claimsEnabled = 0;
    for (const memberId of affected) {
      if (series.entityType === 'recording') {
        claimsEnabled += reconcileRecordingRecognitionInDatabase(db, memberId, [series.id]);
      } else {
        const familyIds = series.editionGroup === '1001-albums'
          ? [...activeSeriesMap(db).values()].filter((item) => item.editionGroup === '1001-albums').map((item) => item.id)
          : [series.id];
        claimsEnabled += reconcileReleaseGroupRecognitionInDatabase(db, memberId, familyIds);
      }
    }

    return { members: snapshot.members.length, claimsEnabled };
  }).immediate();
}

/** Configuration changes use only cached identities, never provider/library calls. */
export function reconcileConfiguredSeries(ids: string[]): void {
  const db = open();
  const all = seriesCatalogInDatabase(db, true);
  const affected = ids.some((id) => all.find((item) => item.id === id)?.editionGroup === '1001-albums')
    ? [...new Set([...ids, ...all.filter((item) => item.editionGroup === '1001-albums').map((item) => item.id)])] : ids;
  const placeholders = affected.map(() => '?').join(', ');
  const catalog = activeSeriesMap(db);
  for (const id of affected) db.prepare(`UPDATE sleeve_claims SET enabled = 0 WHERE operator_state = 'auto'
    AND source_document_id IN (SELECT id FROM sleeve_source_documents WHERE provider = 'musicbrainz-series' AND source_url = ?)`).run(seriesSourceUrl(id));
  const members = db.prepare(`SELECT DISTINCT series.entity_type AS type, member.entity_mbid AS id
    FROM sleeve_musicbrainz_series_members member JOIN sleeve_musicbrainz_series series ON series.series_mbid = member.series_mbid
    WHERE series.series_mbid IN (${placeholders})`).all(...affected) as Array<{ type: string; id: string }>;
  const recordingIds = [...catalog.values()].filter((item) => item.entityType === 'recording').map((item) => item.id);
  const albumIds = [...catalog.values()].filter((item) => item.entityType === 'release-group').map((item) => item.id);
  for (const member of members) {
    if (member.type === 'recording') reconcileRecordingRecognitionInDatabase(db, member.id, recordingIds);
    else reconcileReleaseGroupRecognitionInDatabase(db, member.id, albumIds);
  }
  const albums = db.prepare(`SELECT DISTINCT local_album_id AS id FROM sleeve_series_library_claims WHERE series_mbid IN (${placeholders})`).all(...affected) as Array<{ id: string }>;
  for (const album of albums) {
    const links = db.prepare(`SELECT link.local_track_id AS track, link.member_mbid AS member, series.entity_type AS type
      FROM sleeve_series_library_claims link JOIN sleeve_musicbrainz_series series ON series.series_mbid = link.series_mbid
      WHERE link.local_album_id = ?`).all(album.id) as Array<{ track: string; member: string; type: string }>;
    const songs = new Map(links.map((link) => [link.track, { id: link.track, musicBrainzId: null as string | null }]));
    for (const link of links) if (link.type === 'recording') songs.get(link.track)!.musicBrainzId = link.member;
    retainLibrarySeriesClaims({ localAlbumId: album.id, releaseGroupMbid: links.find((link) => link.type === 'release-group')?.member ?? null, songs: [...songs.values()] });
  }
}

function seriesSourceUrl(seriesId: string): string {
  return `https://musicbrainz.org/series/${encodeURIComponent(seriesId)}`;
}

function disableSeriesClaimsForLocalEntity(
  db: Database.Database,
  seriesIds: readonly string[],
  entityType: 'recording' | 'release',
  entityId: string,
): void {
  if (!seriesIds.length) return;
  const urls = seriesIds.map(seriesSourceUrl);
  const placeholders = urls.map(() => '?').join(', ');
  db.prepare(`UPDATE sleeve_claims SET enabled = 0
    WHERE entity_type = ? AND entity_id = ? AND category = 'recognition'
      AND operator_state = 'auto'
      AND source_document_id IN (
        SELECT id FROM sleeve_source_documents
        WHERE provider = 'musicbrainz-series' AND source_url IN (${placeholders})
      )`).run(entityType, entityId, ...urls);
}

function recognitionWording(
  series: DefaultMusicBrainzSeries,
  title: string,
  rank: string | null,
): string {
  if (series.editionGroup === '1001-albums' && series.editionYear) {
    const action = series.editionYear === 2005 ? 'was included in' : 'was added to';
    return `“${title}” ${action} the ${series.editionYear} edition of 1001 Albums You Must Hear Before You Die.`;
  }
  if (series.ranked && rank) return `“${title}” was ranked number ${rank} in ${series.label}.`;
  return `“${title}” was included in ${series.label}.`;
}

function retainSeriesRecognitionClaim(
  db: Database.Database,
  series: DefaultMusicBrainzSeries,
  entityType: 'recording' | 'release' | 'release-group',
  entityId: string,
  member: { id: string; title: string; rank: string | null },
  now: Date,
): string {
  const sourceUrl = seriesSourceUrl(series.id);
  const evidence = JSON.stringify({
    seriesId: series.id,
    seriesName: series.label,
    localEntityId: entityId,
    memberType: series.entityType,
    memberId: member.id,
    memberTitle: member.title,
    rank: series.ranked ? member.rank : null,
    editionYear: series.editionYear ?? null,
  });
  const sourceDocumentId = retainSourceDocumentInDatabase(db, {
    entityType, entityId, provider: 'musicbrainz-series', sourceUrl,
    revisionId: null, contentKind: 'structured-json', content: evidence,
    attribution: 'MusicBrainz data, CC0',
  });
  const topic = series.editionGroup === '1001-albums'
    ? '1001 Albums You Must Hear Before You Die'
    : series.label;
  db.prepare(`INSERT INTO sleeve_claims (
    id, entity_type, entity_id, category, topic, wording, source_document_id,
    evidence, enabled, created_at, updated_at
  ) VALUES (?, ?, ?, 'recognition', ?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT(entity_type, entity_id, category, topic, source_document_id) DO UPDATE SET
    wording = excluded.wording, evidence = excluded.evidence,
    enabled = 1, updated_at = excluded.updated_at
    WHERE sleeve_claims.operator_state = 'auto'`)
    .run(randomUUID(), entityType, entityId, topic,
      recognitionWording(series, member.title, series.ranked ? member.rank : null),
      sourceDocumentId, evidence, now.toISOString(), now.toISOString());
  const claim = db.prepare(`SELECT id FROM sleeve_claims WHERE entity_type = ? AND entity_id = ?
    AND category = 'recognition' AND topic = ? AND source_document_id = ?`)
    .get(entityType, entityId, topic, sourceDocumentId) as { id: string } | undefined;
  if (!claim) throw new Error('MusicBrainz Series claim was not retained');
  return claim.id;
}

/** Share the existing catalogue scan; only changed albums need Series matching. */
export function observeSeriesLibraryAlbum(
  db: Database.Database,
  album: { id: string; name?: string; musicBrainzId?: string },
  songs: ReadonlyArray<{ id: string; musicBrainzId?: string }>,
  matched = false,
  generation: string | null = null,
): void {
  const fingerprint = createHash('sha256').update(JSON.stringify([
    album.name ?? '', (album.musicBrainzId ?? '').trim().toLowerCase(),
    songs.map(song => [String(song.id), (song.musicBrainzId ?? '').trim().toLowerCase()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  ])).digest('hex');
  db.prepare(`INSERT INTO sleeve_series_library_albums(local_album_id, fingerprint, pending, scan_generation)
    VALUES (?, ?, ?, ?) ON CONFLICT(local_album_id) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      scan_generation = COALESCE(excluded.scan_generation, scan_generation),
      pending = CASE WHEN ? THEN 0 WHEN fingerprint <> excluded.fingerprint THEN 1 ELSE pending END`)
    .run(album.id, fingerprint, matched ? 0 : 1, generation, Number(matched));
}

export function pendingSeriesLibraryAlbums(limit = 25): string[] {
  return (open().prepare(`SELECT local_album_id AS id FROM sleeve_series_library_albums
    WHERE pending = 1 ORDER BY local_album_id LIMIT ?`).all(limit) as Array<{ id: string }>).map(row => row.id);
}

/** A resumable, quiet-time sweep; no station link waits for Navidrome or MusicBrainz. */
export function dueSeriesLibraryScanOffset(now = new Date()): number | null {
  const db = open();
  db.prepare(`INSERT OR IGNORE INTO sleeve_series_library_scan
    (id, album_offset, next_scan_at, updated_at) VALUES (1, 0, ?, ?)`)
    .run(new Date(0).toISOString(), now.toISOString());
  const row = db.prepare(`SELECT album_offset AS albumOffset FROM sleeve_series_library_scan
    WHERE id = 1 AND next_scan_at <= ?`).get(now.toISOString()) as { albumOffset: number } | undefined;
  return row?.albumOffset ?? null;
}

export function advanceSeriesLibraryScan(nextOffset: number | null, now = new Date()): void {
  const nextScan = nextOffset == null
    ? '9999-12-31T23:59:59.999Z'
    : now.toISOString();
  open().prepare(`UPDATE sleeve_series_library_scan SET album_offset = ?,
    next_scan_at = ?, updated_at = ? WHERE id = 1`)
    .run(nextOffset ?? 0, nextScan, now.toISOString());
}

export function deferSeriesLibraryScan(delayMs: number, now = new Date()): void {
  open().prepare(`UPDATE sleeve_series_library_scan SET next_scan_at = ?, updated_at = ?
    WHERE id = 1`).run(new Date(now.getTime() + delayMs).toISOString(), now.toISOString());
}

/** Titles only narrow MB release lookups; they are never sufficient to attach a claim. */
export function seriesAlbumTitleHints(): Set<string> {
  const rows = open().prepare(`SELECT DISTINCT member.entity_title AS title
    FROM sleeve_musicbrainz_series_members member
    JOIN sleeve_musicbrainz_series series ON series.series_mbid = member.series_mbid
    WHERE series.enabled = 1 AND series.removed = 0 AND series.entity_type = 'release-group'`).all() as Array<{ title: string }>;
  return new Set(rows.map(({ title }) => title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()));
}

export function hasCachedSeriesMembers(): boolean {
  return !!open().prepare('SELECT 1 FROM sleeve_musicbrainz_series_members member JOIN sleeve_musicbrainz_series series ON series.series_mbid = member.series_mbid WHERE series.enabled = 1 AND series.removed = 0 LIMIT 1').get();
}

export function isCachedSeriesReleaseGroup(mbid: string): boolean {
  return !!open().prepare(`SELECT 1 FROM sleeve_musicbrainz_series_members member
    JOIN sleeve_musicbrainz_series series ON series.series_mbid = member.series_mbid
    WHERE series.enabled = 1 AND series.removed = 0 AND series.entity_type = 'release-group' AND member.entity_mbid = ? LIMIT 1`)
    .get(mbid);
}

/** Cache exact release-to-group lookups for a month; null is a checked miss. */
export function cachedSeriesReleaseGroupForRelease(
  releaseMbid: string, now = new Date(),
): { releaseGroupMbid: string | null } | null {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const cached = open().prepare(`SELECT release_group_mbid AS releaseGroupMbid
    FROM sleeve_series_release_groups WHERE release_mbid = ? AND checked_at >= ?`)
    .get(releaseMbid, cutoff) as { releaseGroupMbid: string | null } | undefined;
  return cached ?? null;
}

export function cacheSeriesReleaseGroupForRelease(releaseMbid: string, releaseGroupMbid: string | null): void {
  open().prepare(`INSERT INTO sleeve_series_release_groups
    (release_mbid, release_group_mbid, checked_at) VALUES (?, ?, ?)
    ON CONFLICT(release_mbid) DO UPDATE SET
      release_group_mbid = excluded.release_group_mbid, checked_at = excluded.checked_at`)
    .run(releaseMbid, releaseGroupMbid, new Date().toISOString());
}

/** Match exact MBIDs from the local album and songs against every cached Series. */
export function retainLibrarySeriesClaims(input: {
  localAlbumId: string;
  releaseGroupMbid: string | null;
  songs: ReadonlyArray<{ id: string; musicBrainzId: string | null }>;
}): number {
  const db = open();
  const now = new Date();
  const members = db.prepare(`SELECT member.series_mbid AS seriesId, member.entity_mbid AS memberId,
      member.entity_title AS title, member.rank_value AS rank
    FROM sleeve_musicbrainz_series_members member
    JOIN sleeve_musicbrainz_series series ON series.series_mbid = member.series_mbid
    WHERE series.enabled = 1 AND series.removed = 0 AND series.entity_type = ? AND member.entity_mbid = ?`);
  const insert = db.prepare(`INSERT INTO sleeve_series_library_claims
    (local_track_id, local_album_id, claim_id, series_mbid, member_mbid, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_track_id, claim_id) DO UPDATE SET
      local_album_id = excluded.local_album_id, updated_at = excluded.updated_at`);
  type Member = { seriesId: string; memberId: string; title: string; rank: string | null };
  return db.transaction(() => {
    db.prepare(`DELETE FROM sleeve_series_library_claims WHERE local_album_id = ?
      AND series_mbid IN (SELECT series_mbid FROM sleeve_musicbrainz_series WHERE enabled = 1 AND removed = 0)`).run(input.localAlbumId);
    const catalog = activeSeriesMap(db);
    const claimIds = new Map<string, string>();
    const claimFor = (member: Member, entityType: 'recording' | 'release-group'): string | null => {
      const series = catalog.get(member.seriesId);
      if (!series) return null;
      const key = `${member.seriesId}\u0000${member.memberId}`;
      let id = claimIds.get(key);
      if (!id) {
        id = retainSeriesRecognitionClaim(db, series, entityType, member.memberId,
          { id: member.memberId, title: member.title, rank: member.rank }, now);
        claimIds.set(key, id);
      }
      return id;
    };
    const allGroupMembers = input.releaseGroupMbid
      ? members.all('release-group', input.releaseGroupMbid) as Member[] : [];
    // Additions-only 1001 editions describe cumulative membership. Keep the
    // earliest edition's one claim, as the canonical-match path already does.
    const first1001 = allGroupMembers
      .filter((member) => catalog.get(member.seriesId)?.editionGroup === '1001-albums')
      .sort((a, b) => (catalog.get(a.seriesId)?.order ?? 0)
        - (catalog.get(b.seriesId)?.order ?? 0))[0];
    const groupMembers = allGroupMembers.filter((member) =>
      catalog.get(member.seriesId)?.editionGroup !== '1001-albums'
      || member === first1001);
    let linked = 0;
    for (const song of input.songs) {
      for (const member of groupMembers) {
        const id = claimFor(member, 'release-group');
        if (id) linked += insert.run(song.id, input.localAlbumId, id,
          member.seriesId, member.memberId, now.toISOString()).changes;
      }
      const recordingMembers = song.musicBrainzId
        ? members.all('recording', song.musicBrainzId) as Member[] : [];
      for (const member of recordingMembers) {
        const id = claimFor(member, 'recording');
        if (id) linked += insert.run(song.id, input.localAlbumId, id,
          member.seriesId, member.memberId, now.toISOString()).changes;
      }
    }
    return linked;
  }).immediate();
}

function reconcileRecordingRecognitionInDatabase(
  db: Database.Database,
  recordingMbid: string,
  seriesIds: readonly string[],
): number {
  const catalog = activeSeriesMap(db);
  const recordings = db.prepare(`SELECT r.id, r.title
    FROM sleeve_recordings r WHERE r.musicbrainz_id = ? AND r.match_state = 'matched'`)
    .all(recordingMbid) as Array<{ id: string; title: string }>;
  if (!recordings.length) return 0;
  let count = 0;
  for (const recording of recordings) {
    disableSeriesClaimsForLocalEntity(db, seriesIds, 'recording', recording.id);
    for (const seriesId of seriesIds) {
      const series = catalog.get(seriesId);
      if (!series) continue;
      const member = db.prepare(`SELECT entity_mbid AS id, entity_title AS title, rank_value AS rank
        FROM sleeve_musicbrainz_series_members WHERE series_mbid = ? AND entity_mbid = ?`)
        .get(series.id, recordingMbid) as { id: string; title: string; rank: string | null } | undefined;
      if (!member) continue;
      retainSeriesRecognitionClaim(db, series, 'recording', recording.id,
        { ...member, title: recording.title }, new Date());
      count++;
    }
  }
  return count;
}

function releaseGroupMembersInCatalogOrder(db: Database.Database, releaseGroupMbid: string, seriesIds: readonly string[]): Array<{
  series: DefaultMusicBrainzSeries; member: { id: string; title: string; rank: string | null };
}> {
  const catalog = activeSeriesMap(db);
  const result: Array<{ series: DefaultMusicBrainzSeries; member: { id: string; title: string; rank: string | null } }> = [];
  for (const seriesId of seriesIds) {
    const series = catalog.get(seriesId);
    if (!series) continue;
    const member = db.prepare(`SELECT entity_mbid AS id, entity_title AS title, rank_value AS rank
      FROM sleeve_musicbrainz_series_members WHERE series_mbid = ? AND entity_mbid = ?`)
      .get(series.id, releaseGroupMbid) as { id: string; title: string; rank: string | null } | undefined;
    if (member) result.push({ series, member });
  }
  return result.sort((a, b) => a.series.order - b.series.order);
}

function reconcileReleaseGroupRecognitionInDatabase(
  db: Database.Database,
  releaseGroupMbid: string,
  seriesIds: readonly string[],
): number {
  const catalog = activeSeriesMap(db);
  const releases = db.prepare(`SELECT DISTINCT r.id, r.title
    FROM sleeve_releases r
    JOIN sleeve_recording_releases rr ON rr.release_id = r.id AND rr.is_canonical_home = 1
    JOIN sleeve_recordings recording ON recording.id = rr.recording_id AND recording.match_state = 'matched'
    WHERE r.musicbrainz_release_group_id = ?`)
    .all(releaseGroupMbid) as Array<{ id: string; title: string }>;
  if (!releases.length) return 0;
  const refresh1001Family = seriesIds.some((id) => catalog.get(id)?.editionGroup === '1001-albums');
  const familyIds = refresh1001Family
    ? [...catalog.values()].filter((series) => series.editionGroup === '1001-albums').map((series) => series.id)
    : [];
  const independentIds = seriesIds.filter((id) => catalog.get(id)?.editionGroup !== '1001-albums');
  const effectiveSeriesIds = [...familyIds, ...independentIds];
  const foundFamily = familyIds.length
    ? releaseGroupMembersInCatalogOrder(db, releaseGroupMbid, familyIds)[0] ?? null
    : null;
  const foundIndependent = releaseGroupMembersInCatalogOrder(db, releaseGroupMbid, independentIds);
  const now = new Date();
  let count = 0;
  for (const release of releases) {
    disableSeriesClaimsForLocalEntity(db, effectiveSeriesIds, 'release', release.id);
    if (foundFamily) {
      // The 1001 follow-up lists are additions. When the same album is found
      // in more than one cached edition, retain the earliest edition wording.
      retainSeriesRecognitionClaim(db, foundFamily.series, 'release', release.id,
        { ...foundFamily.member, title: release.title }, now);
      count++;
    }
    for (const entry of foundIndependent) {
      retainSeriesRecognitionClaim(db, entry.series, 'release', release.id,
        { ...entry.member, title: release.title }, now);
      count++;
    }
  }
  return count;
}

/** Reattach already cached Series facts as soon as a new canonical match lands. */
function materializeCachedMusicBrainzSeriesInDatabase(
  db: Database.Database,
  recordingMbid: string,
  releaseGroupMbids: readonly string[],
): void {
  const recordingSeriesIds = [...activeSeriesMap(db).values()]
    .filter((series) => series.entityType === 'recording').map((series) => series.id);
  reconcileRecordingRecognitionInDatabase(db, recordingMbid, recordingSeriesIds);
  const releaseGroupSeriesIds = [...activeSeriesMap(db).values()]
    .filter((series) => series.entityType === 'release-group').map((series) => series.id);
  for (const releaseGroupMbid of new Set(releaseGroupMbids.filter(Boolean))) {
    reconcileReleaseGroupRecognitionInDatabase(db, releaseGroupMbid, releaseGroupSeriesIds);
  }
}

function relationshipClaim(recording: RecordingForGenius, relationship: ProviderRelationship): ResearchCandidate | null {
  const source = `${recording.title}${recording.artist ? ` by ${recording.artist}` : ''}`;
  const target = `${relationship.target.title}${relationship.target.artist ? ` by ${relationship.target.artist}` : ''}`;
  const wording = {
    samples: `${source} samples ${target}.`, sampled_in: `${target} samples ${source}.`,
    cover_of: `${source} is a cover version of ${target}.`, covered_by: `${target} is a cover version of ${source}.`,
  }[relationship.type];
  if (!wording) return null;
  return { category: 'musical-connections', topic: `${relationship.type.replaceAll('_', ' ')}: ${target}`.slice(0, 100), wording, evidence: JSON.stringify(relationship) };
}

/** Store only the provider adapter's lyrics-free allowlist. */
export function retainGeniusResult(recording: RecordingForGenius, result: SleeveProviderResult): void {
  const sourceDocumentId = retainSourceDocument({ entityType: 'recording', entityId: recording.id, provider: 'genius',
    sourceUrl: result.identity.canonicalUrl, revisionId: null, contentKind: 'structured-json',
    content: JSON.stringify(result), attribution: result.attribution });
  const candidates: ResearchCandidate[] = [
    ...result.credits.map((credit): ResearchCandidate => ({ category: 'credits',
      topic: `${credit.role}: ${credit.names.join(', ')}`.slice(0, 100),
      wording: `${recording.title} is credited to ${credit.names.join(', ')} for ${credit.role.toLowerCase()}.`, evidence: JSON.stringify(credit) })),
    ...result.relationships.map((relationship) => relationshipClaim(recording, relationship))
      .filter((candidate): candidate is ResearchCandidate => candidate !== null),
  ];
  retainResearchClaims({ entityType: 'recording', entityId: recording.id, sourceDocumentId, candidates });
}

export type ProviderRequestOutcome = 'ready' | 'no-match' | 'failed' | 'rate-limited';
export type ProviderRequestReservation = { requestId: string } | { waitMs: number };

/** Read the same rolling windows/backoff used by request reservation. No writes. */
export function geniusRequestAllowance(db: Database.Database, now = new Date()) {
  const nowMs = now.getTime();
  const minuteCutoff = new Date(nowMs - 60_000).toISOString();
  const dayCutoff = new Date(nowMs - 86_400_000).toISOString();
  const failures = db.prepare(`SELECT outcome, status_code AS statusCode, requested_at AS requestedAt
    FROM sleeve_provider_requests WHERE provider='genius' AND requested_at>=?
    ORDER BY requested_at DESC LIMIT 100`).all(dayCutoff) as Array<{ outcome: string; statusCode: number | null; requestedAt: string }>;
  let consecutiveFailures = 0;
  for (const request of failures) {
    if (!(request.outcome === 'rate-limited' || (request.statusCode !== null && request.statusCode >= 500)
      || (request.outcome === 'failed' && request.statusCode === null))) break;
    consecutiveFailures++;
  }
  const recent = db.prepare(`SELECT requested_at AS at FROM sleeve_provider_requests
    WHERE provider='genius' AND requested_at>=? ORDER BY requested_at`).all(minuteCutoff) as Array<{ at: string }>;
  const daily = db.prepare(`SELECT COUNT(*) AS count FROM sleeve_provider_requests
    WHERE provider='genius' AND requested_at>=?`).get(dayCutoff) as { count: number };
  let until = 0;
  let reason: 'backoff' | 'allowance' | null = null;
  if (consecutiveFailures) {
    until = Date.parse(failures[0]!.requestedAt) + Math.min(60_000 * 2 ** Math.min(consecutiveFailures - 1, 6), 3_600_000);
    if (until > nowMs) reason = 'backoff';
  }
  if (!reason) {
    const minuteUntil = recent.length >= 6 ? Date.parse(recent[0]!.at) + 60_000 : 0;
    const spacingUntil = recent.length ? Date.parse(recent.at(-1)!.at) + 10_000 : 0;
    until = Math.max(minuteUntil, spacingUntil);
    if (until > nowMs || recent.length >= 6) reason = 'allowance';
  }
  return { minuteRequests: recent.length, minuteLimit: 6, dayRequests: daily.count, dayLimit: null,
    waitReason: reason, waitMs: reason ? Math.max(1_000, until - nowMs) : 0,
    retryAt: reason ? new Date(Math.max(nowMs + 1_000, until)).toISOString() : null };
}

export function geniusQueueReadout(now = new Date(), db: Database.Database = open()) {
  const rows = db.prepare(`SELECT capability,state,COUNT(*) AS jobs,
    SUM(CASE WHEN run_after IS NULL OR run_after<=? THEN 1 ELSE 0 END) AS ready,
    MIN(CASE WHEN run_after IS NULL OR run_after<=? THEN created_at END) AS oldestReadyAt
    FROM sleeve_research_jobs WHERE provider='genius' AND state IN ('queued','retry-at','running')
    GROUP BY capability,state`).all(now.toISOString(), now.toISOString()) as Array<{
      capability: string; state: string; jobs: number; ready: number; oldestReadyAt: string | null;
    }>;
  const pending = { encountered: 0, albums: 0, samples: 0 };
  let ready = 0, readyRequests = 0, deferred = 0, running = 0;
  let oldestReadyAt: string | null = null;
  for (const row of rows) {
    if (row.state === 'running') { running += row.jobs; continue; }
    pending[row.capability === 'album-biography' ? 'albums'
      : ['sample-traversal','expand-samples'].includes(row.capability) ? 'samples' : 'encountered'] += row.jobs;
    ready += row.ready;
    if (row.capability !== 'expand-samples') readyRequests += row.ready;
    deferred += row.jobs - row.ready;
    if (row.oldestReadyAt && (!oldestReadyAt || row.oldestReadyAt < oldestReadyAt)) oldestReadyAt = row.oldestReadyAt;
  }
  return { ...geniusRequestAllowance(db, now), pending, ready, readyRequests, deferred, running, oldestReadyAt,
    oldestReadyAgeSeconds: oldestReadyAt ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldestReadyAt)) / 1000)) : null };
}

/** Atomically enforce the station's conservative Genius request budget. */
export function reserveGeniusProviderRequest(now = new Date(), capability = 'connections'): ProviderRequestReservation {
  const db = open();
  return db.transaction((): ProviderRequestReservation => {
    const allowance = geniusRequestAllowance(db, now);
    if (allowance.waitMs) return { waitMs: allowance.waitMs };
    const requestId = randomUUID();
    db.prepare(`INSERT INTO sleeve_provider_requests (id, provider, capability, requested_at, outcome)
      VALUES (?, 'genius', ?, ?, 'started')`).run(requestId, capability, now.toISOString());
    return { requestId };
  }).immediate();
}

export function finishGeniusProviderRequest(id: string, outcome: ProviderRequestOutcome, statusCode: number | null): void {
  open().prepare(`UPDATE sleeve_provider_requests SET completed_at = ?, outcome = ?, status_code = ? WHERE id = ? AND provider = 'genius'`)
    .run(new Date().toISOString(), outcome, statusCode, id);
}

export function requeueResearchJob(id: string): void {
  open().prepare(`UPDATE sleeve_research_jobs SET state = 'queued', run_after = NULL, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export interface SourceDocumentForResearch {
  id: string;
  entityId: string;
  entityName: string | null;
  provider: string;
  sourceUrl: string;
  revisionId: string | null;
  content: string;
  wikipediaPrunedAt?: string | null;
}

export function latestSourceDocumentForResearch(entityType: 'artist' | 'recording' | 'release' | 'release-group', entityId: string, provider: string): SourceDocumentForResearch | null {
  const row = open().prepare(`SELECT source.id, source.entity_id AS entityId,
    CASE source.entity_type
      WHEN 'artist' THEN (SELECT artist.name FROM sleeve_artists artist WHERE artist.id = source.entity_id)
      WHEN 'recording' THEN (SELECT recording.title FROM sleeve_recordings recording WHERE recording.id = source.entity_id)
      WHEN 'release' THEN (SELECT release.title FROM sleeve_releases release WHERE release.id = source.entity_id)
      WHEN 'release-group' THEN (SELECT MIN(release.title) FROM sleeve_releases release WHERE release.musicbrainz_release_group_id = source.entity_id)
      ELSE NULL
    END AS entityName,
    source.provider, source.source_url AS sourceUrl,
    source.revision_id AS revisionId, source.content, source.wikipedia_pruned_at AS wikipediaPrunedAt FROM sleeve_source_documents source
    WHERE source.entity_type = ? AND source.entity_id = ? AND source.provider = ?
    ORDER BY source.retrieved_at DESC LIMIT 1`).get(entityType, entityId, provider) as SourceDocumentForResearch | undefined;
  return row ?? null;
}

export function retainResearchClaims(input: {
  entityType: 'artist' | 'recording' | 'release' | 'release-group';
  entityId: string;
  sourceDocumentId: string;
  candidates: readonly ResearchCandidate[];
}): void {
  const db = open();
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic,
    wording, short_wording, source_document_id, evidence, airtime_scope, matching_release_title,
    matching_track_title, extraction_rank, extraction_section, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id, category, topic, source_document_id) DO UPDATE SET
      wording = excluded.wording,
      short_wording = CASE WHEN excluded.short_wording <> '' THEN excluded.short_wording ELSE sleeve_claims.short_wording END,
      evidence = excluded.evidence, airtime_scope = excluded.airtime_scope,
      matching_release_title = excluded.matching_release_title,
      matching_track_title = excluded.matching_track_title, extraction_rank = excluded.extraction_rank,
      extraction_section = excluded.extraction_section, enabled = 1, updated_at = excluded.updated_at
      WHERE sleeve_claims.operator_state = 'auto'`);
  const transaction = db.transaction(() => {
    for (const candidate of input.candidates) {
      if (handledCandidate(input.sourceDocumentId, candidate)
        || suppressedTopic(input.entityType, input.entityId, candidate)) continue;
      const result = insert.run(randomUUID(), input.entityType, input.entityId, candidate.category, candidate.topic,
        candidate.wording, candidate.shortWording ?? '', input.sourceDocumentId, candidate.evidence,
        candidate.airtimeScope ?? 'general', candidate.matchingReleaseTitle ?? null,
        candidate.matchingTrackTitle ?? null, candidate.extractionRank ?? null, candidate.extractionSection ?? null, now, now);
      if (result.changes) markCandidateRetained(input.sourceDocumentId, candidate);
    }
  });
  transaction();
}

export function replaceAutomaticWikipediaClaimsInDatabase(db: Database.Database, input: {
  entityType: 'artist' | 'release-group';
  entityId: string;
  sourceDocumentId: string;
  candidates: readonly ResearchCandidate[];
  now?: string;
}): { disabledClaims: number; enabledClaims: number } {
  const now = input.now ?? new Date().toISOString();
  const disabledClaims = db.prepare(`UPDATE sleeve_claims SET enabled = 0, updated_at = ?
    WHERE entity_type = ? AND entity_id = ? AND operator_state = 'auto'
      AND source_document_id IN (SELECT id FROM sleeve_source_documents WHERE provider = 'wikipedia')`)
    .run(now, input.entityType, input.entityId).changes;
  const upsert = db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic,
      wording, short_wording, source_document_id, evidence, airtime_scope, matching_release_title,
      matching_track_title, extraction_rank, extraction_section, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id, category, topic, source_document_id) DO UPDATE SET
      wording = excluded.wording,
      short_wording = CASE WHEN excluded.short_wording <> '' THEN excluded.short_wording ELSE sleeve_claims.short_wording END,
      evidence = excluded.evidence, airtime_scope = excluded.airtime_scope,
      matching_release_title = excluded.matching_release_title,
      matching_track_title = excluded.matching_track_title, extraction_rank = excluded.extraction_rank,
      extraction_section = excluded.extraction_section, enabled = 1, updated_at = excluded.updated_at
      WHERE sleeve_claims.operator_state = 'auto'`);
  let enabledClaims = 0;
  for (const candidate of input.candidates) {
    if (handledCandidate(input.sourceDocumentId, candidate)
      || suppressedTopic(input.entityType, input.entityId, candidate)) continue;
    const result = upsert.run(randomUUID(), input.entityType, input.entityId, candidate.category, candidate.topic,
      candidate.wording, candidate.shortWording ?? '', input.sourceDocumentId, candidate.evidence,
      candidate.airtimeScope ?? 'general', candidate.matchingReleaseTitle ?? null,
      candidate.matchingTrackTitle ?? null, candidate.extractionRank ?? null, candidate.extractionSection ?? null, now, now);
    if (result.changes) {
      enabledClaims += 1;
      markCandidateRetained(input.sourceDocumentId, candidate);
    }
  }
  return { disabledClaims, enabledClaims };
}

/** Apply only a separately reviewed, revision-pinned Wikipedia replay batch. */
export function applyReviewedWikipediaReplay(input: {
  entries: Array<{
    sourceDocumentId: string;
    entityType: 'artist' | 'recording' | 'release' | 'release-group';
    entityId: string;
    revisionId: string;
    contentHash: string;
    candidates: readonly ResearchCandidate[];
  }>;
}): { sources: number; acceptedClaims: number; disabledClaims: number } {
  const db = open();
  const now = new Date().toISOString();
  const acceptedClaims = input.entries.reduce((sum, entry) => sum + entry.candidates.length, 0);
  const apply = db.transaction(() => {
    const source = db.prepare(`SELECT provider, entity_type AS entityType, entity_id AS entityId,
        revision_id AS revisionId, content_hash AS contentHash, content
      FROM sleeve_source_documents WHERE id = ?`);
    const disable = db.prepare(`UPDATE sleeve_claims SET enabled = 0, updated_at = ?
      WHERE entity_type = ? AND entity_id = ? AND enabled = 1 AND operator_state = 'auto'
        AND source_document_id IN (
          SELECT id FROM sleeve_source_documents WHERE provider = 'wikipedia'
        )`);
    const upsert = db.prepare(`INSERT INTO sleeve_claims (id, entity_type, entity_id, category, topic,
        wording, short_wording, source_document_id, evidence, extraction_rank, extraction_section, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(entity_type, entity_id, category, topic, source_document_id) DO UPDATE SET
        wording = excluded.wording,
        short_wording = excluded.short_wording,
        evidence = excluded.evidence,
        extraction_rank = excluded.extraction_rank, extraction_section = excluded.extraction_section,
        enabled = 1,
        updated_at = excluded.updated_at
        WHERE sleeve_claims.operator_state = 'auto'`);

    // Check the entire batch before changing one claim; a changed cache row
    // aborts the transaction rather than applying against newer source text.
    for (const entry of input.entries) {
      const row = source.get(entry.sourceDocumentId) as {
        provider: string; entityType: string; entityId: string; revisionId: string | null; contentHash: string; content: string;
      } | undefined;
      if (!row || row.provider !== 'wikipedia' || row.entityType !== entry.entityType
        || row.entityId !== entry.entityId || row.revisionId !== entry.revisionId
        || row.contentHash !== entry.contentHash
        || createHash('sha256').update(row.content).digest('hex') !== entry.contentHash) {
        throw new Error(`Frozen Wikipedia source changed before apply: ${entry.sourceDocumentId}`);
      }
    }

    let disabledClaims = 0;
    for (const entry of input.entries) {
      disabledClaims += disable.run(now, entry.entityType, entry.entityId).changes;
      for (const candidate of entry.candidates) {
        if (handledCandidate(entry.sourceDocumentId, candidate)
          || suppressedTopic(entry.entityType, entry.entityId, candidate)) continue;
        const result = upsert.run(randomUUID(), entry.entityType, entry.entityId, candidate.category, candidate.topic,
          candidate.wording, candidate.shortWording ?? '', entry.sourceDocumentId, candidate.evidence,
          candidate.extractionRank ?? null, candidate.extractionSection ?? null, now, now);
        if (result.changes) markCandidateRetained(entry.sourceDocumentId, candidate);
      }
    }
    return disabledClaims;
  });
  const disabledClaims = apply.immediate();
  return { sources: input.entries.length, acceptedClaims, disabledClaims };
}

export function markResearchJobRunning(id: string): void {
  open().prepare('DELETE FROM sleeve_queue_promotions WHERE job_id=?').run(id);
  open().prepare(`UPDATE sleeve_research_jobs SET state = 'running', attempts = attempts + 1,
    updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function finishResearchJob(id: string, state: 'complete' | 'failed'): void {
  open().prepare('DELETE FROM sleeve_queue_promotions WHERE job_id=?').run(id);
  const now = new Date().toISOString();
  open().prepare(`UPDATE sleeve_research_jobs
    SET state = ?, operator_requested = 0, updated_at = ?, completed_at = CASE WHEN ? = 'complete' THEN ? ELSE NULL END
    WHERE id = ?`).run(state, now, state, now, id);
}

/** Return work left marked running when a controller process was interrupted. */
export function recoverInterruptedResearchJobs(): number {
  return recoverInterruptedResearchJobsInDatabase(open());
}

export function recoverInterruptedResearchJobsInDatabase(db: Database.Database, now = new Date()): number {
  const result = db.prepare(`UPDATE sleeve_research_jobs
    SET state = 'queued', run_after = NULL, updated_at = ?
    WHERE state = 'running'`).run(now.toISOString());
  return result.changes;
}

export interface WikipediaClaimRebuild {
  /** Legacy response name: removed from automatic offers, never deleted from history. */
  claimsRemoved: number;
  jobsQueued: number;
}

export interface WikipediaResearchRequeue {
  artistsWithCachedSources: number;
  releaseGroupsWithCachedSources: number;
  jobsQueued: number;
}

/** Queue extraction against cached Wikipedia text without changing claims or sources. */
export function requeueCachedWikipediaResearch(now = new Date()): WikipediaResearchRequeue {
  const db = open();
  const timestamp = now.toISOString();
  const transaction = db.transaction(() => {
    const artistsWithCachedSources = (db.prepare(`SELECT COUNT(DISTINCT entity_id) AS count
      FROM sleeve_source_documents WHERE provider = 'wikipedia' AND entity_type = 'artist'`)
      .get() as { count: number }).count;
    const releaseGroupsWithCachedSources = (db.prepare(`SELECT COUNT(DISTINCT entity_id) AS count
      FROM sleeve_source_documents WHERE provider = 'wikipedia' AND entity_type = 'release-group'`)
      .get() as { count: number }).count;
    db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at
    ) SELECT lower(hex(randomblob(16))), 'researcher', 'artist', s.entity_id,
      'extract-wikipedia', 'queued', 300, 0, NULL, ?, ?
      FROM sleeve_source_documents s
      WHERE s.provider = 'wikipedia' AND s.entity_type = 'artist'
      GROUP BY s.entity_id`).run(timestamp, timestamp);
    const jobsQueued = db.prepare(`UPDATE sleeve_research_jobs
      SET state = 'queued', attempts = 0, run_after = NULL, updated_at = ?
      WHERE provider = 'researcher' AND subject_type = 'artist'
        AND capability = 'extract-wikipedia'
        AND EXISTS (SELECT 1 FROM sleeve_source_documents s
          WHERE s.provider = 'wikipedia' AND s.entity_type = 'artist'
            AND s.entity_id = sleeve_research_jobs.subject_id)`)
      .run(timestamp).changes;
    db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at
    ) SELECT lower(hex(randomblob(16))), 'researcher', 'release', s.entity_id,
      'extract-wikipedia-release-group', 'queued', 350, 0, NULL, ?, ?
      FROM sleeve_source_documents s
      WHERE s.provider = 'wikipedia' AND s.entity_type = 'release-group'
      GROUP BY s.entity_id`).run(timestamp, timestamp);
    db.prepare(`DELETE FROM sleeve_wikipedia_scan_progress WHERE job_id IN (
      SELECT id FROM sleeve_research_jobs WHERE provider = 'researcher'
        AND capability IN ('extract-wikipedia', 'extract-wikipedia-release-group')
        AND EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id))`).run();
    const releaseGroupJobsQueued = db.prepare(`UPDATE sleeve_research_jobs
      SET state = 'queued', attempts = 0, run_after = NULL, updated_at = ?
      WHERE provider = 'researcher' AND subject_type = 'release'
        AND capability = 'extract-wikipedia-release-group'
        AND EXISTS (SELECT 1 FROM sleeve_source_documents s
          WHERE s.provider = 'wikipedia' AND s.entity_type = 'release-group'
            AND s.entity_id = sleeve_research_jobs.subject_id)`)
      .run(timestamp).changes;
    return {
      artistsWithCachedSources,
      releaseGroupsWithCachedSources,
      jobsQueued: jobsQueued + releaseGroupJobsQueued,
    };
  });
  return transaction.immediate();
}

/**
 * Retire automatic claims derived from cached Wikipedia prose and replay their
 * extraction jobs. No identity or provider work is repeated: a safer evidence
 * validator can therefore rebuild the editorial layer without hammering APIs.
 */
export function rebuildWikipediaClaims(): WikipediaClaimRebuild {
  return rebuildWikipediaClaimsInDatabase(open());
}

export function rebuildWikipediaClaimsInDatabase(db: Database.Database, now = new Date()): WikipediaClaimRebuild {
  const timestamp = now.toISOString();
  const transaction = db.transaction(() => {
    const claimsRemoved = db.prepare(`UPDATE sleeve_claims SET enabled=0, updated_at=?
      WHERE enabled=1 AND operator_state = 'auto' AND source_document_id IN (
        SELECT id FROM sleeve_source_documents
        WHERE provider = 'wikipedia' AND entity_type = 'artist'
      )`).run(timestamp).changes;
    db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at
    ) SELECT lower(hex(randomblob(16))), 'researcher', 'artist', entity_id,
      'extract-wikipedia', 'queued', 300, 0, NULL, ?, ?
      FROM sleeve_source_documents
      WHERE provider = 'wikipedia' AND entity_type = 'artist'
      GROUP BY entity_id`).run(timestamp, timestamp);
    const jobsQueued = db.prepare(`UPDATE sleeve_research_jobs
      SET state = 'queued', attempts = 0, run_after = NULL, updated_at = ?
      WHERE provider = 'researcher' AND subject_type = 'artist'
        AND capability = 'extract-wikipedia'
        AND EXISTS (
          SELECT 1 FROM sleeve_source_documents s
          WHERE s.provider = 'wikipedia' AND s.entity_type = 'artist'
            AND s.entity_id = sleeve_research_jobs.subject_id
        )`).run(timestamp).changes;
    return { claimsRemoved, jobsQueued };
  });
  return transaction();
}

/**
 * Replay only one artist's cached Wikipedia research. The research job is
 * artist-scoped, so every automatic cached Wikipedia claim for that artist is retired
 * together; provider identity and source retrieval remain untouched.
 */
export function rebuildWikipediaClaimsForArtist(artistId: string): WikipediaClaimRebuild {
  return rebuildWikipediaClaimsForArtistInDatabase(open(), artistId);
}

export function rebuildWikipediaClaimsForArtistInDatabase(
  db: Database.Database, artistId: string, now = new Date(),
): WikipediaClaimRebuild {
  const timestamp = now.toISOString();
  const transaction = db.transaction(() => {
    const sourceExists = db.prepare(`SELECT 1 FROM sleeve_source_documents
      WHERE provider = 'wikipedia' AND entity_type = 'artist' AND entity_id = ? LIMIT 1`).get(artistId);
    if (!sourceExists) return { claimsRemoved: 0, jobsQueued: 0 };
    const claimsRemoved = db.prepare(`UPDATE sleeve_claims SET enabled=0, updated_at=?
      WHERE enabled=1 AND operator_state = 'auto' AND entity_type = 'artist' AND entity_id = ? AND source_document_id IN (
        SELECT id FROM sleeve_source_documents
        WHERE provider = 'wikipedia' AND entity_type = 'artist' AND entity_id = ?
      )`).run(timestamp, artistId, artistId).changes;
    db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at
    ) VALUES (lower(hex(randomblob(16))), 'researcher', 'artist', ?,
      'extract-wikipedia', 'queued', 300, 0, NULL, ?, ?)`).run(artistId, timestamp, timestamp);
    const jobsQueued = db.prepare(`UPDATE sleeve_research_jobs
      SET state = 'queued', attempts = 0, run_after = NULL, updated_at = ?
      WHERE provider = 'researcher' AND subject_type = 'artist' AND subject_id = ?
        AND capability = 'extract-wikipedia'`).run(timestamp, artistId).changes;
    return { claimsRemoved, jobsQueued };
  });
  return transaction();
}

/** A provider outage is not a content verdict. Keep the job durable and pause it. */
export function retryResearchJob(id: string, delayMs = 5 * 60_000): void {
  retryResearchJobInDatabase(open(), id, delayMs);
}

/**
 * Start with one prompt retry after a transient provider blip, then back off
 * enough that an outage cannot keep the quiet-time worker pressing the public
 * MusicBrainz service. The caller records one attempt before asking for this.
 */
export function musicBrainzRetryDelay(attempts: number): number {
  const minutes = [1, 5, 15, 30, 60][Math.min(Math.max(0, attempts - 1), 4)];
  return minutes * 60_000;
}

/** Shared pause after MusicBrainz tells us it is unavailable or rate-limited. */
export function musicBrainzOutageDelay(attempts: number): number {
  const minutes = [5, 15, 30, 60][Math.min(Math.max(0, attempts - 1), 3)];
  return minutes * 60_000;
}

/** Retry spacing for the multi-request MusicBrainz → Wikidata → Wikipedia path. */
export function wikipediaRetryDelay(attempts: number): number {
  const minutes = [1, 5, 15, 30, 60][Math.min(Math.max(0, attempts - 1), 4)];
  return minutes * 60_000;
}

/** Shared pause when one Wikimedia/MusicBrainz endpoint reports an outage. */
export function wikipediaOutageDelay(attempts: number): number {
  const minutes = [5, 15, 30, 60][Math.min(Math.max(0, attempts - 1), 3)];
  return minutes * 60_000;
}

export function deferWikipediaResearchJobsInDatabase(db: Database.Database, delayMs: number, now = new Date()): number {
  const runAfter = new Date(now.getTime() + delayMs).toISOString();
  return db.prepare(`UPDATE sleeve_research_jobs
    SET state = 'retry-at', run_after = ?, updated_at = ?
    WHERE provider = 'wikipedia' AND capability IN ('biography', 'release-group-biography')
      AND state IN ('queued', 'retry-at')`).run(runAfter, now.toISOString()).changes;
}

export function deferWikipediaResearchJobs(delayMs: number): number {
  return deferWikipediaResearchJobsInDatabase(open(), delayMs);
}

export function retryResearchJobInDatabase(db: Database.Database, id: string, delayMs = 5 * 60_000, now = new Date()): void {
  const runAfter = new Date(now.getTime() + delayMs).toISOString();
  db.prepare(`UPDATE sleeve_research_jobs
    SET state = 'retry-at', run_after = ?, updated_at = ? WHERE id = ?`)
    .run(runAfter, now.toISOString(), id);
}

/**
 * A 503 is a provider-level condition, not one bad track. Put every pending
 * external match behind one durable retry window so the single worker cannot
 * turn an outage into a five-second stream of requests.
 */
export function deferMusicBrainzMatchesInDatabase(db: Database.Database, delayMs: number, now = new Date()): number {
  const runAfter = new Date(now.getTime() + delayMs).toISOString();
  return db.prepare(`UPDATE sleeve_research_jobs
    SET state = 'retry-at', run_after = ?, updated_at = ?
    WHERE provider = 'musicbrainz' AND subject_type = 'local-track' AND capability = 'match'
      AND state IN ('queued', 'retry-at')`).run(runAfter, now.toISOString()).changes;
}

export function deferMusicBrainzMatches(delayMs: number): number {
  return deferMusicBrainzMatchesInDatabase(open(), delayMs);
}

/** Persist canonical identity and every returned release appearance atomically. */
export function retainCanonicalMusicBrainzMatch(localTrackId: string, result: CanonicalMusicBrainzRecording,
  listenerPresent = false): void {
  retainCanonicalMusicBrainzMatchInDatabase(open(), localTrackId, result, listenerPresent);
}

export function retainCanonicalMusicBrainzMatchInDatabase(db: Database.Database, localTrackId: string,
  result: CanonicalMusicBrainzRecording, listenerPresent = false): void {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    let artistId: string | null = null;
    if (result.artist) {
      const existing = db.prepare('SELECT id FROM sleeve_artists WHERE musicbrainz_id = ?').get(result.artist.id) as { id: string } | undefined;
      artistId = existing?.id ?? randomUUID();
      db.prepare(`INSERT INTO sleeve_artists (id, name, sort_name, musicbrainz_id, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(musicbrainz_id) DO UPDATE SET
          name = excluded.name, updated_at = excluded.updated_at`)
        .run(artistId, result.artist.name, result.artist.id, now, now);
    }
    const existingRecording = db.prepare('SELECT id FROM sleeve_recordings WHERE musicbrainz_id = ?').get(result.id) as { id: string } | undefined;
    const recordingId = existingRecording?.id ?? randomUUID();
    db.prepare(`INSERT INTO sleeve_recordings (id, title, artist_id, musicbrainz_id, match_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'matched', ?, ?) ON CONFLICT(musicbrainz_id) DO UPDATE SET
        title = excluded.title, artist_id = excluded.artist_id, match_state = 'matched', updated_at = excluded.updated_at`)
      .run(recordingId, result.title, artistId, result.id, now, now);
    db.prepare(`UPDATE sleeve_local_attachments SET recording_id = ?, musicbrainz_recording_id = ?,
      match_state = 'matched', updated_at = ? WHERE local_track_id = ?`)
      .run(recordingId, result.id, now, localTrackId);

    const official = result.releases
      .filter((release) => release.status === 'Official' && !release.isCompilation && !!release.date)
      .sort((a, b) => a.date!.localeCompare(b.date!) || a.id.localeCompare(b.id));
    const firstId = official[0]?.id ?? null;
    const homeId = firstId;
    let canonicalReleaseId: string | null = null;
    let canonicalReleaseGroupId: string | null = null;
    let canonicalReleaseIsAlbum = false;
    for (const release of result.releases) {
      const existing = db.prepare('SELECT id FROM sleeve_releases WHERE musicbrainz_release_id = ?').get(release.id) as { id: string } | undefined;
      const releaseId = existing?.id ?? randomUUID();
      db.prepare(`INSERT INTO sleeve_releases (id, title, musicbrainz_release_id, musicbrainz_release_group_id,
        primary_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(musicbrainz_release_id) DO UPDATE SET title = excluded.title,
          musicbrainz_release_group_id = excluded.musicbrainz_release_group_id,
          primary_type = excluded.primary_type, status = excluded.status, updated_at = excluded.updated_at`)
        .run(releaseId, release.title, release.id, release.releaseGroupId, release.primaryType, release.status, now, now);
      db.prepare(`INSERT INTO sleeve_recording_releases (recording_id, release_id, release_date, country,
        artist_credit, is_compilation, is_first_official_non_compilation, is_canonical_home, selection_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(recording_id, release_id) DO UPDATE SET release_date = excluded.release_date,
          country = excluded.country, artist_credit = excluded.artist_credit, is_compilation = excluded.is_compilation,
          is_first_official_non_compilation = excluded.is_first_official_non_compilation,
          is_canonical_home = excluded.is_canonical_home, selection_reason = excluded.selection_reason`)
        .run(recordingId, releaseId, release.date, release.country, release.artistCredit, release.isCompilation ? 1 : 0,
          release.id === firstId ? 1 : 0, release.id === homeId ? 1 : 0,
          release.id === homeId ? 'earliest-official-non-compilation' : null);
      if (release.id === homeId) {
        canonicalReleaseId = releaseId;
        canonicalReleaseGroupId = release.releaseGroupId;
        canonicalReleaseIsAlbum = release.primaryType === 'Album';
      }
    }
    materializeCachedMusicBrainzSeriesInDatabase(db, result.id,
      result.releases.map((release) => release.releaseGroupId).filter((id): id is string => !!id));
    // Keep provider source lookups queued beside the matched identity. The
    // researcher later orders article sections album-first at each depth.
    if (artistId && (listenerPresent
      || activeResearchQueueSizeInDatabase(db, localTrackId) < AUTOPILOT_RESEARCH_QUEUE_CAP)) enqueueResearchJobInDatabase(db, {
      provider: 'wikipedia', subjectType: 'artist', subjectId: artistId,
      capability: 'biography', priority: 300, now, originLocalTrackId: localTrackId,
    });
    if (canonicalReleaseGroupId && canonicalReleaseIsAlbum && (listenerPresent
      || activeResearchQueueSizeInDatabase(db, localTrackId) < AUTOPILOT_RESEARCH_QUEUE_CAP)) enqueueResearchJobInDatabase(db, {
      provider: 'wikipedia', subjectType: 'release', subjectId: canonicalReleaseGroupId,
      capability: 'release-group-biography', priority: 350, now, originLocalTrackId: localTrackId,
    });
    if (canonicalReleaseId) enqueueResearchJobInDatabase(db, {
      provider: 'musicbrainz', subjectType: 'release', subjectId: canonicalReleaseId,
      capability: 'release-context', priority: 200, now, originLocalTrackId: localTrackId,
    });
    const independentlyResearched = db.prepare(`SELECT 1 FROM sleeve_genius_local_tracks local
      JOIN sleeve_source_documents source ON source.entity_id = local.recording_id
      WHERE local.local_track_id = ? AND source.entity_type = 'recording' AND source.provider = 'genius' LIMIT 1`)
      .get(localTrackId);
    const independentJob = db.prepare(`SELECT 1 FROM sleeve_research_jobs WHERE provider = 'genius'
      AND subject_type = 'local-track' AND subject_id = ? AND capability = 'connections'
      AND state IN ('queued','retry-at','running','complete')`).get(localTrackId);
    if (!independentlyResearched && !independentJob) enqueueResearchJobInDatabase(db, {
      provider: 'genius', subjectType: 'recording', subjectId: recordingId,
      capability: 'connections', priority: 100, now, originLocalTrackId: localTrackId,
    });
    queueWikipediaRefreshForEncounterInDatabase(db, localTrackId, now);
  });
  transaction();
}

function enqueueResearchJobInDatabase(db: Database.Database, input: {
  provider: string;
  subjectType: PendingResearchJob['subjectType'];
  subjectId: string;
  capability: string;
  priority: number;
  now: string;
  originLocalTrackId?: string | null;
}): void {
  if (input.provider === 'genius' && !settings.get().sleeveNotes.providers.genius.enabled) return;
  db.prepare(`INSERT INTO sleeve_research_jobs (
    id, provider, subject_type, subject_id, capability, state, priority,
    attempts, run_after, created_at, updated_at, origin_local_track_id
  ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, NULL, ?, ?, ?)
  ON CONFLICT(provider, subject_type, subject_id, capability) DO UPDATE SET
    priority = MAX(sleeve_research_jobs.priority, excluded.priority),
    state = CASE
      WHEN sleeve_research_jobs.state IN ('failed', 'cancelled') THEN 'queued'
      WHEN sleeve_research_jobs.provider = 'wikipedia' AND sleeve_research_jobs.state = 'complete'
        AND EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id
            AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
              WHERE latest.provider = 'wikipedia'
                AND latest.entity_type = source.entity_type AND latest.entity_id = source.entity_id
              ORDER BY latest.retrieved_at DESC LIMIT 1)
            AND source.content NOT LIKE '<!-- subwave-wikipedia-source-format:2 -->%') THEN 'queued'
      WHEN sleeve_research_jobs.provider = 'researcher'
        AND sleeve_research_jobs.capability IN ('extract-wikipedia', 'extract-wikipedia-release-group')
        AND EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id)
        AND NOT EXISTS (SELECT 1 FROM sleeve_wikipedia_scan_progress progress
          JOIN sleeve_source_documents source ON source.id = progress.source_document_id
          WHERE progress.job_id = sleeve_research_jobs.id
            AND source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id
            AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
              WHERE latest.provider = 'wikipedia'
                AND latest.entity_type = source.entity_type AND latest.entity_id = source.entity_id
              ORDER BY latest.retrieved_at DESC LIMIT 1)) THEN 'queued'
      ELSE sleeve_research_jobs.state END,
    run_after = CASE WHEN sleeve_research_jobs.state IN ('failed', 'cancelled')
      OR (sleeve_research_jobs.provider = 'wikipedia' AND sleeve_research_jobs.state = 'complete'
        AND EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id
            AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
              WHERE latest.provider = 'wikipedia'
                AND latest.entity_type = source.entity_type AND latest.entity_id = source.entity_id
              ORDER BY latest.retrieved_at DESC LIMIT 1)
            AND source.content NOT LIKE '<!-- subwave-wikipedia-source-format:2 -->%'))
      OR (sleeve_research_jobs.provider = 'researcher'
        AND sleeve_research_jobs.capability IN ('extract-wikipedia', 'extract-wikipedia-release-group')
        AND EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id)
        AND NOT EXISTS (SELECT 1 FROM sleeve_wikipedia_scan_progress progress
          WHERE progress.job_id = sleeve_research_jobs.id
            AND progress.source_document_id = (SELECT latest.id FROM sleeve_source_documents latest
              WHERE latest.provider = 'wikipedia'
                AND latest.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
                AND latest.entity_id = sleeve_research_jobs.subject_id
              ORDER BY latest.retrieved_at DESC LIMIT 1)))
      THEN NULL ELSE sleeve_research_jobs.run_after END,
    completed_at = CASE WHEN sleeve_research_jobs.state IN ('failed', 'cancelled')
      OR (sleeve_research_jobs.provider = 'wikipedia' AND sleeve_research_jobs.state = 'complete'
        AND EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id
            AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
              WHERE latest.provider = 'wikipedia'
                AND latest.entity_type = source.entity_type AND latest.entity_id = source.entity_id
              ORDER BY latest.retrieved_at DESC LIMIT 1)
            AND source.content NOT LIKE '<!-- subwave-wikipedia-source-format:2 -->%'))
      OR (sleeve_research_jobs.provider = 'researcher'
        AND sleeve_research_jobs.capability IN ('extract-wikipedia', 'extract-wikipedia-release-group')
        AND EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia'
            AND source.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
            AND source.entity_id = sleeve_research_jobs.subject_id)
        AND NOT EXISTS (SELECT 1 FROM sleeve_wikipedia_scan_progress progress
          WHERE progress.job_id = sleeve_research_jobs.id
            AND progress.source_document_id = (SELECT latest.id FROM sleeve_source_documents latest
              WHERE latest.provider = 'wikipedia'
                AND latest.entity_type = CASE sleeve_research_jobs.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
                AND latest.entity_id = sleeve_research_jobs.subject_id
              ORDER BY latest.retrieved_at DESC LIMIT 1)))
      THEN NULL ELSE sleeve_research_jobs.completed_at END,
    origin_local_track_id = COALESCE(sleeve_research_jobs.origin_local_track_id, excluded.origin_local_track_id),
    updated_at = excluded.updated_at`)
    .run(randomUUID(), input.provider, input.subjectType, input.subjectId,
      input.capability, input.priority, input.now, input.now, input.originLocalTrackId ?? null);
}

export function enqueueResearchJob(input: Omit<Parameters<typeof enqueueResearchJobInDatabase>[1], 'now'>): void {
  if (input.provider === 'genius' && !settings.get().sleeveNotes.providers.genius.enabled) return;
  enqueueResearchJobInDatabase(open(), { ...input, now: new Date().toISOString() });
}

/** Reacquire a cleared article through normal provider pacing before any extraction. */
export function requestWikipediaArticleRefetch(job:PendingResearchJob):void {
  const db=open(),now=new Date().toISOString();
  db.transaction(()=>{
    const capability=job.subjectType==='artist'?'biography':'release-group-biography';
    enqueueResearchJobInDatabase(db,{provider:'wikipedia',subjectType:job.subjectType,subjectId:job.subjectId,
      capability,priority:job.priority,originLocalTrackId:job.originLocalTrackId,now});
    db.prepare(`UPDATE sleeve_research_jobs SET state='queued',run_after=NULL,completed_at=NULL,
      operator_requested=MAX(operator_requested,?),updated_at=?
      WHERE provider='wikipedia' AND subject_type=? AND subject_id=? AND capability=?`)
      .run((db.prepare('SELECT operator_requested AS requested FROM sleeve_research_jobs WHERE id=?').get(job.id) as {requested:number}|undefined)?.requested??0,now,job.subjectType,job.subjectId,capability);
    db.prepare(`UPDATE sleeve_research_jobs SET state='retry-at',run_after=?,updated_at=? WHERE id=?`)
      .run(new Date(Date.now()+60_000).toISOString(),now,job.id);
  }).immediate();
}

/** Preserve explicit operator intent across source lookup and extraction stages. */
export function forwardOperatorResearchRequest(job: PendingResearchJob, provider: string, capability: string): void {
  const db=open();
  if(!(db.prepare('SELECT operator_requested AS requested FROM sleeve_research_jobs WHERE id=?').get(job.id) as {requested:number}|undefined)?.requested)return;
  // An explicit repeat can revisit a completed fallback; active work keeps its retry window.
  db.prepare(`UPDATE sleeve_research_jobs SET operator_requested=1, priority=MAX(priority,?),
    run_after=CASE WHEN state IN ('complete','failed','cancelled') THEN NULL ELSE run_after END,
    completed_at=CASE WHEN state IN ('complete','failed','cancelled') THEN NULL ELSE completed_at END,
    attempts=CASE WHEN state IN ('complete','failed','cancelled') THEN 0 ELSE attempts END,
    state=CASE WHEN state IN ('complete','failed','cancelled') THEN 'queued' ELSE state END
    WHERE provider=? AND subject_type=? AND subject_id=? AND capability=?`)
    .run(job.priority,provider,job.subjectType,job.subjectId,capability);
  db.prepare('UPDATE sleeve_research_jobs SET operator_requested=0 WHERE id=?').run(job.id);
}

/** The originating play, or an encountered track for jobs created before provenance existed. */
export function airtimeContextForResearchJob(job: PendingResearchJob): {
  artist: string | null; album: string | null; track: string;
} | null {
  const db = open();
  type Context = { artist: string | null; album: string | null; track: string };
  if (job.originLocalTrackId) {
    const origin = db.prepare(`SELECT artist, release_title AS album, title AS track
      FROM sleeve_local_attachments WHERE local_track_id = ?`)
      .get(job.originLocalTrackId) as Context | undefined;
    if (origin) return origin;
  }
  if (job.subjectType === 'artist') {
    return (db.prepare(`SELECT attachment.artist, attachment.release_title AS album,
        attachment.title AS track
      FROM sleeve_local_attachments attachment
      JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
      WHERE recording.artist_id = ?
      ORDER BY attachment.first_encountered_at ASC, attachment.local_track_id ASC LIMIT 1`)
      .get(job.subjectId) as Context | undefined) ?? null;
  }
  if (job.subjectType === 'release') {
    return (db.prepare(`SELECT attachment.artist, attachment.release_title AS album,
        attachment.title AS track
      FROM sleeve_local_attachments attachment
      JOIN sleeve_recording_releases link ON link.recording_id = attachment.recording_id
      JOIN sleeve_releases release ON release.id = link.release_id
      WHERE release.musicbrainz_release_group_id = ? AND link.is_canonical_home = 1
      ORDER BY attachment.first_encountered_at ASC, attachment.local_track_id ASC LIMIT 1`)
      .get(job.subjectId) as Context | undefined) ?? null;
  }
  return null;
}

export interface GeniusAlbumPilotSource {
  releaseGroupId: string;
  title: string;
  artist: string;
  songId: string;
  songIds?: string[];
  localTrackId?: string;
}

/** One album job per previously encountered group; cap the initial pilot. */
export function enqueueGeniusAlbumPilotJobs(limit = 20): number {
  if (!settings.get().sleeveNotes.providers.genius.enabled) return 0;
  const db = open();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const existing = (db.prepare(`SELECT COUNT(*) AS count FROM sleeve_research_jobs
      WHERE provider = 'genius' AND capability = 'album-biography'`).get() as { count: number }).count;
    const remaining = Math.max(0, Math.min(limit - existing,
      AUTOPILOT_RESEARCH_QUEUE_CAP - activeResearchQueueSizeInDatabase(db)));
    if (!remaining) return 0;
    const rows = db.prepare(`SELECT release.musicbrainz_release_group_id AS releaseGroupId,
        release.title, artist.name AS artist,
        json_extract(source.content, '$.identity.providerId') AS songId,
        attachment.local_track_id AS localTrackId
      FROM sleeve_source_documents source
      JOIN sleeve_recordings recording ON recording.id = source.entity_id
      JOIN sleeve_artists artist ON artist.id = recording.artist_id
      JOIN sleeve_recording_releases link ON link.recording_id = recording.id
        AND link.is_canonical_home = 1 AND link.is_compilation = 0
      JOIN sleeve_releases release ON release.id = link.release_id
      JOIN sleeve_local_attachments attachment ON attachment.recording_id = recording.id
      WHERE source.provider = 'genius' AND source.entity_type = 'recording'
        AND json_valid(source.content) AND json_extract(source.content, '$.identity.providerId') IS NOT NULL
        AND release.primary_type = 'Album' AND release.musicbrainz_release_group_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sleeve_claims claim
          WHERE claim.entity_type = 'release-group' AND claim.entity_id = release.musicbrainz_release_group_id
            AND claim.category = 'release-stories' AND claim.enabled = 1)
        AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs job
          WHERE job.provider = 'genius' AND job.subject_type = 'release'
            AND job.subject_id = release.musicbrainz_release_group_id AND job.capability = 'album-biography')
      ORDER BY attachment.last_encountered_at DESC
      LIMIT 1000`).all() as GeniusAlbumPilotSource[];
    const insert = db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at, origin_local_track_id)
      VALUES (?, 'genius', 'release', ?, 'album-biography', 'queued', 80, 0, NULL, ?, ?, ?)`);
    const seen = new Set<string>();
    let queued = 0;
    for (const row of rows) {
      if (!row.releaseGroupId || !row.songId || seen.has(row.releaseGroupId)) continue;
      seen.add(row.releaseGroupId);
      queued += insert.run(randomUUID(), row.releaseGroupId, now, now, row.localTrackId ?? null).changes;
      if (queued >= remaining) break;
    }
    return queued;
  }).immediate();
}

export function geniusAlbumPilotSource(releaseGroupId: string): GeniusAlbumPilotSource | null {
  const rows = open().prepare(`SELECT release.musicbrainz_release_group_id AS releaseGroupId,
      MIN(release.title) AS title, artist.name AS artist,
      json_extract(source.content, '$.identity.providerId') AS songId,
      MAX(source.retrieved_at) AS retrievedAt
    FROM sleeve_source_documents source
    JOIN sleeve_recordings recording ON recording.id = source.entity_id
    JOIN sleeve_artists artist ON artist.id = recording.artist_id
    JOIN sleeve_recording_releases link ON link.recording_id = recording.id
      AND link.is_canonical_home = 1 AND link.is_compilation = 0
    JOIN sleeve_releases release ON release.id = link.release_id
    WHERE source.provider = 'genius' AND source.entity_type = 'recording'
      AND json_valid(source.content) AND release.musicbrainz_release_group_id = ?
      AND json_extract(source.content, '$.identity.providerId') IS NOT NULL
    GROUP BY release.musicbrainz_release_group_id, artist.name,
      json_extract(source.content, '$.identity.providerId')
    ORDER BY retrievedAt DESC LIMIT 3`).all(releaseGroupId) as Array<
      GeniusAlbumPilotSource & { retrievedAt: string }
    >;
  if (!rows.length) return null;
  const songIds = [...new Set(rows.map((row) => row.songId).filter(Boolean))];
  return { ...rows[0], songIds };
}

/** A no-match album fallback may wait for Genius track lookup jobs to expose a
 * song ID that the existing album biography endpoint can use. */
export function geniusAlbumConnectionsPending(releaseGroupId: string): boolean {
  const row = open().prepare(`SELECT 1
    FROM sleeve_releases release
    JOIN sleeve_recording_releases link ON link.release_id = release.id AND link.is_canonical_home = 1
    JOIN sleeve_research_jobs job ON job.subject_type = 'recording'
      AND job.subject_id = link.recording_id AND job.provider = 'genius'
      AND job.capability = 'connections' AND job.state IN ('queued', 'retry-at', 'running')
    WHERE release.musicbrainz_release_group_id = ? LIMIT 1`).get(releaseGroupId);
  return !!row;
}

/** Fill open queue slots from played, matched albums first, then artists.
 * This also admits work deferred while the autopilot queue was at capacity. */
export function enqueueMissingWikipediaArticleJobs(now = new Date()): number {
  const timestamp = now.toISOString();
  const db = open();
  return db.transaction(() => {
    let remaining = Math.max(0, AUTOPILOT_RESEARCH_QUEUE_CAP - activeResearchQueueSizeInDatabase(db));
    if (!remaining) return 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at, origin_local_track_id
    ) VALUES (?, 'wikipedia', ?, ?, ?, 'queued', ?, 0, NULL, ?, ?, ?)`);
    let queued = 0;
    const albums = db.prepare(`SELECT release.musicbrainz_release_group_id AS id,
        MAX(encounter.encountered_at) AS lastPlayed,
        (SELECT newer.local_track_id FROM sleeve_local_attachments newer
          JOIN sleeve_encounters played ON played.local_track_id = newer.local_track_id
            AND played.source = 'played'
          JOIN sleeve_recordings recording ON recording.id = newer.recording_id
          JOIN sleeve_recording_releases canonical ON canonical.recording_id = recording.id
            AND canonical.is_canonical_home = 1
          JOIN sleeve_releases matched_release ON matched_release.id = canonical.release_id
          WHERE matched_release.musicbrainz_release_group_id = release.musicbrainz_release_group_id
          ORDER BY played.encountered_at DESC LIMIT 1) AS localTrackId
      FROM sleeve_releases release
      JOIN sleeve_recording_releases link ON link.release_id = release.id AND link.is_canonical_home = 1
      JOIN sleeve_recordings recording ON recording.id = link.recording_id
      JOIN sleeve_local_attachments local ON local.recording_id = recording.id
      JOIN sleeve_encounters encounter ON encounter.local_track_id = local.local_track_id
        AND encounter.source = 'played'
      WHERE release.primary_type = 'Album' AND release.musicbrainz_release_group_id IS NOT NULL
        AND trim(release.musicbrainz_release_group_id) <> ''
        AND NOT EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia' AND source.entity_type = 'release-group'
            AND source.entity_id = release.musicbrainz_release_group_id)
        AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs job
          WHERE job.provider = 'wikipedia' AND job.subject_type = 'release'
            AND job.subject_id = release.musicbrainz_release_group_id
            AND job.capability = 'release-group-biography')
      GROUP BY release.musicbrainz_release_group_id
      ORDER BY lastPlayed DESC, release.musicbrainz_release_group_id ASC LIMIT ?`).all(remaining) as Array<{
        id: string; localTrackId: string | null;
      }>;
    for (const album of albums) {
      if (!remaining) break;
      const result = insert.run(randomUUID(), 'release', album.id, 'release-group-biography',
        350, timestamp, timestamp, album.localTrackId);
      if (result.changes) { queued += result.changes; remaining--; }
    }
    if (!remaining) return queued;
    const albumSources = db.prepare(`SELECT source.entity_id AS id,
        (SELECT local.local_track_id FROM sleeve_local_attachments local
          JOIN sleeve_recording_releases link ON link.recording_id = local.recording_id
            AND link.is_canonical_home = 1
          JOIN sleeve_releases release ON release.id = link.release_id
          WHERE release.musicbrainz_release_group_id = source.entity_id
          ORDER BY local.last_encountered_at DESC LIMIT 1) AS localTrackId
      FROM sleeve_source_documents source
      WHERE source.provider = 'wikipedia' AND source.entity_type = 'release-group'
        AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
          WHERE latest.provider = 'wikipedia' AND latest.entity_type = 'release-group'
            AND latest.entity_id = source.entity_id ORDER BY latest.retrieved_at DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs job
          WHERE job.provider = 'researcher' AND job.subject_type = 'release'
            AND job.subject_id = source.entity_id AND job.capability = 'extract-wikipedia-release-group')
      ORDER BY source.retrieved_at DESC LIMIT ?`).all(remaining) as Array<{ id: string; localTrackId: string | null }>;
    const addAlbumExtract = db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at, origin_local_track_id
    ) VALUES (?, 'researcher', 'release', ?, 'extract-wikipedia-release-group', 'queued', 350, 0, NULL, ?, ?, ?)`);
    for (const album of albumSources) {
      if (!remaining) break;
      const result = addAlbumExtract.run(randomUUID(), album.id, timestamp, timestamp, album.localTrackId);
      if (result.changes) { queued += result.changes; remaining--; }
    }
    if (!remaining) return queued;
    const artists = db.prepare(`SELECT artist.id,
        MAX(encounter.encountered_at) AS lastPlayed,
        (SELECT newer.local_track_id FROM sleeve_local_attachments newer
          JOIN sleeve_recordings recording ON recording.id = newer.recording_id
          JOIN sleeve_encounters played ON played.local_track_id = newer.local_track_id
            AND played.source = 'played'
          WHERE recording.artist_id = artist.id
          ORDER BY played.encountered_at DESC LIMIT 1) AS localTrackId
      FROM sleeve_artists artist
      JOIN sleeve_recordings recording ON recording.artist_id = artist.id AND recording.match_state = 'matched'
      JOIN sleeve_local_attachments local ON local.recording_id = recording.id
      JOIN sleeve_encounters encounter ON encounter.local_track_id = local.local_track_id
        AND encounter.source = 'played'
      WHERE NOT EXISTS (SELECT 1 FROM sleeve_source_documents source
          WHERE source.provider = 'wikipedia' AND source.entity_type = 'artist' AND source.entity_id = artist.id)
        AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs job
          WHERE job.provider = 'wikipedia' AND job.subject_type = 'artist'
            AND job.subject_id = artist.id AND job.capability = 'biography')
      GROUP BY artist.id
      ORDER BY lastPlayed DESC, artist.id ASC LIMIT ?`).all(remaining) as Array<{ id: string; localTrackId: string | null }>;
    for (const artist of artists) {
      if (!remaining) break;
      const result = insert.run(randomUUID(), 'artist', artist.id, 'biography',
        300, timestamp, timestamp, artist.localTrackId);
      if (result.changes) { queued += result.changes; remaining--; }
    }
    if (!remaining) return queued;
    const artistSources = db.prepare(`SELECT source.entity_id AS id,
        (SELECT local.local_track_id FROM sleeve_local_attachments local
          JOIN sleeve_recordings recording ON recording.id = local.recording_id
          WHERE recording.artist_id = source.entity_id
          ORDER BY local.last_encountered_at DESC LIMIT 1) AS localTrackId
      FROM sleeve_source_documents source
      WHERE source.provider = 'wikipedia' AND source.entity_type = 'artist'
        AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
          WHERE latest.provider = 'wikipedia' AND latest.entity_type = 'artist'
            AND latest.entity_id = source.entity_id ORDER BY latest.retrieved_at DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs job
          WHERE job.provider = 'researcher' AND job.subject_type = 'artist'
            AND job.subject_id = source.entity_id AND job.capability = 'extract-wikipedia')
      ORDER BY source.retrieved_at DESC LIMIT ?`).all(remaining) as Array<{ id: string; localTrackId: string | null }>;
    const addArtistExtract = db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at, origin_local_track_id
    ) VALUES (?, 'researcher', 'artist', ?, 'extract-wikipedia', 'queued', 300, 0, NULL, ?, ?, ?)`);
    for (const artist of artistSources) {
      if (!remaining) break;
      const result = addArtistExtract.run(randomUUID(), artist.id, timestamp, timestamp, artist.localTrackId);
      if (result.changes) { queued += result.changes; remaining--; }
    }
    return queued;
  }).immediate();
}

export interface ResearchStoreSummary {
  localAttachments: number;
  encounters: number;
  pendingMatches: number;
  retainedClaims: number;
  airtimeClaims: number;
  creditClaims: number;
  storyClaims: number;
  connectionClaims: number;
  recycleBinPending: number;
  researchJobs: number;
}

export interface ResearchStoreCoverage { processed: number; queued: number; 'retry-at': number; failed: number; }

export function researchStoreCoverage(): ResearchStoreCoverage {
  const rows = open().prepare(`SELECT state, COUNT(*) AS count FROM sleeve_research_jobs
    WHERE provider = 'genius' AND capability = 'connections' GROUP BY state`).all() as Array<{ state: string; count: number }>;
  const counts = Object.fromEntries(rows.map((row) => [row.state, row.count])) as Record<string, number>;
  return { processed: counts.complete ?? 0, queued: counts.queued ?? 0,
    'retry-at': counts['retry-at'] ?? 0, failed: counts.failed ?? 0 };
}

export interface ResearchStoreReadout extends ResearchStoreSummary {
  artists: Array<{ name: string; musicbrainzId: string | null; sources: number; claims: number }>;
  claims: Array<{ id: string; enabled?: number; operatorState?: string; entityType: ResearchEntityType; entityId: string; artist: string | null; recording: string | null; category: string; topic: string; wording: string; shortWording: string; evidence: string; sourceUrl: string; provider: string }>;
  recentSparks: Array<{
    id: string;
    segmentId:string|null;
    consumer:string;
    entityType: ResearchEntityType;
    entityId: string;
    sourceUrl: string;
    trackTitle: string | null;
    trackArtist: string | null;
    offeredWording: string;
    category: string;
    topic: string;
    detectionStatus: 'detected' | 'not-detected';
    generatedSignal: ClaimSignal | null;
    speechSignal: ClaimSignal | null;
    ttsRenderedAt: string | null;
    ttsEngine: string | null;
    binExempt: boolean;
    contextPassReason: string | null;
    qualityRejectionReason: string | null;
    suppliedAt: string;
    generatedText: string;
    ttsText: string | null;
    ttsRequestedAt: string | null;
    airedAt: string | null;
    releasedAt: string | null;
  }>;
  musicBrainzSeries: Array<{
    id: string; name: string; entityType: 'recording' | 'release-group'; ranked: number;
    editionYear: number | null; fetchedAt: string | null; nextRefreshAt: string;
    attempts: number; lastError: string | null; members: number; localClaims: number;
    libraryAlbums: number; libraryTracks: number; enabled: boolean; removed: boolean;
  }>;
  jobs: Array<{ provider: string; subjectType: string; capability: string; state: string; priority: number; attempts: number; runAfter: string | null; updatedAt: string }>;
  jobSummary: Array<{ provider: string; capability: string; state: string; jobs: number; attempts: number; nextDue: string | null; updatedAt: string }>;
  providerSummary: Array<{ provider: string; capability: string; outcome: string; status: number | null; requests: number; lastRequestedAt: string }>;
}

export function researchStoreSummary(): ResearchStoreSummary {
  return researchStoreSummaryInDatabase(open());
}

export function researchStoreSummaryInDatabase(db: Database.Database): ResearchStoreSummary {
  const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
  return {
    localAttachments: count('SELECT COUNT(*) AS count FROM sleeve_local_attachments'),
    encounters: count('SELECT COUNT(*) AS count FROM sleeve_encounters'),
    pendingMatches: count(`SELECT COUNT(*) AS count FROM sleeve_research_jobs
      WHERE provider = 'musicbrainz' AND capability = 'match' AND state IN ('queued', 'retry-at')`),
    retainedClaims: count('SELECT COUNT(*) AS count FROM sleeve_claims WHERE enabled = 1'),
    airtimeClaims: count("SELECT COUNT(*) AS count FROM sleeve_claims WHERE enabled = 1 AND category <> 'credits'"),
    storyClaims: count("SELECT COUNT(*) AS count FROM sleeve_claims WHERE enabled = 1 AND category NOT IN ('credits', 'musical-connections')"),
    connectionClaims: count("SELECT COUNT(*) AS count FROM sleeve_claims WHERE enabled = 1 AND category = 'musical-connections'"),
    creditClaims: count("SELECT COUNT(*) AS count FROM sleeve_claims WHERE enabled = 1 AND category = 'credits'"),
    recycleBinPending: count("SELECT COUNT(*) AS count FROM sleeve_moderation_candidates WHERE status = 'pending'")
      + (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sleeve_airing_reviews'").get()
        ? count("SELECT COUNT(*) AS count FROM sleeve_airing_reviews WHERE state IN ('queued','running','ready')") : 0),
    researchJobs: count('SELECT COUNT(*) AS count FROM sleeve_research_jobs'),
  };
}

/** Paged search over the retained collection, rather than a recent readout slice. */
export function searchResearchStoriesInDatabase(db:Database.Database,input:{search?:string;category?:string;recent?:boolean;withdrawn?:boolean;limit?:number;offset?:number}={}) {
  const limit=Math.max(1,Math.min(200,Math.trunc(input.limit??30)));
  const offset=Math.max(0,Math.trunc(input.offset??0));
  const term=(input.search??'').trim().slice(0,120);
  const libraryOnly=input.category==='library-connections';
  const category=libraryOnly?'musical-connections':input.category??'';
  const base=`SELECT COALESCE(a.name, ra.name, album_artist.name) AS artist,
    COALESCE(r.title, local_release.title, (SELECT rg_release.title FROM sleeve_releases rg_release
      WHERE c.entity_type = 'release-group'
        AND rg_release.musicbrainz_release_group_id = c.entity_id
      ORDER BY rg_release.title LIMIT 1),
      CASE WHEN s.provider = 'musicbrainz-series' AND json_valid(s.content)
        THEN json_extract(s.content, '$.memberTitle') END) AS recording,
    c.id, c.enabled,c.operator_state AS operatorState, c.entity_type AS entityType, c.entity_id AS entityId, c.category, c.topic, c.wording, c.short_wording AS shortWording, c.evidence,
    s.source_url AS sourceUrl, s.provider FROM sleeve_claims c
    LEFT JOIN sleeve_artists a ON c.entity_type = 'artist' AND c.entity_id = a.id
    LEFT JOIN sleeve_recordings r ON c.entity_type = 'recording' AND c.entity_id = r.id
    LEFT JOIN sleeve_releases local_release ON c.entity_type = 'release' AND c.entity_id = local_release.id
    LEFT JOIN sleeve_artists ra ON ra.id = r.artist_id
    LEFT JOIN sleeve_artists album_artist ON album_artist.id = (
      SELECT ar.artist_id FROM sleeve_recording_releases rr
      JOIN sleeve_recordings ar ON ar.id=rr.recording_id
      JOIN sleeve_releases rel ON rel.id=rr.release_id
      WHERE (c.entity_type='release' AND rel.id=c.entity_id)
        OR (c.entity_type='release-group' AND rel.musicbrainz_release_group_id=c.entity_id)
      ORDER BY rr.release_id,rr.recording_id LIMIT 1)
    JOIN sleeve_source_documents s ON s.id = c.source_document_id
    WHERE ${input.withdrawn?"c.enabled=0 AND c.operator_state<>'deleted'":'c.enabled=1'}
      ${libraryOnly?`AND c.id IN (${libraryRelationshipClaimsSql(db)})`:''}`;
  const where=`(? = '' OR instr(lower(COALESCE(artist,'') || ' ' || COALESCE(recording,'') || ' ' || category || ' ' || topic || ' ' || wording),lower(?)) > 0)
    AND (? = '' OR category = ? OR (? = 'stories-only' AND category NOT IN ('credits', 'musical-connections')))`;
  // Recent is a named filter over the latest 80 facts, not the search default.
  const rows=`SELECT * FROM (${base} ORDER BY c.updated_at DESC,c.id DESC ${input.recent?'LIMIT 80':''})`;
  const args=[term,term,category,category,category];
  const total=(db.prepare(`SELECT COUNT(*) AS n FROM (${rows}) WHERE ${where}`).get(...args) as {n:number}).n;
  const claims=db.prepare(`${rows} WHERE ${where} LIMIT ? OFFSET ?`).all(...args,limit,offset) as ResearchStoreReadout['claims'];
  const categories=(db.prepare(`SELECT DISTINCT category FROM sleeve_claims WHERE ${input.withdrawn?"enabled=0 AND operator_state<>'deleted'":'enabled=1'} ORDER BY category`).all() as Array<{category:string}>).map(row=>row.category);
  return {claims,total,limit,offset,categories};
}

export function researchStoreReadout(limit = 80): ResearchStoreReadout {
  return researchStoreReadoutInDatabase(open(), limit);
}

export function researchStoreReadoutInDatabase(db: Database.Database, limit = 80): ResearchStoreReadout {
  const capped = Math.max(1, Math.min(200, Math.trunc(limit)));
  const summary = researchStoreSummaryInDatabase(db);
  const artists = db.prepare(`SELECT a.name, a.musicbrainz_id AS musicbrainzId,
    (SELECT COUNT(*) FROM sleeve_source_documents s
      WHERE s.entity_type = 'artist' AND s.entity_id = a.id) AS sources,
    (SELECT COUNT(*) FROM sleeve_claims c
      WHERE c.entity_type = 'artist' AND c.entity_id = a.id AND c.enabled = 1) AS claims
    FROM sleeve_artists a ORDER BY claims DESC, sources DESC, a.name LIMIT ?`).all(capped) as ResearchStoreReadout['artists'];
  const claims = searchResearchStoriesInDatabase(db, {limit:capped}).claims;
  const signalColumns = new Set((db.prepare('PRAGMA table_info(sleeve_claim_uses)').all() as Array<{ name: string }>).map((row) => row.name));
  const signalColumn = (name: string) => signalColumns.has(name) ? `spark.${name}` : 'NULL';
  const recentGroup=signalColumns.has('segment_id')?"COALESCE(spark.segment_id,spark.id)":'spark.id';
  const recentSparks = db.prepare(`SELECT spark.id, ${signalColumn('segment_id')} AS segmentId, spark.consumer, claim.entity_type AS entityType, claim.entity_id AS entityId, source.source_url AS sourceUrl, attachment.title AS trackTitle,
    attachment.artist AS trackArtist, spark.offered_wording AS offeredWording,
    spark.category, spark.topic, spark.detection_status AS detectionStatus,
    ${signalColumn('generated_signal')} AS generatedSignalJson, ${signalColumn('speech_signal')} AS speechSignalJson,
    ${signalColumn('tts_rendered_at')} AS ttsRenderedAt, ${signalColumn('tts_engine')} AS ttsEngine,
    spark.dj_context_pass_reason AS contextPassReason,
    spark.dj_quality_rejection_reason AS qualityRejectionReason,
    source.provider AS sourceProvider, claim.evidence AS claimEvidence,
    spark.supplied_at AS suppliedAt, COALESCE(spark.final_text, '') AS generatedText,
    spark.tts_text AS ttsText,
    spark.tts_requested_at AS ttsRequestedAt, spark.aired_at AS airedAt,
    spark.released_at AS releasedAt
    FROM sleeve_claim_uses spark
    JOIN sleeve_claims claim ON claim.id = spark.claim_id
    JOIN sleeve_source_documents source ON source.id = claim.source_document_id
    LEFT JOIN sleeve_local_attachments attachment ON attachment.local_track_id = spark.local_track_id
    WHERE spark.offered_wording <> '' AND ${recentGroup} IN (
      SELECT ${recentGroup} FROM sleeve_claim_uses spark WHERE spark.offered_wording <> ''
      GROUP BY ${recentGroup} ORDER BY MAX(spark.supplied_at) DESC,MAX(spark.id) DESC LIMIT 10)
    ORDER BY spark.supplied_at DESC,spark.id DESC`).all() as Array<Omit<ResearchStoreReadout['recentSparks'][number], 'generatedSignal' | 'speechSignal'>
      & { sourceProvider: string; claimEvidence: string; generatedSignalJson: string | null; speechSignalJson: string | null }>;
  const parseSignal = (raw: string | null): ClaimSignal | null => {
    try { return raw ? JSON.parse(raw) as ClaimSignal : null; } catch { return null; }
  };
  const recentSparksForReadout = recentSparks.map(({ sourceProvider, claimEvidence, generatedSignalJson, speechSignalJson, ...spark }) => ({
    generatedSignal: parseSignal(generatedSignalJson), speechSignal: parseSignal(speechSignalJson),
    ...spark,
    binExempt: exemptFromAutomaticRecycleBin(sourceProvider, spark.category, claimEvidence),
  }));
  const seriesDefinitions = new Map(seriesCatalogInDatabase(db, true).map((item) => [item.id, item]));
  const musicBrainzSeriesRows = db.prepare(`SELECT series.series_mbid AS id, series.series_name AS name,
    series.entity_type AS entityType, series.ranked, series.edition_year AS editionYear,
    series.fetched_at AS fetchedAt, series.next_refresh_at AS nextRefreshAt,
    series.attempts, series.last_error AS lastError,
    (SELECT COUNT(*) FROM sleeve_musicbrainz_series_members member
      WHERE member.series_mbid = series.series_mbid) AS members,
    (SELECT COUNT(DISTINCT claim.id) FROM sleeve_source_documents source
      JOIN sleeve_claims claim ON claim.source_document_id = source.id AND claim.enabled = 1
      WHERE source.provider = 'musicbrainz-series'
        AND source.source_url = 'https://musicbrainz.org/series/' || series.series_mbid) AS localClaims,
    (SELECT COUNT(DISTINCT linked.local_album_id) FROM sleeve_series_library_claims linked
      WHERE linked.series_mbid = series.series_mbid) AS libraryAlbums,
    (SELECT COUNT(DISTINCT linked.local_track_id) FROM sleeve_series_library_claims linked
      WHERE linked.series_mbid = series.series_mbid) AS libraryTracks
    FROM sleeve_musicbrainz_series series ORDER BY series.series_order`)
    .all() as ResearchStoreReadout['musicBrainzSeries'];
  const musicBrainzSeries = musicBrainzSeriesRows.map((row) => ({ ...row, enabled: seriesDefinitions.get(row.id)?.enabled ?? true, removed: seriesDefinitions.get(row.id)?.removed ?? false }));
  const jobs = db.prepare(`SELECT provider, subject_type AS subjectType, capability, state, priority,
    attempts, run_after AS runAfter, updated_at AS updatedAt
    FROM sleeve_research_jobs ORDER BY updated_at DESC LIMIT ?`).all(capped) as ResearchStoreReadout['jobs'];
  const jobSummary = db.prepare(`SELECT provider, capability, state, COUNT(*) AS jobs,
    SUM(attempts) AS attempts, MIN(run_after) AS nextDue, MAX(updated_at) AS updatedAt
    FROM sleeve_research_jobs GROUP BY provider, capability, state
    ORDER BY provider, capability, state`).all() as ResearchStoreReadout['jobSummary'];
  const providerSummary = db.prepare(`SELECT provider, capability, outcome, status_code AS status,
    COUNT(*) AS requests, MAX(requested_at) AS lastRequestedAt
    FROM sleeve_provider_requests GROUP BY provider, capability, outcome, status_code
    ORDER BY provider, capability, requests DESC`).all() as ResearchStoreReadout['providerSummary'];
  return { ...summary, artists, claims, recentSparks: recentSparksForReadout,
    musicBrainzSeries, jobs, jobSummary, providerSummary };
}

export type ResearchEntityType = 'artist' | 'recording' | 'release' | 'release-group';
export type ResearchExploreLevel = 'artists' | 'albums' | 'tracks';

export interface ResearchExploreEntity {
  entityType: ResearchEntityType;
  entityId: string;
  title: string;
  artist: string | null;
  localMatch: boolean;
  sources: number;
  claimCount: number;
  childCount: number;
  updatedAt: string;
}

export interface ResearchEntityDossier extends ResearchExploreEntity {
  claims: Array<ResearchStoreReadout['claims'][number] & { attribution: string }>;
}

export type ConnectionNodeKind = 'recording' | 'artist' | 'release' | 'series' | 'external-recording' | 'contributor';
export type ConnectionEdgeType = 'samples' | 'sampled-in' | 'cover-of' | 'covered-by'
  | 'producer' | 'writer' | 'performed-by' | 'appears-on' | 'series-membership';

export interface ConnectionNode {
  id: string;
  kind: ConnectionNodeKind;
  entityType: ResearchEntityType | 'series' | 'external-recording' | 'contributor' | 'library-artist' | 'library-album' | 'library-track' | 'external-artist';
  entityId: string;
  title: string;
  subtitle: string | null;
  local: boolean;
  expandable: boolean;
  sourceUrl: string | null;
  localTrackId?: string | null;
  localArtistId?: string | null;
  researched?: boolean;
  trackCount?: number;
  connectionCount?: number;
  verifiedConnectionCount?: number;
}

export interface ConnectionEdge {
  id: string;
  source: string;
  target: string;
  type: ConnectionEdgeType;
  label: string;
  provider: string;
  sourceUrl: string | null;
  evidence: string;
  attribution: string | null;
  count?: number;
  sources?: Array<{ evidence: string; sourceUrl: string | null; attribution: string | null }>;
}

export interface ConnectionGraph {
  focusId: string;
  nodes: ConnectionNode[];
  edges: ConnectionEdge[];
  truncated: boolean;
}

export interface ConnectionSearchResult {
  nodeId: string;
  entityType: ResearchEntityType | 'series' | 'library-artist';
  entityId: string;
  title: string;
  subtitle: string | null;
  kind: 'recording' | 'artist' | 'release' | 'series';
  artistNodeId?: string | null;
  localArtistId?: string | null;
}

export function researchStoreExplore(input: {
  level?: ResearchExploreLevel;
  artistId?: string;
  albumType?: 'release-group' | 'release';
  albumId?: string;
  letter?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): {
  entities: ResearchExploreEntity[];
  total: number;
  limit: number;
  offset: number;
} {
  return researchStoreExploreInDatabase(open(), input);
}

function explorePageBounds(input: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const rawLimit = Math.trunc(input.limit ?? 30);
  const rawOffset = Math.trunc(input.offset ?? 0);
  return {
    limit: Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 30,
    offset: Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0,
  };
}

type ResearchExploreSqlRow = Omit<ResearchExploreEntity, 'localMatch'> & { localMatch: number; total: number };

function normalizeExploreRows(rows: ResearchExploreSqlRow[]): ResearchExploreEntity[] {
  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    title: row.title,
    artist: row.artist,
    localMatch: row.localMatch === 1,
    sources: row.sources,
    claimCount: row.claimCount,
    childCount: row.childCount,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Explore loads one depth at a time. The old flat index grouped every retained
 * claim (and ran several correlated lookups per entity) before returning even
 * the first page. These level-specific reads use the artist/release/recording
 * indexes and only inspect descendants after their parent has been selected.
 */
export function researchStoreExploreInDatabase(db: Database.Database, input: {
  level?: ResearchExploreLevel;
  artistId?: string;
  albumType?: 'release-group' | 'release';
  albumId?: string;
  letter?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): { entities: ResearchExploreEntity[]; total: number; limit: number; offset: number } {
  const { limit, offset } = explorePageBounds(input);
  const search = (input.search ?? '').trim().toLowerCase().slice(0, 120);
  const pattern = `%${search}%`;
  const requestedLetter = (input.letter ?? '').toLowerCase();
  const letter = /^[a-z]$/.test(requestedLetter) ? requestedLetter : '';
  const level = input.level ?? 'artists';

  if (level === 'albums' && input.artistId) {
    const albumRows = `WITH album_rows AS (
      SELECT CASE WHEN release.musicbrainz_release_group_id IS NOT NULL THEN 'release-group' ELSE 'release' END AS entityType,
        COALESCE(release.musicbrainz_release_group_id, release.id) AS entityId,
        MIN(release.title) AS title,
        MAX(artist.name) AS artist,
        MAX(CASE WHEN recording.match_state = 'matched' THEN 1 ELSE 0 END) AS localMatch,
        COUNT(DISTINCT source.id) AS sources,
        COUNT(DISTINCT CASE WHEN claim.entity_type IN ('release', 'release-group') THEN claim.id END) AS claimCount,
        COUNT(DISTINCT CASE WHEN claim.entity_type = 'recording' THEN recording.id END) AS childCount,
        MAX(claim.updated_at) AS updatedAt
      FROM sleeve_recording_releases link
      JOIN sleeve_recordings recording ON recording.id = link.recording_id
      JOIN sleeve_artists artist ON artist.id = recording.artist_id
      JOIN sleeve_releases release ON release.id = link.release_id
      LEFT JOIN sleeve_claims claim ON claim.enabled = 1 AND (
        (claim.entity_type = 'release' AND claim.entity_id = release.id)
        OR (claim.entity_type = 'release-group' AND claim.entity_id = release.musicbrainz_release_group_id)
        OR (claim.entity_type = 'recording' AND claim.entity_id = recording.id))
      LEFT JOIN sleeve_source_documents source ON source.id = claim.source_document_id
      WHERE link.is_canonical_home = 1 AND recording.artist_id = ?
      GROUP BY entityType, entityId
      HAVING COUNT(DISTINCT claim.id) > 0
    )`;
    const filter = `(? = '' OR lower(title) LIKE ? OR lower(COALESCE(artist, '')) LIKE ?)
      AND (? = '' OR substr(lower(title), 1, 1) = ?)`;
    const rows = db.prepare(`${albumRows}
      SELECT entityType, entityId, title, artist, localMatch, sources, claimCount, childCount,
        COALESCE(updatedAt, '') AS updatedAt, COUNT(*) OVER() AS total
      FROM album_rows WHERE ${filter}
      ORDER BY title COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
      .all(input.artistId, search, pattern, pattern, letter, letter, limit, offset) as ResearchExploreSqlRow[];
    return { entities: normalizeExploreRows(rows), total: rows[0]?.total ?? 0, limit, offset };
  }

  if (level === 'tracks' && input.artistId && input.albumId && input.albumType) {
    const albumPredicate = input.albumType === 'release-group'
      ? 'release.musicbrainz_release_group_id = ?'
      : 'release.id = ?';
    const trackRows = `WITH track_rows AS (
      SELECT recording.id AS entityId, recording.title, artist.name AS artist,
        CASE WHEN recording.match_state = 'matched' THEN 1 ELSE 0 END AS localMatch,
        COUNT(DISTINCT source.id) AS sources,
        COUNT(DISTINCT claim.id) AS claimCount,
        0 AS childCount,
        MAX(claim.updated_at) AS updatedAt
      FROM sleeve_recordings recording
      JOIN sleeve_artists artist ON artist.id = recording.artist_id
      JOIN sleeve_recording_releases link ON link.recording_id = recording.id AND link.is_canonical_home = 1
      JOIN sleeve_releases release ON release.id = link.release_id
      JOIN sleeve_claims claim ON claim.entity_type = 'recording' AND claim.entity_id = recording.id AND claim.enabled = 1
      LEFT JOIN sleeve_source_documents source ON source.id = claim.source_document_id
      WHERE recording.artist_id = ? AND ${albumPredicate}
      GROUP BY recording.id
    )`;
    const filter = `(? = '' OR lower(title) LIKE ? OR lower(COALESCE(artist, '')) LIKE ?)
      AND (? = '' OR substr(lower(title), 1, 1) = ?)`;
    const rows = db.prepare(`${trackRows}
      SELECT 'recording' AS entityType, entityId, title, artist, localMatch, sources, claimCount, childCount,
        COALESCE(updatedAt, '') AS updatedAt, COUNT(*) OVER() AS total
      FROM track_rows WHERE ${filter}
      ORDER BY title COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
      .all(input.artistId, input.albumId, search, pattern, pattern, letter, letter, limit, offset) as ResearchExploreSqlRow[];
    return { entities: normalizeExploreRows(rows), total: rows[0]?.total ?? 0, limit, offset };
  }

  // The first view is intentionally a small artist index. It checks for a
  // retained claim at the artist or one of its known recording/album children,
  // but does not aggregate those descendants until an artist is opened.
  const artistHasClaims = `(
    EXISTS (SELECT 1 FROM sleeve_claims direct_claim
      WHERE direct_claim.entity_type = 'artist' AND direct_claim.entity_id = artist_row.id AND direct_claim.enabled = 1)
    OR EXISTS (SELECT 1 FROM sleeve_recordings child_recording
      JOIN sleeve_claims recording_claim ON recording_claim.entity_type = 'recording'
        AND recording_claim.entity_id = child_recording.id AND recording_claim.enabled = 1
      WHERE child_recording.artist_id = artist_row.id)
    OR EXISTS (SELECT 1 FROM sleeve_recordings album_recording
      JOIN sleeve_recording_releases album_link ON album_link.recording_id = album_recording.id
        AND album_link.is_canonical_home = 1
      JOIN sleeve_releases album_release ON album_release.id = album_link.release_id
      WHERE album_recording.artist_id = artist_row.id AND (
        EXISTS (SELECT 1 FROM sleeve_claims release_claim
          WHERE release_claim.entity_type = 'release' AND release_claim.entity_id = album_release.id AND release_claim.enabled = 1)
        OR (album_release.musicbrainz_release_group_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM sleeve_claims group_claim
          WHERE group_claim.entity_type = 'release-group'
            AND group_claim.entity_id = album_release.musicbrainz_release_group_id AND group_claim.enabled = 1))
      ))
  )`;
  const artistFilter = `(? = '' OR lower(artist_row.name) LIKE ? OR lower(COALESCE(artist_row.sort_name, '')) LIKE ?)
    AND (? = '' OR substr(lower(COALESCE(artist_row.sort_name, artist_row.name)), 1, 1) = ?)`;
  const countArtistClaims = `(SELECT COUNT(*) FROM sleeve_claims artist_claim
    WHERE artist_claim.entity_type = 'artist' AND artist_claim.entity_id = artist_row.id AND artist_claim.enabled = 1)`;
  const countArtistSources = `(SELECT COUNT(DISTINCT artist_source.id) FROM sleeve_claims artist_claim
    JOIN sleeve_source_documents artist_source ON artist_source.id = artist_claim.source_document_id
    WHERE artist_claim.entity_type = 'artist' AND artist_claim.entity_id = artist_row.id AND artist_claim.enabled = 1)`;
  const rows = db.prepare(`SELECT 'artist' AS entityType, artist_row.id AS entityId,
      artist_row.name AS title, NULL AS artist,
      CASE WHEN artist_row.musicbrainz_id IS NOT NULL THEN 1 ELSE 0 END AS localMatch,
      ${countArtistSources} AS sources,
      ${countArtistClaims} AS claimCount,
      0 AS childCount,
      artist_row.updated_at AS updatedAt,
      COUNT(*) OVER() AS total
    FROM sleeve_artists artist_row
    WHERE ${artistHasClaims} AND ${artistFilter}
    ORDER BY COALESCE(artist_row.sort_name, artist_row.name) COLLATE NOCASE ASC LIMIT ? OFFSET ?`)
    .all(search, pattern, pattern, letter, letter, limit, offset) as ResearchExploreSqlRow[];
  const localNames = connectionArtistNames(db);
  return { entities: normalizeExploreRows(rows).map(row => ({...row, localMatch: artistIsLocal(db, row.entityId, localNames)})), total: rows[0]?.total ?? 0, limit, offset };
}

export function researchEntityDossier(entityType: ResearchEntityType, entityId: string): ResearchEntityDossier | null {
  return researchEntityDossierInDatabase(open(), entityType, entityId);
}

export function researchEntityDossierInDatabase(
  db: Database.Database,
  entityType: ResearchEntityType,
  entityId: string,
): ResearchEntityDossier | null {
  const entityPredicate = entityType === 'release-group'
    ? `((c.entity_type = 'release-group' AND c.entity_id = ?)
      OR (c.entity_type = 'release' AND c.entity_id IN (
        SELECT linked_release.id FROM sleeve_releases linked_release
        WHERE linked_release.musicbrainz_release_group_id = ?)))`
    : 'c.entity_type = ? AND c.entity_id = ?';
  const entityParams = entityType === 'release-group'
    ? [entityId, entityId]
    : [entityType, entityId];
  const matchingClaims = db.prepare(`SELECT c.id, c.updated_at AS updatedAt,
      source.source_url AS sourceUrl, source.provider, source.attribution
    FROM sleeve_claims c
    JOIN sleeve_source_documents source ON source.id = c.source_document_id
    WHERE c.enabled = 1 AND ${entityPredicate}
    ORDER BY c.updated_at DESC`).all(...entityParams) as Array<{ id: string; updatedAt: string; sourceUrl: string; provider: string; attribution: string }>;
  let found = matchingClaims.length > 0;
  let title = entityId;
  let artist: string | null = null;
  let localMatch = false;
  if (entityType === 'artist') {
    const row = db.prepare(`SELECT name AS title, musicbrainz_id AS musicbrainzId
      FROM sleeve_artists WHERE id = ?`).get(entityId) as { title: string; musicbrainzId: string | null } | undefined;
    if (row) { found = true; title = row.title; localMatch = artistIsLocal(db, entityId); }
  } else if (entityType === 'recording') {
    const row = db.prepare(`SELECT recording.title, artist.name AS artist, recording.match_state AS matchState
      FROM sleeve_recordings recording LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
      WHERE recording.id = ?`).get(entityId) as { title: string; artist: string | null; matchState: string } | undefined;
    if (row) { found = true; title = row.title; artist = row.artist; localMatch = row.matchState === 'matched'; }
  } else if (entityType === 'release') {
    const row = db.prepare(`SELECT release.title,
        (SELECT linked_artist.name FROM sleeve_recording_releases link
          JOIN sleeve_recordings linked_recording ON linked_recording.id = link.recording_id
          JOIN sleeve_artists linked_artist ON linked_artist.id = linked_recording.artist_id
          WHERE link.release_id = release.id ORDER BY link.is_canonical_home DESC LIMIT 1) AS artist
      FROM sleeve_releases release WHERE release.id = ?`).get(entityId) as { title: string; artist: string | null } | undefined;
    if (row) { found = true; title = row.title; artist = row.artist; localMatch = true; }
  } else {
    const row = db.prepare(`SELECT MIN(release.title) AS title,
        (SELECT group_artist.name FROM sleeve_recordings group_recording
          JOIN sleeve_artists group_artist ON group_artist.id = group_recording.artist_id
          JOIN sleeve_recording_releases group_link ON group_link.recording_id = group_recording.id
          JOIN sleeve_releases group_release ON group_release.id = group_link.release_id
          WHERE group_release.musicbrainz_release_group_id = ?
          ORDER BY group_recording.title LIMIT 1) AS artist,
        COUNT(*) AS releases
      FROM sleeve_releases release WHERE release.musicbrainz_release_group_id = ?`)
      .get(entityId, entityId) as { title: string | null; artist: string | null; releases: number };
    title = row.title ?? entityId;
    artist = row.artist;
    localMatch = row.releases > 0;
    found ||= localMatch;
  }

  if (!found) return null;

  const claims = db.prepare(`SELECT COALESCE(a.name, recording_artist.name,
    CASE WHEN c.entity_type = 'release' THEN (
      SELECT linked_artist.name FROM sleeve_recording_releases link
      JOIN sleeve_recordings linked_recording ON linked_recording.id = link.recording_id
      JOIN sleeve_artists linked_artist ON linked_artist.id = linked_recording.artist_id
      WHERE link.release_id = local_release.id ORDER BY link.is_canonical_home DESC LIMIT 1)
    WHEN c.entity_type = 'release-group' THEN (
      SELECT group_artist.name FROM sleeve_recordings group_recording
      JOIN sleeve_artists group_artist ON group_artist.id = group_recording.artist_id
      JOIN sleeve_recording_releases group_link ON group_link.recording_id = group_recording.id
      JOIN sleeve_releases group_release ON group_release.id = group_link.release_id
      WHERE group_release.musicbrainz_release_group_id = c.entity_id
      ORDER BY group_recording.title LIMIT 1)
    ELSE NULL END) AS artist,
    CASE
      WHEN c.entity_type = 'recording' THEN recording.title
      WHEN c.entity_type = 'release' THEN local_release.title
      WHEN c.entity_type = 'release-group' THEN (
        SELECT MIN(group_release.title) FROM sleeve_releases group_release
        WHERE group_release.musicbrainz_release_group_id = c.entity_id)
      ELSE NULL
    END AS recording,
    c.id, c.category, c.topic, c.wording, c.short_wording AS shortWording, c.evidence,
    source.source_url AS sourceUrl, source.provider, source.attribution
    FROM sleeve_claims c
    LEFT JOIN sleeve_artists a ON c.entity_type = 'artist' AND c.entity_id = a.id
    LEFT JOIN sleeve_recordings recording ON c.entity_type = 'recording' AND c.entity_id = recording.id
    LEFT JOIN sleeve_artists recording_artist ON recording_artist.id = recording.artist_id
    LEFT JOIN sleeve_releases local_release ON c.entity_type = 'release' AND c.entity_id = local_release.id
    JOIN sleeve_source_documents source ON source.id = c.source_document_id
    WHERE c.enabled = 1 AND ${entityPredicate}
    ORDER BY c.updated_at DESC`).all(...entityParams) as ResearchEntityDossier['claims'];
  return {
    entityType, entityId, title, artist, localMatch,
    sources: new Set(matchingClaims.map((claim) => claim.sourceUrl)).size,
    claimCount: matchingClaims.length,
    childCount: 0,
    updatedAt: matchingClaims[0]?.updatedAt ?? '',
    claims,
  };
}

const CONNECTION_NODE_CAP = 80;
const CONNECTION_EDGE_CAP = 180;

function connectionNodeId(type: string, id: string): string {
  return `${type}:${id}`;
}

function safeStructuredEvidence(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function resolveConnectionLocalTrack(localTrackId: string): ConnectionSearchResult | null {
  return resolveConnectionLocalTrackInDatabase(open(), localTrackId);
}

export function resolveConnectionLocalTracks(ids: readonly string[]): Array<ConnectionSearchResult & { localTrackId: string }> {
  if (!ids.length) return [];
  const unique = [...new Set(ids)].slice(0, 600);
  const rows = open().prepare(`SELECT attachment.local_track_id AS localTrackId, recording.id AS entityId,
      recording.title, artist.name AS subtitle, artist.id AS artistId
    FROM sleeve_local_attachments attachment JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
    LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
    WHERE attachment.match_state = 'matched' AND attachment.local_track_id IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as Array<{ localTrackId: string; entityId: string; title: string; subtitle: string | null; artistId: string | null }>;
  return rows.map((row) => ({ localTrackId: row.localTrackId, nodeId: connectionNodeId('recording', row.entityId),
    entityType: 'recording', entityId: row.entityId, title: row.title, subtitle: row.subtitle, kind: 'recording',
    artistNodeId: row.artistId ? connectionNodeId('artist', row.artistId) : null }));
}

export function resolveConnectionLocalTrackInDatabase(
  db: Database.Database,
  localTrackId: string,
): ConnectionSearchResult | null {
  const row = db.prepare(`SELECT recording.id AS entityId, recording.title,
      artist.name AS subtitle, artist.id AS artistId
    FROM sleeve_local_attachments attachment
    JOIN sleeve_recordings recording ON recording.id = attachment.recording_id
    LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
    WHERE attachment.local_track_id = ? AND attachment.match_state = 'matched'`).get(localTrackId) as {
      entityId: string; title: string; subtitle: string | null; artistId: string | null;
    } | undefined;
  return row ? {
    nodeId: connectionNodeId('recording', row.entityId),
    entityType: 'recording', entityId: row.entityId, title: row.title,
    subtitle: row.subtitle, kind: 'recording',
    artistNodeId: row.artistId ? connectionNodeId('artist', row.artistId) : null,
  } : null;
}

export function searchConnections(query: string, limit = 12): ConnectionSearchResult[] {
  return searchConnectionsInDatabase(open(), query, limit);
}

export function searchConnectionsInDatabase(
  db: Database.Database,
  query: string,
  limit = 12,
): ConnectionSearchResult[] {
  const term = query.trim().toLowerCase().slice(0, 120);
  if (term.length < 2) return [];
  const capped = Math.max(1, Math.min(30, Math.trunc(limit)));
  const pattern = `%${term}%`;
  const rows = db.prepare(`WITH artist_choices AS (
      SELECT lower(trim(name)) AS name_key, MIN(id) AS preferred_id,
        MAX(musicbrainz_id IS NOT NULL) AS identified
      FROM sleeve_artists GROUP BY lower(trim(name))
    ), results AS (
      SELECT 'recording' AS kind, 'recording' AS entityType, recording.id AS entityId,
        recording.title, artist.name AS subtitle, 0 AS priority
      FROM sleeve_recordings recording
      LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
      WHERE lower(recording.title) LIKE ? OR lower(COALESCE(artist.name, '')) LIKE ?
      UNION ALL
      SELECT 'artist', 'artist', artist.id, artist.name, NULL, 1
      FROM sleeve_artists artist JOIN artist_choices choice ON choice.name_key=lower(trim(artist.name))
      WHERE (lower(artist.name) LIKE ? OR lower(COALESCE(artist.sort_name, '')) LIKE ?)
        AND (artist.musicbrainz_id IS NOT NULL OR (choice.identified=0 AND artist.id=choice.preferred_id))
      UNION ALL
      SELECT 'release',
        CASE WHEN release.musicbrainz_release_group_id IS NULL THEN 'release' ELSE 'release-group' END,
        COALESCE(release.musicbrainz_release_group_id, release.id), MIN(release.title), NULL, 2
      FROM sleeve_releases release
      WHERE lower(release.title) LIKE ?
      GROUP BY 2, 3
      UNION ALL
      SELECT 'series', 'series', series.series_mbid, series.series_name,
        CASE WHEN series.entity_type = 'recording' THEN 'Track list' ELSE 'Album list' END, 3
      FROM sleeve_musicbrainz_series series
      WHERE lower(series.series_name) LIKE ?
    )
    SELECT kind, entityType, entityId, title, subtitle FROM results
    ORDER BY CASE WHEN lower(title) = ? THEN 0 ELSE 1 END, priority, title COLLATE NOCASE
    LIMIT ?`).all(pattern, pattern, pattern, pattern, pattern, pattern, term, capped) as Array<{
      kind: ConnectionSearchResult['kind']; entityType: ConnectionSearchResult['entityType'];
      entityId: string; title: string; subtitle: string | null;
    }>;
  return rows.map((row) => ({ ...row, nodeId: connectionNodeId(row.entityType, row.entityId) }));
}

export function researchConnectionsGraph(input: {
  entityType: ResearchEntityType | 'series';
  entityId: string;
  edgeTypes?: readonly ConnectionEdgeType[];
}): ConnectionGraph | null {
  return researchConnectionsGraphInDatabase(open(), input);
}

export function researchConnectionsGraphInDatabase(db: Database.Database, input: {
  entityType: ResearchEntityType | 'series';
  entityId: string;
  edgeTypes?: readonly ConnectionEdgeType[];
}): ConnectionGraph | null {
  const nodes = new Map<string, ConnectionNode>();
  const edges = new Map<string, ConnectionEdge>();
  const allowed = input.edgeTypes ? new Set(input.edgeTypes) : null;
  let truncated = false;
  const edgeAllowed = (type: ConnectionEdgeType) => !allowed || allowed.has(type);
  const addNode = (node: ConnectionNode): boolean => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= CONNECTION_NODE_CAP) { truncated = true; return false; }
    nodes.set(node.id, node);
    return true;
  };
  const addEdge = (edge: ConnectionEdge): void => {
    if (!edgeAllowed(edge.type) || edges.has(edge.id)) return;
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) return;
    if (edges.size >= CONNECTION_EDGE_CAP) { truncated = true; return; }
    edges.set(edge.id, edge);
  };

  const addRecording = (id: string): ConnectionNode | null => {
    const nodeId = connectionNodeId('recording', id);
    const cached = nodes.get(nodeId);
    if (cached) return cached;
    const row = db.prepare(`SELECT recording.title, recording.match_state AS matchState,
        artist.name AS artist
      FROM sleeve_recordings recording
      LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
      WHERE recording.id = ?`).get(id) as {
        title: string; matchState: string; artist: string | null;
      } | undefined;
    if (!row) return null;
    const libraryMatch = db.prepare(`SELECT local_track_id AS id FROM sleeve_connection_library_matches
      WHERE recording_id = ? ORDER BY local_track_id LIMIT 1`).get(id) as { id: string } | undefined;
    const node: ConnectionNode = { id: nodeId, kind: 'recording', entityType: 'recording',
      entityId: id, title: row.title, subtitle: row.artist, local: row.matchState === 'matched',
      ...(libraryMatch ? { localTrackId: libraryMatch.id } : {}),
      expandable: true, sourceUrl: null };
    return addNode(node) ? node : null;
  };

  const addArtist = (id: string): ConnectionNode | null => {
    const nodeId = connectionNodeId('artist', id);
    const cached = nodes.get(nodeId);
    if (cached) return cached;
    const row = db.prepare(`SELECT name, musicbrainz_id AS musicbrainzId
      FROM sleeve_artists WHERE id = ?`).get(id) as { name: string; musicbrainzId: string | null } | undefined;
    if (!row) return null;
    const node: ConnectionNode = { id: nodeId, kind: 'artist', entityType: 'artist', entityId: id,
      title: row.name, subtitle: 'Artist', local: true, expandable: true,
      sourceUrl: row.musicbrainzId ? `https://musicbrainz.org/artist/${row.musicbrainzId}` : null };
    return addNode(node) ? node : null;
  };

  const addRelease = (type: 'release' | 'release-group', id: string): ConnectionNode | null => {
    const nodeId = connectionNodeId(type, id);
    const cached = nodes.get(nodeId);
    if (cached) return cached;
    const row = type === 'release-group'
      ? db.prepare(`SELECT MIN(title) AS title FROM sleeve_releases
          WHERE musicbrainz_release_group_id = ?`).get(id) as { title: string | null } | undefined
      : db.prepare(`SELECT title FROM sleeve_releases WHERE id = ?`).get(id) as { title: string | null } | undefined;
    if (!row?.title) return null;
    const node: ConnectionNode = { id: nodeId, kind: 'release', entityType: type, entityId: id,
      title: row.title, subtitle: type === 'release-group' ? 'Album' : 'Release', local: true,
      expandable: true, sourceUrl: type === 'release-group' ? `https://musicbrainz.org/release-group/${id}` : null };
    return addNode(node) ? node : null;
  };

  const addSeries = (id: string): ConnectionNode | null => {
    const nodeId = connectionNodeId('series', id);
    const cached = nodes.get(nodeId);
    if (cached) return cached;
    const row = db.prepare(`SELECT series_name AS name, entity_type AS entityType
      FROM sleeve_musicbrainz_series WHERE series_mbid = ?`).get(id) as { name: string; entityType: string } | undefined;
    if (!row) return null;
    const node: ConnectionNode = { id: nodeId, kind: 'series', entityType: 'series', entityId: id,
      title: row.name, subtitle: row.entityType === 'recording' ? 'Track list' : 'Album list',
      local: false, expandable: true, sourceUrl: `https://musicbrainz.org/series/${id}` };
    return addNode(node) ? node : null;
  };

  const musicBrainzEdge = (source: string, target: string, type: ConnectionEdgeType,
    label: string, evidence: string, sourceUrl: string | null): void => addEdge({
      id: `musicbrainz:${type}:${source}:${target}`, source, target, type, label,
      provider: 'musicbrainz', sourceUrl, evidence, attribution: 'Canonical music identity from MusicBrainz',
    });

  const addRecordingBackbone = (recordingId: string): void => {
    const recording = addRecording(recordingId);
    if (!recording) return;
    if (edgeAllowed('performed-by')) {
      const artistRow = db.prepare(`SELECT artist.id FROM sleeve_recordings recording
        JOIN sleeve_artists artist ON artist.id = recording.artist_id WHERE recording.id = ?`)
        .get(recordingId) as { id: string } | undefined;
      const artist = artistRow ? addArtist(artistRow.id) : null;
      if (artist) musicBrainzEdge(recording.id, artist.id, 'performed-by', 'performed by',
        `${recording.title} is performed by ${artist.title}.`, artist.sourceUrl);
    }
    if (edgeAllowed('appears-on')) {
      const releaseRows = db.prepare(`SELECT release.id,
          release.musicbrainz_release_group_id AS releaseGroupId, release.title
        FROM sleeve_recording_releases link
        JOIN sleeve_releases release ON release.id = link.release_id
        WHERE link.recording_id = ?
        ORDER BY link.is_canonical_home DESC, link.is_first_official_non_compilation DESC,
          link.release_date LIMIT 6`).all(recordingId) as Array<{ id: string; releaseGroupId: string | null; title: string }>;
      const seen = new Set<string>();
      for (const row of releaseRows) {
        const type = row.releaseGroupId ? 'release-group' : 'release';
        const id = row.releaseGroupId ?? row.id;
        if (seen.has(`${type}:${id}`)) continue;
        seen.add(`${type}:${id}`);
        const release = addRelease(type, id);
        if (release) musicBrainzEdge(recording.id, release.id, 'appears-on', 'appears on',
          `${recording.title} appears on ${release.title}.`, release.sourceUrl);
      }
    }
  };

  const addGeniusEdges = (recordingId: string): void => {
    const sourceNode = addRecording(recordingId);
    if (!sourceNode) return;
    const rows = db.prepare(`SELECT claim.id, claim.category, claim.evidence,
        source.source_url AS sourceUrl, source.attribution
      FROM sleeve_claims claim
      JOIN sleeve_source_documents source ON source.id = claim.source_document_id
      WHERE claim.enabled = 1 AND claim.entity_type = 'recording' AND claim.entity_id = ?
        AND source.provider = 'genius'
        AND claim.category IN ('credits', 'musical-connections')
      ORDER BY claim.updated_at DESC LIMIT 220`).all(recordingId) as Array<{
        id: string; category: string; evidence: string; sourceUrl: string; attribution: string;
      }>;
    const resolvedConnections = libraryConnectionsInDatabase(db, recordingId);
    const relationships: Array<{ row: typeof rows[number]; evidence: Record<string, unknown> }> = [];
    const providerIds: string[] = [];
    for (const row of rows) {
      const evidence = safeStructuredEvidence(row.evidence);
      if (!evidence) continue;
      if (row.category === 'musical-connections') {
        relationships.push({ row, evidence });
        const target = evidence.target as Record<string, unknown> | undefined;
        if (typeof target?.providerId === 'string') providerIds.push(target.providerId);
      }
    }
    const localTargets = new Map<string, { id: string; title: string; artist: string | null }>();
    const distinctIds = [...new Set(providerIds)];
    if (distinctIds.length) {
      const placeholders = distinctIds.map(() => '?').join(', ');
      const matches = db.prepare(`SELECT json_extract(source.content, '$.identity.providerId') AS providerId,
          recording.id, recording.title, artist.name AS artist
        FROM sleeve_source_documents source
        JOIN sleeve_recordings recording ON source.entity_type = 'recording' AND source.entity_id = recording.id
        LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
        WHERE source.provider = 'genius' AND json_valid(source.content)
          AND json_extract(source.content, '$.identity.providerId') IN (${placeholders})
        ORDER BY source.retrieved_at DESC`).all(...distinctIds) as Array<{
          providerId: string; id: string; title: string; artist: string | null;
        }>;
      for (const match of matches) if (!localTargets.has(match.providerId)) localTargets.set(match.providerId, match);
    }
    for (const { row, evidence } of relationships) {
      const rawType = evidence.type;
      if (typeof rawType !== 'string') continue;
      const edgeType = ({ samples: 'samples', sampled_in: 'sampled-in', cover_of: 'cover-of', covered_by: 'covered-by' } as const)
        [rawType as 'samples' | 'sampled_in' | 'cover_of' | 'covered_by'];
      if (!edgeType || !edgeAllowed(edgeType)) continue;
      const target = evidence.target as Record<string, unknown> | undefined;
      const providerId = typeof target?.providerId === 'string' ? target.providerId : '';
      const title = typeof target?.title === 'string' ? target.title : '';
      if (!providerId || !title) continue;
      const artist = typeof target?.artist === 'string' ? target.artist : null;
      const resolved = resolvedConnections.find((connection) => connection.claimId === row.id
        && connection.targetKind === 'recording');
      const libraryTrack = resolved?.matchState === 'matched' ? resolved.tracks[0] : null;
      const local = resolved ? null : localTargets.get(providerId);
      let targetNode: ConnectionNode | null = libraryTrack?.recordingId
        ? addRecording(libraryTrack.recordingId) : local ? addRecording(local.id) : null;
      if (targetNode && libraryTrack) targetNode.localTrackId = libraryTrack.id;
      if (!targetNode) {
        const id = connectionNodeId('genius-recording', providerId);
        const external: ConnectionNode = { id, kind: 'external-recording', entityType: 'external-recording',
          entityId: providerId, title, subtitle: artist, local: !!libraryTrack, expandable: false,
          ...(libraryTrack ? { localTrackId: libraryTrack.id } : {}),
          sourceUrl: typeof target?.canonicalUrl === 'string' ? target.canonicalUrl : null };
        targetNode = addNode(external) ? external : null;
      }
      if (!targetNode) continue;
      const label = ({ samples: 'samples', 'sampled-in': 'is sampled in', 'cover-of': 'is a cover of', 'covered-by': 'is covered by' } as const)[edgeType];
      addEdge({ id: `genius:${row.id}`, source: sourceNode.id, target: targetNode.id,
        type: edgeType, label, provider: 'genius', sourceUrl: row.sourceUrl,
        evidence: `${sourceNode.title} ${label} ${targetNode.title}.`, attribution: row.attribution });
    }
    const expandedContributors = new Set<string>();
    const addContributorPeers = (providerId: string, contributor: ConnectionNode): void => {
      if (expandedContributors.has(providerId)) return;
      expandedContributors.add(providerId);
      const peers = db.prepare(`SELECT claim.id, claim.entity_id AS recordingId, claim.evidence,
          source.source_url AS sourceUrl, source.attribution
        FROM sleeve_claims claim
        JOIN sleeve_source_documents source ON source.id = claim.source_document_id
        WHERE claim.enabled = 1 AND claim.entity_type = 'recording'
          AND claim.category = 'credits' AND source.provider = 'genius'
          AND json_valid(claim.evidence)
          AND EXISTS (SELECT 1 FROM json_each(claim.evidence, '$.contributors') item
            WHERE json_extract(item.value, '$.providerId') = ?)
        ORDER BY claim.updated_at DESC LIMIT 24`).all(providerId) as Array<{
          id: string; recordingId: string; evidence: string; sourceUrl: string; attribution: string;
        }>;
      if (peers.length === 24) truncated = true;
      for (const peer of peers) {
        const peerEvidence = safeStructuredEvidence(peer.evidence);
        const peerRole = peerEvidence?.role;
        const peerType: ConnectionEdgeType | null = peerRole === 'Producer' ? 'producer' : peerRole === 'Writer' ? 'writer' : null;
        if (!peerType || !edgeAllowed(peerType)) continue;
        const recording = addRecording(peer.recordingId);
        if (!recording) continue;
        const peerLabel = peerType === 'producer' ? 'produced by' : 'written by';
        addEdge({ id: `genius:${peer.id}:${providerId}`, source: recording.id, target: contributor.id,
          type: peerType, label: peerLabel, provider: 'genius', sourceUrl: peer.sourceUrl,
          evidence: `${recording.title} is credited to ${contributor.title} for ${peerType}.`, attribution: peer.attribution });
      }
    };
    for (const row of rows) {
      if (row.category !== 'credits') continue;
      const evidence = safeStructuredEvidence(row.evidence);
      const role = evidence?.role;
      const type: ConnectionEdgeType | null = role === 'Producer' ? 'producer' : role === 'Writer' ? 'writer' : null;
      if (!type || !edgeAllowed(type) || !Array.isArray(evidence?.names)) continue;
      const roleLabel = type === 'producer' ? 'Producer' : 'Writer';
      const contributors = Array.isArray(evidence.contributors) ? evidence.contributors : [];
      for (const [index, value] of evidence.names.entries()) {
        if (typeof value !== 'string' || !value.trim()) continue;
        const identityMatches = contributors.filter((contributor) => contributor && typeof contributor === 'object'
          && connectionNameKey((contributor as Record<string, unknown>).name) === connectionNameKey(value));
        const identified = identityMatches.length === 1 ? identityMatches[0] as Record<string, unknown> : null;
        const providerId = typeof identified?.providerId === 'string' ? identified.providerId : null;
        // Existing cached Genius projections retained names but not contributor
        // IDs. Scope those nodes to their claim so two people are never merged
        // on name alone; newly identified contributors form safe shared hubs.
        const contributorId = providerId
          ? connectionNodeId('genius-contributor', providerId)
          : connectionNodeId('credit', `${row.id}:${index}`);
        const contributor: ConnectionNode = { id: contributorId, kind: 'contributor',
          entityType: 'contributor', entityId: providerId ?? `${row.id}:${index}`, title: value.trim(),
          subtitle: providerId ? roleLabel : `${roleLabel} · identity unresolved`,
          local: false, expandable: false,
          sourceUrl: typeof identified?.canonicalUrl === 'string' ? identified.canonicalUrl : row.sourceUrl };
        if (!addNode(contributor)) continue;
        addEdge({ id: `genius:${row.id}:${index}`, source: sourceNode.id, target: contributor.id,
          type, label: role === 'Producer' ? 'produced by' : 'written by', provider: 'genius',
          sourceUrl: row.sourceUrl, evidence: `${sourceNode.title} is credited to ${contributor.title} for ${roleLabel.toLowerCase()}.`,
          attribution: row.attribution });
        if (providerId) addContributorPeers(providerId, contributor);
      }
    }
  };

  let focusId = connectionNodeId(input.entityType, input.entityId);
  if (input.entityType === 'recording') {
    const focus = addRecording(input.entityId);
    if (!focus) return null;
    focusId = focus.id;
    addRecordingBackbone(input.entityId);
    addGeniusEdges(input.entityId);
  } else if (input.entityType === 'artist') {
    const focus = addArtist(input.entityId);
    if (!focus) return null;
    focusId = focus.id;
    // Retained-data fallback if this artist has no unambiguous local index
    // identity yet. Keep the artist layer at album level here as well.
    if (edgeAllowed('appears-on')) {
      const releases = db.prepare(`SELECT DISTINCT release.id, release.musicbrainz_release_group_id AS groupId
        FROM sleeve_recording_releases link JOIN sleeve_recordings recording ON recording.id = link.recording_id
        JOIN sleeve_releases release ON release.id = link.release_id
        WHERE recording.artist_id = ? ORDER BY release.title, release.id LIMIT 80`)
        .all(input.entityId) as Array<{ id: string; groupId: string | null }>;
      if (releases.length === 80) truncated = true;
      for (const row of releases) {
        const release = addRelease(row.groupId ? 'release-group' : 'release', row.groupId ?? row.id);
        if (release) musicBrainzEdge(focus.id, release.id, 'appears-on', 'has recordings on',
          `${focus.title} has matched recordings on ${release.title}.`, release.sourceUrl);
        if (nodes.size >= CONNECTION_NODE_CAP) { truncated = true; break; }
      }
    }
  } else if (input.entityType === 'release' || input.entityType === 'release-group') {
    const focus = addRelease(input.entityType, input.entityId);
    if (!focus) return null;
    focusId = focus.id;
    if (edgeAllowed('appears-on')) {
      const predicate = input.entityType === 'release-group'
        ? 'release.musicbrainz_release_group_id = ?'
        : 'release.id = ?';
      const recordings = db.prepare(`SELECT DISTINCT recording.id FROM sleeve_recording_releases link
        JOIN sleeve_recordings recording ON recording.id = link.recording_id
        JOIN sleeve_releases release ON release.id = link.release_id
        WHERE ${predicate} ORDER BY recording.title LIMIT 60`).all(input.entityId) as Array<{ id: string }>;
      if (recordings.length === 60) truncated = true;
      for (const row of recordings) {
        const recording = addRecording(row.id);
        if (recording) musicBrainzEdge(recording.id, focus.id, 'appears-on', 'appears on',
          `${recording.title} appears on ${focus.title}.`, focus.sourceUrl);
      }
    }
  } else {
    const focus = addSeries(input.entityId);
    if (!focus) return null;
    focusId = focus.id;
    if (edgeAllowed('series-membership')) {
      const series = db.prepare(`SELECT entity_type AS entityType FROM sleeve_musicbrainz_series
        WHERE series_mbid = ?`).get(input.entityId) as { entityType: 'recording' | 'release-group' };
      if (series.entityType === 'recording') {
        const recordings = db.prepare(`SELECT DISTINCT recording.id FROM sleeve_musicbrainz_series_members member
          JOIN sleeve_recordings recording ON recording.musicbrainz_id = member.entity_mbid
          WHERE member.series_mbid = ? ORDER BY recording.title LIMIT 60`).all(input.entityId) as Array<{ id: string }>;
        if (recordings.length === 60) truncated = true;
        for (const row of recordings) {
          const recording = addRecording(row.id);
          if (recording) musicBrainzEdge(recording.id, focus.id, 'series-membership', 'included in',
            `${recording.title} is included in ${focus.title}.`, focus.sourceUrl);
        }
      } else {
        const releases = db.prepare(`SELECT DISTINCT release.musicbrainz_release_group_id AS id
          FROM sleeve_musicbrainz_series_members member
          JOIN sleeve_releases release ON release.musicbrainz_release_group_id = member.entity_mbid
          WHERE member.series_mbid = ? ORDER BY release.title LIMIT 60`).all(input.entityId) as Array<{ id: string }>;
        if (releases.length === 60) truncated = true;
        for (const row of releases) {
          const release = addRelease('release-group', row.id);
          if (release) musicBrainzEdge(release.id, focus.id, 'series-membership', 'included in',
            `${release.title} is included in ${focus.title}.`, focus.sourceUrl);
        }
      }
    }
  }
  return { focusId, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}
