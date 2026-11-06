// Local, bounded Sleeve Notes selection for the ordinary DJ link prompt.
// This module never calls a provider; an unavailable or unmatched store is a
// clean miss and leaves the regular Verified Facts packet untouched.
import { detectClaimSignal, claimDetailContradiction, type ClaimSignal } from './claim-signal.js';
import { normalizeForDisplay, normalizeForSpeech } from '../audio/speech-text.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import * as settings from '../settings.js';
import { open } from './db.js';
import { activeSeriesMap } from './series-catalog-store.js';
import { recordLiveDjRejection } from './moderation.js';
import { libraryConnectionsInDatabase, type LibraryConnection } from './library-connections.js';

const EXACT_CLAIM_COOLDOWN_MS = 21 * 24 * 60 * 60 * 1000;
const TOPIC_COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000;
const RELATIONSHIP_COOLDOWN_MS = 60 * 24 * 60 * 60 * 1000;
const SERIES_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PENDING_RESERVATION_MS = 2 * 60 * 60 * 1000;
// A measured vocal entry below this leaves no useful room for an Extended
// Sleeve Note. Skip the lookup entirely so the ordinary link writer receives
// the track without an optional Spark to force into its opening sentence.
export const EXTENDED_SLEEVE_NOTE_MIN_VOCAL_RUNWAY_MS = 2_000;
const ENTITY_COOLDOWN_MS = {
  recording: 21 * 24 * 60 * 60 * 1000,
  release: 45 * 24 * 60 * 60 * 1000,
  'release-group': 45 * 24 * 60 * 60 * 1000,
  artist: 90 * 24 * 60 * 60 * 1000,
} as const;
const MAX_COOLDOWN_MS = Math.max(
  TOPIC_COOLDOWN_MS,
  RELATIONSHIP_COOLDOWN_MS,
  ...Object.values(ENTITY_COOLDOWN_MS),
);

/** Compatibility wrapper for prompt checks; diagnostics retain the full signal. */
export function extendedSleeveNoteHasClearTextSignal(
  text: string, wording: string, trackArtist: unknown, trackTitle: unknown,
): boolean {
  return detectClaimSignal(text, wording, [trackArtist, trackTitle]).status === 'detected';
}

export interface ExtendedSleeveNote {
  claimId: string;
  entityType: 'artist' | 'recording' | 'release' | 'release-group';
  entityId: string;
  category: string;
  topic: string;
  /** Wording selected for this generation; Full remains available to other consumers. */
  wording: string;
  fullWording: string;
  shortWording: string | null;
  airtimeScope?: 'general' | 'matching-release-only' | 'matching-track-only';
  matchingReleaseTitle?: string | null;
  matchingTrackTitle?: string | null;
  provider: string;
  attribution: string;
  sourceUrl: string;
  relationshipKey: string | null;
  localTrackId: string;
  extractionRank?: number | null;
  extractionSection?: number | null;
  connection?: LibraryConnection;
}

export interface SleeveNoteSelectionCandidate extends ExtendedSleeveNote {
  sourceContent: string;
  evidence: string;
}

export interface SleeveNoteRecentUse {
  seriesKey?: string | null;
  claimId: string;
  entityType: ExtendedSleeveNote['entityType'];
  entityId: string;
  topic: string;
  relationshipKey: string | null;
  suppliedAt: string;
  airedAt: string | null;
  releasedAt: string | null;
  detectionStatus: 'detected' | 'not-detected';
  qualityRejectionReason?: string | null;
  contextPassReason?: string | null;
}

export type ExtendedSleeveNoteAvailability = 'disabled' | 'unavailable' | 'available' | 'cooldown';

export interface ExtendedSleeveNoteInspection {
  status: ExtendedSleeveNoteAvailability;
  note: ExtendedSleeveNote | null;
  candidateCount: number;
}

const ENTITY_PRIORITY: Record<ExtendedSleeveNote['entityType'], number> = {
  recording: 0,
  release: 1,
  'release-group': 1,
  artist: 2,
};

const CATEGORY_PRIORITY: Record<string, number> = {
  'track-stories': 0,
  'release-stories': 1,
  'musical-connections': 2,
  recognition: 4,
  milestones: 5,
  'artist-stories': 6,
  credits: 7,
};

/** Unknown vocal timing remains eligible; only a known sub-two-second entry skips Sparks. */
export function extendedSleeveNoteAllowedForVocalRunway(firstVocalMs: number | null): boolean {
  return firstVocalMs == null
    || !Number.isFinite(firstVocalMs)
    || firstVocalMs < 0
    || firstVocalMs >= EXTENDED_SLEEVE_NOTE_MIN_VOCAL_RUNWAY_MS;
}

function relationshipKey(provider: string, sourceContent: string, evidence: string): string | null {
  if (provider !== 'genius') return null;
  try {
    const sourceId = (JSON.parse(sourceContent) as { identity?: { providerId?: unknown } })?.identity?.providerId;
    const targetId = (JSON.parse(evidence) as { target?: { providerId?: unknown } })?.target?.providerId;
    if (sourceId == null || targetId == null) return null;
    // Sorting makes an inverse relationship share the same local suppression
    // key, without sending raw Genius payloads to the prompt.
    return [`genius:${String(sourceId)}`, `genius:${String(targetId)}`].sort().join('|');
  } catch {
    return null;
  }
}

function eligibleProvider(provider: string): boolean {
  if (provider === 'wikipedia') return true;
  if (provider === 'genius') return settings.get().sleeveNotes.providers.genius.enabled === true;
  if (provider === 'musicbrainz-series') return true;
  return false;
}

function isRecent(iso: string, nowMs: number, cooldownMs: number): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > nowMs - cooldownMs;
}

function isNovel(candidate: SleeveNoteSelectionCandidate, uses: readonly SleeveNoteRecentUse[], nowMs: number, segment = false): boolean {
  for (const use of uses) {
    const reservationActive = !use.airedAt && !use.releasedAt
      && isRecent(use.suppliedAt, nowMs, PENDING_RESERVATION_MS);
    // A link airing does not prove the DJ used its offered claim. Cool down
    // only when the spoken text had a clear claim signal and the clip aired.
    const claimAiredAt = use.detectionStatus === 'detected' ? use.airedAt : null;
    if (candidate.provider === 'musicbrainz-series' && use.seriesKey === candidate.sourceUrl
      && claimAiredAt && isRecent(claimAiredAt, nowMs, SERIES_COOLDOWN_MS)) return false;
    const creditRejectedAt = candidate.category === 'credits' && use.claimId === candidate.claimId
      && use.qualityRejectionReason ? use.airedAt : null;
    if (!reservationActive && !claimAiredAt && !creditRejectedAt) continue;
    const usedAt = reservationActive ? use.suppliedAt : claimAiredAt ?? creditRejectedAt!;
    const cooldownActive = (windowMs: number) => isRecent(usedAt, nowMs, windowMs);
    if (use.claimId === candidate.claimId && cooldownActive(EXACT_CLAIM_COOLDOWN_MS)) return false;
    if (use.entityType === candidate.entityType && use.entityId === candidate.entityId) {
      if (use.topic === candidate.topic && cooldownActive(TOPIC_COOLDOWN_MS)) return false;
      if (!segment && cooldownActive(ENTITY_COOLDOWN_MS[candidate.entityType])) return false;
    }
    if (candidate.relationshipKey && use.relationshipKey === candidate.relationshipKey
      && cooldownActive(RELATIONSHIP_COOLDOWN_MS)) return false;
  }
  return true;
}

function recentUsesForCandidates(
  db: Database.Database,
  candidates: readonly SleeveNoteSelectionCandidate[],
  nowMs: number,
): SleeveNoteRecentUse[] {
  const claimIds = [...new Set(candidates.map((candidate) => candidate.claimId))];
  const entities: Array<[string, string]> = [];
  const entityKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.entityType}\u0000${candidate.entityId}`;
    if (entityKeys.has(key)) continue;
    entityKeys.add(key);
    entities.push([candidate.entityType, candidate.entityId]);
  }
  const relationshipKeys = [...new Set(candidates
    .map((candidate) => candidate.relationshipKey)
    .filter((key): key is string => !!key))];

  const relevantParts = [
    `claim_id IN (${claimIds.map(() => '?').join(', ')})`,
    ...entities.map(() => '(entity_type = ? AND entity_id = ?)'),
  ];
  const relevantParams: string[] = [...claimIds];
  for (const [entityType, entityId] of entities) relevantParams.push(entityType, entityId);
  if (relationshipKeys.length) {
    relevantParts.push(`relationship_key IN (${relationshipKeys.map(() => '?').join(', ')})`);
    relevantParams.push(...relationshipKeys);
  }

  const relevant = `(${relevantParts.join(' OR ')})`;
  const recentCutoff = new Date(nowMs - MAX_COOLDOWN_MS).toISOString();
  const reservationCutoff = new Date(nowMs - PENDING_RESERVATION_MS).toISOString();
  const uses = db.prepare(`SELECT claim_id AS claimId, entity_type AS entityType,
      entity_id AS entityId, topic, relationship_key AS relationshipKey,
      supplied_at AS suppliedAt, aired_at AS airedAt, released_at AS releasedAt,
      detection_status AS detectionStatus,
      dj_quality_rejection_reason AS qualityRejectionReason,
      dj_context_pass_reason AS contextPassReason
    FROM sleeve_claim_uses
    WHERE (aired_at >= ? AND ${relevant})
      OR (aired_at IS NULL AND released_at IS NULL AND supplied_at >= ? AND ${relevant})
      OR (dj_context_pass_reason IS NOT NULL AND supplied_at >= ? AND ${relevant})`)
    .all(recentCutoff, ...relevantParams, reservationCutoff, ...relevantParams,
      recentCutoff, ...relevantParams) as SleeveNoteRecentUse[];
  const seriesUrls = [...new Set(candidates.filter(candidate => candidate.provider === 'musicbrainz-series')
    .map(candidate => candidate.sourceUrl))];
  if (seriesUrls.length) {
    // Resolve old ledger rows through their retained source, so this also works
    // for airings recorded before series-wide cooldowns existed.
    const seriesUses = db.prepare(`SELECT u.claim_id AS claimId, u.entity_type AS entityType,
      u.entity_id AS entityId, u.topic, u.relationship_key AS relationshipKey,
      u.supplied_at AS suppliedAt, u.aired_at AS airedAt, u.released_at AS releasedAt,
      u.detection_status AS detectionStatus, s.source_url AS seriesKey
      FROM sleeve_claim_uses u JOIN sleeve_claims c ON c.id=u.claim_id
      JOIN sleeve_source_documents s ON s.id=c.source_document_id
      WHERE u.aired_at > ? AND u.detection_status='detected' AND s.provider='musicbrainz-series'
        AND s.source_url IN (${seriesUrls.map(() => '?').join(',')})`)
      .all(new Date(nowMs-SERIES_COOLDOWN_MS).toISOString(), ...seriesUrls) as SleeveNoteRecentUse[];
    uses.push(...seriesUses);
  }
  return uses;
}

function eligibleCandidates(candidates: readonly SleeveNoteSelectionCandidate[], uses: readonly SleeveNoteRecentUse[], nowMs: number, segment = false): SleeveNoteSelectionCandidate[] {
  return candidates.filter(candidate => isNovel(candidate, uses, nowMs, segment)
    && (candidate.connection?.type !== 'covered_by'
      || (candidate.connection.matchState === 'matched' && candidate.connection.tracks.length > 0)));
}

/** Shared relevance, source, scope and novelty checks for long-form segments. */
export function eligibleSleeveNotesForSegmentInDatabase(db: Database.Database, localTrackId: string, artist: unknown, nowMs = Date.now(), manual = false): SleeveNoteSelectionCandidate[] {
  const candidates = loadExtendedSleeveNoteCandidatesInDatabase(db, localTrackId, artist);
  // Long-form discussion may develop new topics after a short artist link.
  // Exact facts, topics, relationships and reservations still retain their guards.
  const uses = recentUsesForCandidates(db, candidates, nowMs);
  // Operator runs may revisit aired stories, but cannot spend an active reservation.
  return eligibleCandidates(candidates, manual ? uses.filter(use=>!use.airedAt && !use.releasedAt) : uses, nowMs, true);
}

/** Count the same local candidate pool without choosing a winner or spending a turn. */
export function countExtendedSleeveNoteCandidatesInDatabase(db: Database.Database, localTrackId: string, artist: unknown, nowMs = Date.now()): { matchingCount: number; availableCount: number } {
  const candidates = loadExtendedSleeveNoteCandidatesInDatabase(db, localTrackId, artist);
  if (!candidates.length) return { matchingCount: 0, availableCount: 0 };
  const uses = recentUsesForCandidates(db, candidates, nowMs);
  return { matchingCount: candidates.length, availableCount: eligibleCandidates(candidates, uses, nowMs).length };
}

/** Prefer stories and connections; use credits when no stronger spark is eligible. */
export function selectMostSpecificEligibleClaim(
  candidates: readonly SleeveNoteSelectionCandidate[],
  uses: readonly SleeveNoteRecentUse[],
  nowMs = Date.now(),
): SleeveNoteSelectionCandidate | null {
  const localConnection = (candidate: SleeveNoteSelectionCandidate) =>
    candidate.connection?.matchState === 'matched' && candidate.connection.tracks.length > 0;
  const connectionPriority = (candidate: SleeveNoteSelectionCandidate) => ({
    samples: 0, cover_of: 1, sampled_in: 2, covered_by: 3, producer: 4, writer: 4,
  })[candidate.connection?.type ?? 'writer'] + (candidate.connection ? 0 : 99);
  const editorialPriority = (candidate: SleeveNoteSelectionCandidate) => localConnection(candidate) ? 0
    : candidate.provider === 'wikipedia' && (candidate.extractionRank ?? 0) > 0 ? 1
    : 2 + (CATEGORY_PRIORITY[candidate.category] ?? 99);
  const lastOffered = (candidate: SleeveNoteSelectionCandidate) => uses
    .filter((use) => use.claimId === candidate.claimId)
    .reduce((at, use) => Math.max(at, Date.parse(use.suppliedAt) || 0), 0);
  // Give other stories in the same specificity/editorial tier a turn after a
  // pass. Once every story has had a turn, retry the oldest pass. A released
  // generation that never aired and had no explicit pass does not spend a turn.
  const lastPassed = new Map<string, number>();
  for (const use of uses) {
    if (use.detectionStatus === 'detected' || (!use.airedAt && !use.contextPassReason)) continue;
    lastPassed.set(use.claimId, Math.max(lastPassed.get(use.claimId) ?? 0, Date.parse(use.suppliedAt) || 0));
  }
  return eligibleCandidates(candidates, uses, nowMs)
    .sort((a, b) => (ENTITY_PRIORITY[a.entityType] - ENTITY_PRIORITY[b.entityType])
      || editorialPriority(a) - editorialPriority(b)
      || (lastPassed.get(a.claimId) ?? 0) - (lastPassed.get(b.claimId) ?? 0)
      || (a.extractionRank ?? Number.MAX_SAFE_INTEGER) - (b.extractionRank ?? Number.MAX_SAFE_INTEGER)
      || (a.extractionSection ?? 1) - (b.extractionSection ?? 1)
      || ((CATEGORY_PRIORITY[a.category] ?? 99) - (CATEGORY_PRIORITY[b.category] ?? 99))
      || connectionPriority(a) - connectionPriority(b)
      || lastOffered(a) - lastOffered(b)
      || a.claimId.localeCompare(b.claimId))[0] ?? null;
}

function exactMusicBrainzArtistId(db: Database.Database, artistName: unknown): string | null {
  const name = typeof artistName === 'string' ? artistName.trim() : '';
  if (!name) return null;
  // Only a unique exact canonical-name match is safe before the recording has
  // resolved. Compound credits, aliases and duplicate artist names stay misses.
  const matches = db.prepare(`SELECT id FROM sleeve_artists
    WHERE musicbrainz_id IS NOT NULL AND trim(name) = ? COLLATE NOCASE
    LIMIT 2`).all(name) as Array<{ id: string }>;
  return matches.length === 1 ? matches[0].id : null;
}

export function loadExtendedSleeveNoteCandidatesInDatabase(
  db: Database.Database,
  localTrackId: string,
  currentArtist: unknown,
): SleeveNoteSelectionCandidate[] {
  const matches = db.prepare(`SELECT a.recording_id AS recordingId, r.artist_id AS artistId,
      (SELECT rr.release_id FROM sleeve_recording_releases rr
        WHERE rr.recording_id = r.id AND rr.is_canonical_home = 1 LIMIT 1) AS releaseId,
      (SELECT release.musicbrainz_release_group_id
        FROM sleeve_recording_releases rr
        JOIN sleeve_releases release ON release.id = rr.release_id
        WHERE rr.recording_id = r.id AND rr.is_canonical_home = 1 LIMIT 1) AS releaseGroupId
    FROM sleeve_local_attachments a
    JOIN sleeve_recordings r ON r.id = a.recording_id
    WHERE a.local_track_id = ? AND a.match_state = 'matched' AND r.match_state = 'matched'
    LIMIT 1`).get(localTrackId) as {
      recordingId: string; artistId: string | null; releaseId: string | null; releaseGroupId: string | null;
    } | undefined;
  const recordingId = matches?.recordingId ?? null;
  const releaseId = matches?.releaseId ?? null;
  const releaseGroupId = matches?.releaseGroupId ?? null;
  const artistId = matches?.artistId ?? exactMusicBrainzArtistId(db, currentArtist);
  const hasGeniusSeeds = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sleeve_genius_library_seeds'").get();
  const hasGeniusLocal = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sleeve_genius_local_tracks'").get();
  const rows = db.prepare(`SELECT c.id AS claimId, c.entity_type AS entityType,
      c.entity_id AS entityId, c.category, c.topic, c.wording,
      c.short_wording AS shortWording, c.evidence, c.operator_state AS operatorState,
      c.airtime_scope AS airtimeScope, c.matching_release_title AS matchingReleaseTitle,
      c.matching_track_title AS matchingTrackTitle,
      c.extraction_rank AS extractionRank, c.extraction_section AS extractionSection,
      s.provider, s.attribution, s.source_url AS sourceUrl, s.content AS sourceContent
    FROM sleeve_claims c
    JOIN sleeve_source_documents s ON s.id = c.source_document_id
    WHERE c.enabled = 1
      AND length(trim(c.wording)) > 0 AND length(trim(c.evidence)) > 0
      AND length(trim(s.source_url)) > 0
      AND (c.airtime_scope = 'general' OR (c.airtime_scope = 'matching-release-only'
        AND EXISTS (SELECT 1 FROM sleeve_local_attachments local
          WHERE local.local_track_id = ?
            AND lower(trim(local.release_title)) = lower(trim(c.matching_release_title))))
        OR (c.airtime_scope = 'matching-track-only' AND EXISTS (
          SELECT 1 FROM sleeve_local_attachments local
          WHERE local.local_track_id = ?
            AND lower(trim(local.title)) = lower(trim(c.matching_track_title)))))
      AND ((c.entity_type = 'recording' AND c.entity_id = ?)
        OR (${hasGeniusLocal ? `c.entity_type = 'recording' AND s.provider = 'genius' AND EXISTS (
          SELECT 1 FROM (SELECT local_track_id,recording_id FROM sleeve_genius_local_tracks
            ${hasGeniusSeeds ? 'UNION ALL SELECT local_track_id,recording_id FROM sleeve_genius_library_seeds' : ''}) genius_local
          WHERE genius_local.local_track_id = ? AND genius_local.recording_id = c.entity_id)` : '? IS NULL AND 0'})
        OR (? IS NOT NULL AND c.entity_type = 'release' AND c.entity_id = ?)
        OR (? IS NOT NULL AND c.entity_type = 'release-group' AND c.entity_id = ?
          AND s.provider <> 'musicbrainz-series')
        OR (? IS NOT NULL AND c.entity_type = 'artist' AND c.entity_id = ?)
        OR (? IS NULL AND EXISTS (
          SELECT 1 FROM sleeve_series_library_claims library_claim
          JOIN sleeve_musicbrainz_series_members member
            ON member.series_mbid = library_claim.series_mbid
            AND member.entity_mbid = library_claim.member_mbid
          WHERE library_claim.local_track_id = ? AND library_claim.claim_id = c.id
        )))
    ORDER BY c.updated_at DESC`)
    .all(localTrackId, localTrackId, recordingId, localTrackId, releaseId, releaseId, releaseGroupId, releaseGroupId, artistId, artistId,
      recordingId, localTrackId) as Array<{
      claimId: string; entityType: ExtendedSleeveNote['entityType']; entityId: string;
      category: string; topic: string; wording: string; shortWording: string; evidence: string;
      provider: string; attribution: string; sourceUrl: string; sourceContent: string;
      operatorState: string; extractionRank: number | null; extractionSection: number | null;
      airtimeScope: ExtendedSleeveNote['airtimeScope']; matchingReleaseTitle: string | null; matchingTrackTitle: string | null;
    }>;

  const connectionRecordingIds = new Set([
    ...(recordingId ? [recordingId] : []),
    ...rows.filter(row => row.provider === 'genius' && row.entityType === 'recording').map(row => row.entityId),
  ]);
  const connections = [...connectionRecordingIds].flatMap(id => libraryConnectionsInDatabase(db, id));
  const connectionsByClaim = new Map<string, LibraryConnection[]>();
  for (const connection of connections) {
    connectionsByClaim.set(connection.claimId, [...connectionsByClaim.get(connection.claimId) ?? [], connection]);
  }
  const byClaim = new Map<string, SleeveNoteSelectionCandidate>();
  const activeSeries = activeSeriesMap(db);
  for (const row of rows) {
    if (row.provider === 'musicbrainz-series' && !activeSeries.has(row.sourceUrl.split('/').at(-1) ?? '')) continue;
    if (!eligibleProvider(row.provider) || !(row.category in CATEGORY_PRIORITY)
      || (row.category === 'credits' && row.provider !== 'genius')) continue;
    let connection = connectionsByClaim.get(row.claimId)?.sort((a, b) =>
      Number(b.matchState === 'matched') - Number(a.matchState === 'matched') || a.id.localeCompare(b.id))[0];
    // New/legacy facts remain useful before the first reconciliation pass.
    // Their unresolved metadata also enforces the covered-by eligibility gate.
    if (!connection && row.provider === 'genius' && row.category === 'musical-connections') {
      try {
        const evidence = JSON.parse(row.evidence);
        if (['samples', 'sampled_in', 'cover_of', 'covered_by'].includes(evidence.type) && typeof evidence.target?.title === 'string' && evidence.target.title.trim()) {
          connection = { id: `${row.claimId}:recording`, claimId: row.claimId, sourceRecordingId: row.entityId,
            type: evidence.type, targetKind: 'recording', targetProviderId: String(evidence.target.providerId ?? ''),
            targetTitle: evidence.target.title, targetArtist: typeof evidence.target.artist === 'string' ? evidence.target.artist : null,
            targetUrl: evidence.target.canonicalUrl ?? null, matchState: 'unresolved', tracks: [] };
        }
      } catch { /* Malformed metadata cannot establish a library connection. */ }
    }
    if (row.provider === 'genius' && row.category === 'musical-connections' && !connection) continue;
    if (connection?.type === 'covered_by' && (connection.matchState !== 'matched' || !connection.tracks.length)) continue;
    let wording = row.wording;
    if (connection && row.operatorState === 'auto') {
      try {
        const identity = JSON.parse(row.sourceContent).identity;
        const source = identity?.title ? `${identity.title}${identity.artist ? ` by ${identity.artist}` : ''}` : '';
        const target = `${connection.targetTitle}${connection.targetArtist ? ` by ${connection.targetArtist}` : ''}`;
        if (source && connection.targetKind === 'recording') wording = {
          samples: `${source} samples ${target}.`, sampled_in: `${target} samples ${source}.`,
          cover_of: `${source} is a cover version of ${target}.`, covered_by: `${target} is a cover version of ${source}.`,
          writer: row.wording, producer: row.wording,
        }[connection.type];
      } catch { /* Keep the retained wording if the source identity is unavailable. */ }
      if (connection.targetKind === 'contributor' && connection.matchState === 'matched') {
        const peer = connection.tracks[0];
        if (peer) wording += ` ${peer.title} by ${peer.artist} also credits ${connection.targetTitle} as ${connection.type}.`;
      }
    }
    const candidate: SleeveNoteSelectionCandidate = {
      claimId: row.claimId,
      entityType: row.entityType,
      entityId: row.entityId,
      category: row.category,
      topic: row.topic,
      wording,
      fullWording: row.wording,
      extractionRank: row.extractionRank, extractionSection: row.extractionSection,
      ...(connection ? { connection } : {}),
      shortWording: row.shortWording.trim() || null,
      airtimeScope: row.airtimeScope, matchingReleaseTitle: row.matchingReleaseTitle, matchingTrackTitle: row.matchingTrackTitle,
      provider: row.provider,
      attribution: row.attribution,
      sourceUrl: row.sourceUrl,
      sourceContent: row.sourceContent,
      evidence: row.evidence,
      relationshipKey: relationshipKey(row.provider, row.sourceContent, row.evidence),
      localTrackId,
    };
    byClaim.set(candidate.claimId, candidate);
  }
  return [...byClaim.values()];
}

/** Synchronous local lookup with the reason a note is or is not available. */
export function inspectExtendedSleeveNote(
  current: { id?: unknown; artist?: unknown } | null | undefined,
  nowMs = Date.now(),
  requireShortWording = false,
): ExtendedSleeveNoteInspection {
  if (settings.get().djBehaviour.extendedSleeveNotes !== true) {
    return { status: 'disabled', note: null, candidateCount: 0 };
  }
  const localTrackId = String(current?.id ?? '').trim();
  if (!localTrackId) return { status: 'unavailable', note: null, candidateCount: 0 };
  const db = open();
  const candidates = loadExtendedSleeveNoteCandidatesInDatabase(db, localTrackId, current?.artist)
    .filter((candidate) => !requireShortWording || candidate.shortWording
      || candidate.provider !== 'genius' || candidate.entityType !== 'release-group');
  if (!candidates.length) return { status: 'unavailable', note: null, candidateCount: 0 };
  const latestUses = recentUsesForCandidates(db, candidates, nowMs);
  const selected = selectMostSpecificEligibleClaim(candidates, latestUses, nowMs);
  if (!selected) return { status: 'cooldown', note: null, candidateCount: candidates.length };
  const { sourceContent: _sourceContent, evidence: _evidence, ...publicNote } = selected;
  return { status: 'available', note: publicNote, candidateCount: candidates.length };
}

/** Synchronous local lookup; returns null when the feature is off or unmatched. */
export function selectExtendedSleeveNote(current: { id?: unknown; artist?: unknown } | null | undefined, nowMs = Date.now()): ExtendedSleeveNote | null {
  return inspectExtendedSleeveNote(current, nowMs).note;
}

/** Record the claim and rendered line supplied to the model for repetition control. */
export function recordExtendedSleeveNoteSupplied(
  note: ExtendedSleeveNote,
  finalText: string,
  consumer: 'generateLink' | 'sleeveNotesSegment' = 'generateLink',
): string {
  const id = randomUUID();
  const db = open();
  const attachment = db.prepare(`SELECT artist, title, release_title AS album FROM sleeve_local_attachments
    WHERE local_track_id = ?`).get(note.localTrackId) as {
      artist: string | null; title: string | null; album: string | null;
    } | undefined;
  const signal = detectClaimSignal(finalText, note.wording,
    [attachment?.artist, attachment?.title, attachment?.album]);
  const claim = db.prepare('SELECT wording FROM sleeve_claims WHERE id = ?').get(note.claimId) as { wording: string } | undefined;
  db.prepare(`INSERT INTO sleeve_claim_uses (
    id, claim_id, entity_type, entity_id, category, topic, relationship_key,
    local_track_id, consumer, supplied_at, final_text, offered_wording, detection_status, generated_signal,
    track_artist, track_title, claim_wording_at_offer
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, note.claimId, note.entityType, note.entityId, note.category, note.topic,
      note.relationshipKey, note.localTrackId, consumer, new Date().toISOString(), finalText,
      note.wording, signal.status, JSON.stringify(signal), attachment?.artist ?? null, attachment?.title ?? null,
      claim?.wording ?? note.fullWording);
  return id;
}

/** Record the normalized text handed to a speech engine for this selected spark. */
export function recordExtendedSleeveNoteTtsRequest(useId: string, text: string, engine: string | null = null): void {
  const db = open();
  const offered = db.prepare(`SELECT spark.offered_wording AS wording, spark.final_text AS finalText, spark.generated_signal AS generatedSignal,
      attachment.artist AS trackArtist, attachment.title AS trackTitle, attachment.release_title AS album
    FROM sleeve_claim_uses spark
    LEFT JOIN sleeve_local_attachments attachment ON attachment.local_track_id = spark.local_track_id
    WHERE spark.id = ?`).get(useId) as {
      wording: string; finalText:string; generatedSignal:string|null; trackArtist: string | null; trackTitle: string | null; album: string | null;
    } | undefined;
  if (!offered) return;
  let signal = detectClaimSignal(text, offered.wording,
    [offered.trackArtist, offered.trackTitle, offered.album]);
  // The model assessment applies only to the same words, never a later rewrite.
  // Display normalisation removes routing/markup differences without translating
  // or substituting facts. A changed contribution needs its own assessment.
  try {
    const assessed=JSON.parse(offered.generatedSignal??'null') as ClaimSignal|null;
    if(assessed?.method==='speech-review-v1' && assessed.status==='detected') {
      const spokenKey=(value:string)=>normalizeForDisplay(value).replace(/\[[^\]]*\]/gu,'').replace(/\s+/gu,' ').trim();
      const expected=normalizeForSpeech(offered.finalText,settings.get().tts?.corrections,assessed.language,engine??'');
      const sameWords=spokenKey(text)===spokenKey(offered.finalText)||spokenKey(text)===spokenKey(expected);
      const contradiction=claimDetailContradiction(text,offered.wording,[offered.trackArtist,offered.trackTitle,offered.album]);
      if(sameWords&&!contradiction?.includes('number or date'))signal=assessed;
    }
  } catch { /* An absent or malformed assessment falls back to the local check. */ }
  db.prepare(`UPDATE sleeve_claim_uses
    SET tts_text = ?, tts_requested_at = COALESCE(tts_requested_at, ?), detection_status = ?,
      speech_signal = ?, tts_engine = ?, tts_rendered_at = NULL
    WHERE id = ?`)
    .run(text, new Date().toISOString(), signal.status, JSON.stringify(signal), engine, useId);
}

/** Rendering succeeded; airing remains a separate live-edge confirmation. */
export function recordExtendedSleeveNoteTtsRendered(useId: string): void {
  open().prepare(`UPDATE sleeve_claim_uses SET tts_rendered_at = ?
    WHERE id = ? AND tts_requested_at IS NOT NULL`).run(new Date().toISOString(), useId);
}

/** Store an explicit DJ quality verdict until its link actually reaches air. */
export function markExtendedSleeveNoteQualityRejection(useId: string, reason: string): void {
  open().prepare(`UPDATE sleeve_claim_uses SET dj_quality_rejection_reason = ? WHERE id = ?`)
    .run(reason.trim().slice(0, 240), useId);
}

/** Record a moment-specific pass for diagnostics; it never counts as a quality rejection. */
export function markExtendedSleeveNoteContextPass(useId: string, reason: string): void {
  open().prepare(`UPDATE sleeve_claim_uses SET dj_context_pass_reason = ? WHERE id = ?`)
    .run(reason.trim().slice(0, 240), useId);
}

/** Mark the linked speech as aired only after Liquidsoap confirms its live edge. */
export function recordExtendedSleeveNoteAired(useId: string, airedAt: number): void {
  const db = open();
  db.prepare(`UPDATE sleeve_claim_uses
    SET aired_at = COALESCE(aired_at, ?), released_at = NULL
    WHERE id = ?`)
    .run(new Date(airedAt).toISOString(), useId);
  const rejection = db.prepare(`SELECT claim_id AS claimId,
    dj_quality_rejection_reason AS reason FROM sleeve_claim_uses WHERE id = ?`)
    .get(useId) as { claimId: string; reason: string | null } | undefined;
  if (rejection?.reason) recordLiveDjRejection(rejection.claimId, useId, rejection.reason);
}

/** Release a pending reservation while retaining its audit history. */
export function releaseExtendedSleeveNoteReservation(useId: string): void {
  open().prepare(`UPDATE sleeve_claim_uses
    SET released_at = COALESCE(released_at, ?)
    WHERE id = ? AND aired_at IS NULL`)
    .run(new Date().toISOString(), useId);
}
