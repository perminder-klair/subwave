import type Database from 'better-sqlite3';
import { queuePromotion } from './queue-actions.js';
import { pruneCompletedWikipediaArticlesInDatabase } from './wikipedia-retention.js';
import { nextAiringReview, runAiringReview } from './airing-review.js';
import { runResearchDatabaseWork } from './db.js';
import { createHash } from 'node:crypto';
import * as settings from '../settings.js';
import { researchAllowed } from '../broadcast/dj-budget.js';
import { activePickerAverageInputTokens } from '../llm/internal/telemetry/context-window.js';
import { recentCalls, ResearchDeferredError } from '../llm/log.js';
import { activeModelLabel } from '../llm/provider.js';
import { LlmResearcher } from './llm-researcher.js';
import { activeWikipediaExtractPrompt } from './wikipedia-prompt.js';
import type { ResearchCandidate, Researcher, ResearchOutcomeObserver, ValidatedResearch, WikipediaSparkExtraction } from './researcher.js';
import {
  MAX_CANDIDATES_PER_ARTIST_RESEARCH,
  RELEASE_GROUP_NOTE_CATEGORIES,
  wikipediaNoteCategories,
  screenResearchCandidates,
  usefulRepairCandidate,
  splitResearchSource,
} from './researcher.js';
import * as repository from './research-repository.js';
import { expireRecycleBin, retainRejectedCandidates } from './moderation.js';
import { open } from './db.js';
import { applyAirtimeDecision } from './airtime-review.js';
import {
  MAX_WIKIPEDIA_CHUNK_CEILING_CHARACTERS, MIN_WIKIPEDIA_CHUNK_CHARACTERS,
  allocateWikipediaClaims, planWikipediaChunks, wikipediaCandidatesFromSparks,
} from './wikipedia-extract.js';
import type { QuietGate } from './musicbrainz-worker.js';

const RESEARCH_PAIR_INTERVAL_MS = 2 * 60_000;
const EMPTY_STATION_RESEARCH_PAIR_INTERVAL_MS = 60_000;
const EMPTY_STATION_FAST_RESEARCH_PAIR_INTERVAL_MS = 30_000;
const EMPTY_STATION_FAST_INTERVAL_BELOW_MS = 15_000;
const EMPTY_STATION_SLOW_INTERVAL_ABOVE_MS = 20_000;
const EMPTY_STATION_INTERVAL_SAMPLE_COUNT = 16;
const MAX_RETAINED_CLAIMS_PER_ARTICLE = MAX_CANDIDATES_PER_ARTIST_RESEARCH;
const MAX_RECYCLE_CANDIDATES_PER_ARTICLE = 2;
const FIRST_ENCOUNTER_CHECK_HEADROOM_MS = 35_000;
const FIRST_ENCOUNTER_TWO_CHECKS_MS = 15_000;
const ARTICLE_INDEX_TIMEOUT_MS = 75_000;
const WIKIPEDIA_CHUNK_TIMEOUT_MS = 45_000;
const WIKIPEDIA_CHUNK_AVERAGE_TARGET_MS = 30_000;
const WIKIPEDIA_CALIBRATION_SAMPLE_COUNT = 16;
const MIN_WIKIPEDIA_CALIBRATION_SAMPLES = 6;
const MIN_WIKIPEDIA_TOKEN_CALIBRATION_SAMPLES = 5;
const WIKIPEDIA_RECENCY_DECAY = 0.8;
const WIKIPEDIA_MIN_SAMPLE_UTILIZATION = 0.75;
// Bump when extraction output changes so an in-flight refresh cannot mix old
// unscoped chunk results with newly classified claims.
const WIKIPEDIA_CLAIM_SCOPE_FORMAT_VERSION = 1;
// Fallback until picker-context and token/character samples are available.
const INITIAL_WIKIPEDIA_CHUNK_CHARACTERS = 10_000;

type RejectedCandidate = ValidatedResearch['rejected'][number];
type ResearchProgress = {
  playsConsumed: number;
  nextSection: number;
  candidateSections: ResearchCandidate[][];
  rankedClaimIds: string[] | null;
  checkCursor: number;
  acceptedSections: ResearchCandidate[][];
  rejected: RejectedCandidate[];
  pendingCandidates: ResearchCandidate[] | null;
};

function researchProgress(jobId: string, sourceDocumentId: string): ResearchProgress {
  const db = open();
  const row = db.prepare(`SELECT source_document_id AS sourceDocumentId,
      plays_consumed AS playsConsumed,
      next_section AS nextSection, accepted_sections_json AS acceptedSectionsJson,
      candidate_sections_json AS candidateSectionsJson, check_cursor AS checkCursor,
      ranked_claim_ids_json AS rankedClaimIdsJson,
      rejected_json AS rejectedJson, pending_candidates_json AS pendingCandidatesJson
    FROM sleeve_research_progress WHERE job_id = ?`).get(jobId) as {
      sourceDocumentId: string; playsConsumed: number; nextSection: number; acceptedSectionsJson: string;
      candidateSectionsJson: string; rankedClaimIdsJson: string | null; checkCursor: number;
      rejectedJson: string; pendingCandidatesJson: string | null;
    } | undefined;
  if (row && row.sourceDocumentId !== sourceDocumentId) {
    db.prepare('DELETE FROM sleeve_research_progress WHERE job_id = ?').run(jobId);
  }
  if (!row || row.sourceDocumentId !== sourceDocumentId) {
    return { playsConsumed: 0, nextSection: 0, candidateSections: [], rankedClaimIds: null, checkCursor: 0,
      acceptedSections: [], rejected: [], pendingCandidates: null };
  }
  return {
    playsConsumed: row.playsConsumed,
    nextSection: row.nextSection,
    candidateSections: JSON.parse(row.candidateSectionsJson) as ResearchCandidate[][],
    rankedClaimIds: row.rankedClaimIdsJson ? JSON.parse(row.rankedClaimIdsJson) as string[] : null,
    checkCursor: row.checkCursor,
    acceptedSections: JSON.parse(row.acceptedSectionsJson) as ResearchCandidate[][],
    rejected: JSON.parse(row.rejectedJson) as RejectedCandidate[],
    pendingCandidates: row.pendingCandidatesJson
      ? JSON.parse(row.pendingCandidatesJson) as ResearchCandidate[] : null,
  };
}

/** Keep the durable slot and deferred jobs aligned when listener mode changes. */
function alignResearchPacing(intervalMs: number): void {
  const db = open();
  db.transaction(() => {
    const pacing = db.prepare(`SELECT next_pair_at AS nextPairAt, last_pair_at AS lastPairAt,
        pair_interval_ms AS pairIntervalMs FROM sleeve_research_pacing WHERE id = 1`)
      .get() as { nextPairAt: string; lastPairAt: string | null; pairIntervalMs: number } | undefined;
    if (!pacing) return;
    const priorStart = pacing.lastPairAt
      ? Date.parse(pacing.lastPairAt)
      : Date.parse(pacing.nextPairAt) - pacing.pairIntervalMs;
    if (!Number.isFinite(priorStart) || pacing.pairIntervalMs === intervalMs) return;
    const nextPairAt = new Date(priorStart + intervalMs).toISOString();
    const now = new Date().toISOString();
    db.prepare(`UPDATE sleeve_research_pacing SET next_pair_at = ?, last_pair_at = ?, pair_interval_ms = ?
      WHERE id = 1`).run(nextPairAt, new Date(priorStart).toISOString(), intervalMs);
    // Researcher retry times are pacing slots too. Move them with the shared
    // durable gate when the station changes between listener and idle modes.
    db.prepare(`UPDATE sleeve_research_jobs SET run_after = ?, updated_at = ?
      WHERE provider = 'researcher' AND state = 'retry-at' AND run_after IS NOT NULL`)
      .run(nextPairAt, now);
  }).immediate();
}

/** One durable start slot for all research jobs, including after a restart. */
function reserveResearchPair(intervalMs = RESEARCH_PAIR_INTERVAL_MS): string | null {
  const db = open();
  return db.transaction(() => {
    const now = new Date();
    const next = db.prepare(`SELECT next_pair_at AS nextPairAt FROM sleeve_research_pacing WHERE id = 1`)
      .get() as { nextPairAt: string } | undefined;
    if (next && Date.parse(next.nextPairAt) > now.getTime()) return null;
    const nextPairAt = new Date(now.getTime() + intervalMs).toISOString();
    db.prepare(`INSERT INTO sleeve_research_pacing (id, next_pair_at, last_pair_at, pair_interval_ms)
      VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET next_pair_at = excluded.next_pair_at,
      last_pair_at = excluded.last_pair_at, pair_interval_ms = excluded.pair_interval_ms`)
      .run(nextPairAt, now.toISOString(), intervalMs);
    return nextPairAt;
  }).immediate();
}

function deferResearchSection(jobId: string, sourceDocumentId: string,
  progress: ResearchProgress, nextPairAt: string): void {
  const db = open();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO sleeve_research_progress (job_id, source_document_id,
      plays_consumed, next_section, accepted_sections_json, candidate_sections_json, check_cursor,
      ranked_claim_ids_json, rejected_json, pending_candidates_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        source_document_id = excluded.source_document_id,
        plays_consumed = excluded.plays_consumed,
        next_section = excluded.next_section,
        accepted_sections_json = excluded.accepted_sections_json,
        candidate_sections_json = excluded.candidate_sections_json,
        check_cursor = excluded.check_cursor,
        ranked_claim_ids_json = excluded.ranked_claim_ids_json,
        rejected_json = excluded.rejected_json,
        pending_candidates_json = excluded.pending_candidates_json,
        updated_at = excluded.updated_at`).run(jobId, sourceDocumentId,
      progress.playsConsumed, progress.nextSection, JSON.stringify(progress.acceptedSections),
      JSON.stringify(progress.candidateSections), progress.checkCursor,
      progress.rankedClaimIds === null ? null : JSON.stringify(progress.rankedClaimIds),
      JSON.stringify(progress.rejected), progress.pendingCandidates === null
        ? null : JSON.stringify(progress.pendingCandidates), now);
    db.prepare(`UPDATE sleeve_research_jobs SET state = 'retry-at', run_after = ?, updated_at = ?
      WHERE id = ?`).run(nextPairAt, now, jobId);
  }).immediate();
}

function playedEncounterCount(job: repository.PendingResearchJob, since?: string, db: Database.Database = open()): number {
  const condition = job.subjectType === 'artist'
    ? 'recording.artist_id = ?'
    : 'release.musicbrainz_release_group_id = ?';
  const releaseJoin = job.subjectType === 'artist' ? '' : `
    JOIN sleeve_recording_releases appearance ON appearance.recording_id = recording.id
    JOIN sleeve_releases release ON release.id = appearance.release_id`;
  const row = db.prepare(`SELECT COUNT(DISTINCT encounter.id) AS count
    FROM sleeve_encounters encounter
    JOIN sleeve_local_attachments local ON local.local_track_id = encounter.local_track_id
    JOIN sleeve_recordings recording ON recording.id = local.recording_id${releaseJoin}
    WHERE encounter.source = 'played' AND ${condition}
      ${since ? 'AND encounter.encountered_at > ?' : ''}`)
    .get(...(since ? [job.subjectId, since] : [job.subjectId])) as { count: number };
  return row.count;
}

export type WikipediaRefreshMode = 'clear' | 'replace';

/** Identify the prompt/model profile used for a Wikipedia chunk calibration. */
export function wikipediaCalibrationProfileHash(promptOverride?: string): string {
  const current = settings.get();
  return createHash('sha256').update(JSON.stringify({
    prompt: activeWikipediaExtractPrompt(
      promptOverride ?? current.sleeveNotes.wikipedia.extractPrompt,
    ),
    llm: {
      provider: current.llm.provider,
      model: current.llm.model,
      baseUrl: current.llm.baseUrl,
      ollamaUrl: current.llm.ollamaUrl,
      fallbackProvider: current.llm.fallback?.provider,
      fallbackModel: current.llm.fallback?.model,
      fallbackBaseUrl: current.llm.fallback?.baseUrl,
      fallbackOllamaUrl: current.llm.fallback?.ollamaUrl,
    },
  })).digest('hex');
}

/**
 * Speed up idle research once recent Wikipedia calls are consistently quick.
 * Keep a separate durable idle interval so listener-active pacing changes do
 * not erase the hysteresis state between the 15s and 20s thresholds.
 */
function emptyStationResearchPairIntervalMs(): number {
  const db = open();
  const profileHash = wikipediaCalibrationProfileHash();
  const attempts = db.prepare(`SELECT elapsed_ms AS elapsedMs
    FROM sleeve_wikipedia_chunk_attempts
    WHERE profile_hash = ? AND outcome IN ('success', 'deadline', 'error') AND elapsed_ms > 0
    ORDER BY created_at DESC LIMIT ?`)
    .all(profileHash, EMPTY_STATION_INTERVAL_SAMPLE_COUNT) as Array<{ elapsedMs: number }>;
  const pacing = db.prepare(`SELECT empty_station_interval_ms AS intervalMs
    FROM sleeve_research_pacing WHERE id = 1`)
    .get() as { intervalMs: number } | undefined;

  let intervalMs = EMPTY_STATION_RESEARCH_PAIR_INTERVAL_MS;
  if (attempts.length >= MIN_WIKIPEDIA_CALIBRATION_SAMPLES) {
    const averageMs = attempts.reduce((total, attempt) => total + attempt.elapsedMs, 0) / attempts.length;
    if (averageMs <= EMPTY_STATION_FAST_INTERVAL_BELOW_MS) {
      intervalMs = EMPTY_STATION_FAST_RESEARCH_PAIR_INTERVAL_MS;
    } else if (averageMs > EMPTY_STATION_SLOW_INTERVAL_ABOVE_MS) {
      intervalMs = EMPTY_STATION_RESEARCH_PAIR_INTERVAL_MS;
    } else if (pacing?.intervalMs === EMPTY_STATION_FAST_RESEARCH_PAIR_INTERVAL_MS) {
      // Hysteresis band: retain the previous idle cadence between 15s and 20s.
      intervalMs = EMPTY_STATION_FAST_RESEARCH_PAIR_INTERVAL_MS;
    }
  }

  if (pacing && pacing.intervalMs !== intervalMs) {
    db.prepare(`UPDATE sleeve_research_pacing SET empty_station_interval_ms = ? WHERE id = 1`)
      .run(intervalMs);
  }
  return intervalMs;
}

function wikipediaScanHash(profileHash: string, claimLimit: number): string {
  return createHash('sha256').update(`${profileHash}:${claimLimit}:scope-format-${WIKIPEDIA_CLAIM_SCOPE_FORMAT_VERSION}`).digest('hex');
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function weightedMean(values: Array<{ value: number; weight: number }>): number {
  const usable = values.filter(({ value, weight }) => Number.isFinite(value) && value > 0
    && Number.isFinite(weight) && weight > 0);
  if (!usable.length) return 0;
  const totalWeight = usable.reduce((total, item) => total + item.weight, 0);
  return usable.reduce((total, item) => total + item.value * item.weight, 0) / totalWeight;
}

export function adaptiveWikipediaChunkCharacters(
  profileHash = wikipediaCalibrationProfileHash(), subjectType: 'artist' | 'release' = 'artist',
): number {
  const rows = open().prepare(`SELECT input_characters AS inputCharacters, elapsed_ms AS elapsedMs,
      input_tokens AS inputTokens,
      target_characters AS targetCharacters, outcome
    FROM sleeve_wikipedia_chunk_attempts attempt
    JOIN sleeve_research_jobs job ON job.id = attempt.job_id
    WHERE attempt.outcome IN ('success', 'deadline')
      AND attempt.input_characters > 0 AND attempt.profile_hash = ? AND job.subject_type = ?
      AND attempt.target_characters IS NOT NULL
    ORDER BY attempt.created_at DESC LIMIT ?`)
    .all(profileHash, subjectType, WIKIPEDIA_CALIBRATION_SAMPLE_COUNT) as Array<{
      inputCharacters: number; elapsedMs: number; inputTokens: number | null;
      targetCharacters: number | null; outcome: 'success' | 'deadline';
    }>;
  const bounded = (target: number) => Math.max(MIN_WIKIPEDIA_CHUNK_CHARACTERS,
    Math.min(MAX_WIKIPEDIA_CHUNK_CEILING_CHARACTERS, Math.round(target)));

  // Keep the last applied size during warm-up. Old attempts have no target size
  // and are intentionally ignored, giving this controller a clean sample set
  // without invalidating in-progress article scans.
  const latestTarget = rows.find((row) => typeof row.targetCharacters === 'number'
    && Number.isFinite(row.targetCharacters) && row.targetCharacters > 0)?.targetCharacters;
  const currentTarget = bounded(latestTarget ?? INITIAL_WIKIPEDIA_CHUNK_CHARACTERS);

  // Fit measured prompt tokens to source characters. The fixed prompt portion
  // stays separate so the latency budget can be translated to a source size
  // without treating the custom instructions as expandable article text.
  const tokenRows = rows.filter((row): row is typeof row & { inputTokens: number } =>
    row.outcome === 'success' && typeof row.inputTokens === 'number'
      && Number.isFinite(row.inputTokens) && row.inputTokens > 0);
  let tokensPerCharacter = 0;
  let fixedPromptTokens = 0;
  if (tokenRows.length >= MIN_WIKIPEDIA_TOKEN_CALIBRATION_SAMPLES) {
    const tokenSlopes: number[] = [];
    for (let left = 0; left < tokenRows.length; left++) {
      for (let right = left + 1; right < tokenRows.length; right++) {
        const characterDelta = tokenRows[left].inputCharacters - tokenRows[right].inputCharacters;
        if (characterDelta !== 0) {
          tokenSlopes.push((tokenRows[left].inputTokens - tokenRows[right].inputTokens) / characterDelta);
        }
      }
    }
    tokensPerCharacter = median(tokenSlopes);
    if (Number.isFinite(tokensPerCharacter) && tokensPerCharacter > 0) {
      fixedPromptTokens = Math.max(0, median(tokenRows.map((row) =>
        row.inputTokens - tokensPerCharacter * row.inputCharacters)));
    } else {
      tokensPerCharacter = 0;
    }
  }

  // Aim at the selected track picker's measured average prompt context. Once
  // enough full chunks have been measured, scale that target down only when
  // recent Wiki latency exceeds the 30s budget. Recent samples count more.
  const usefulSuccesses = rows.filter((row) => row.outcome === 'success'
    && typeof row.targetCharacters === 'number' && row.targetCharacters > 0
    && row.inputCharacters >= row.targetCharacters * WIKIPEDIA_MIN_SAMPLE_UTILIZATION
    && row.elapsedMs > 0);
  const usefulLatencySamples = rows.filter((row) =>
    typeof row.targetCharacters === 'number' && row.targetCharacters > 0
      && row.inputCharacters >= row.targetCharacters * WIKIPEDIA_MIN_SAMPLE_UTILIZATION
      && row.elapsedMs > 0);
  let latencyScale = 1;
  if (usefulSuccesses.length >= MIN_WIKIPEDIA_CALIBRATION_SAMPLES) {
    const meanLatencyMs = weightedMean(usefulLatencySamples.map((row, index) => ({
      value: row.elapsedMs,
      weight: WIKIPEDIA_RECENCY_DECAY ** index,
    })));
    if (meanLatencyMs > WIKIPEDIA_CHUNK_AVERAGE_TARGET_MS) {
      latencyScale = WIKIPEDIA_CHUNK_AVERAGE_TARGET_MS / meanLatencyMs;
    }
  }

  // The picker average is the target context, not merely a ceiling with spare
  // headroom. A 45s deadline is included as a 45s latency sample above.
  const trackSelection = settings.get().llm?.trackSelection === 'shortlist' ? 'shortlist' : 'agentic';
  const currentModel = activeModelLabel();
  const currentModelCalls = recentCalls.filter((call) => call?.model === currentModel);
  const pickerInputTokens = activePickerAverageInputTokens(currentModelCalls, trackSelection);
  if (pickerInputTokens == null || tokensPerCharacter <= 0) return bounded(currentTarget * latencyScale);
  const targetPromptTokens = pickerInputTokens * latencyScale;
  const contextTargetCharacters = (targetPromptTokens - fixedPromptTokens) / tokensPerCharacter;
  return bounded(contextTargetCharacters);
}

/** Keep refresh intent out of the research queue until an entity is encountered. */
export function requestWikipediaRefresh(mode: WikipediaRefreshMode): {
  artists: number; albums: number; claimsCleared: number;
} {
  const db = open();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const sources = db.prepare(`SELECT DISTINCT entity_type AS entityType, entity_id AS entityId
      FROM sleeve_source_documents WHERE provider = 'wikipedia'
        AND entity_type IN ('artist', 'release-group')`).all() as Array<{
          entityType: 'artist' | 'release-group'; entityId: string;
        }>;
    if (mode === 'replace') {
      // Remove any older eager rescan markers, then keep one small plan row.
      // Jobs are materialized per artist/album only when a post-request play
      // encounter is admitted.
      db.prepare(`UPDATE sleeve_research_jobs
        SET state = 'complete', run_after = NULL, wikipedia_refresh_mode = NULL, updated_at = ?
        WHERE sleeve_research_jobs.provider = 'researcher' AND sleeve_research_jobs.capability IN (
            'extract-wikipedia', 'extract-wikipedia-release-group')
          AND sleeve_research_jobs.state IN ('queued', 'retry-at', 'failed')
          AND (sleeve_research_jobs.wikipedia_refresh_mode IS NOT NULL
            OR EXISTS (SELECT 1 FROM sleeve_wikipedia_rescan_requests request
              WHERE request.job_id = sleeve_research_jobs.id))
          AND EXISTS (SELECT 1 FROM sleeve_source_documents source
            WHERE source.provider = 'wikipedia'
              AND source.entity_type = CASE sleeve_research_jobs.subject_type
                WHEN 'artist' THEN 'artist' ELSE 'release-group' END
              AND source.entity_id = sleeve_research_jobs.subject_id)`)
        .run(now);
      db.prepare(`DELETE FROM sleeve_wikipedia_rescan_requests WHERE job_id IN (
        SELECT job.id FROM sleeve_research_jobs job
        WHERE job.provider = 'researcher' AND job.capability IN (
          'extract-wikipedia', 'extract-wikipedia-release-group')
          AND EXISTS (SELECT 1 FROM sleeve_source_documents source
            WHERE source.provider = 'wikipedia'
              AND source.entity_type = CASE job.subject_type WHEN 'artist' THEN 'artist' ELSE 'release-group' END
              AND source.entity_id = job.subject_id)
      )`).run();
      db.prepare(`INSERT INTO sleeve_wikipedia_refresh_plan (id, requested_at) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET requested_at = excluded.requested_at`).run(now);
      return {
        artists: sources.filter((source) => source.entityType === 'artist').length,
        albums: sources.filter((source) => source.entityType === 'release-group').length,
        claimsCleared: 0,
      };
    }

    db.prepare('DELETE FROM sleeve_wikipedia_refresh_plan WHERE id = 1').run();
    db.prepare(`INSERT OR IGNORE INTO sleeve_research_jobs (
      id, provider, subject_type, subject_id, capability, state, priority,
      attempts, run_after, created_at, updated_at
    ) SELECT lower(hex(randomblob(16))), 'researcher',
      CASE s.entity_type WHEN 'artist' THEN 'artist' ELSE 'release' END,
      s.entity_id,
      CASE s.entity_type WHEN 'artist' THEN 'extract-wikipedia' ELSE 'extract-wikipedia-release-group' END,
      'queued', 300, 0, NULL, ?, ?
      FROM sleeve_source_documents s WHERE s.provider = 'wikipedia'
        AND s.entity_type IN ('artist', 'release-group')`).run(now, now);
    const jobFor = db.prepare(`SELECT id, provider, subject_type AS subjectType, subject_id AS subjectId,
        capability, priority, attempts, origin_local_track_id AS originLocalTrackId
      FROM sleeve_research_jobs WHERE provider = 'researcher' AND subject_id = ? AND capability = ?`);
    const request = db.prepare(`INSERT INTO sleeve_wikipedia_rescan_requests
      (job_id, encounter_count_at_request, requested_at, refresh_mode) VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET encounter_count_at_request = excluded.encounter_count_at_request,
        requested_at = excluded.requested_at, refresh_mode = excluded.refresh_mode`);
    let claimsCleared = 0;
    const disable = db.prepare(`UPDATE sleeve_claims SET enabled = 0, updated_at = ?
      WHERE entity_type = ? AND entity_id = ? AND operator_state = 'auto'
        AND source_document_id IN (SELECT id FROM sleeve_source_documents WHERE provider = 'wikipedia')`);
    for (const source of sources) {
      const capability = source.entityType === 'artist' ? 'extract-wikipedia' : 'extract-wikipedia-release-group';
      const job = jobFor.get(source.entityId, capability) as repository.PendingResearchJob | undefined;
      if (!job) continue;
      if (mode === 'clear') claimsCleared += disable.run(now, source.entityType, source.entityId).changes;
      request.run(job.id, playedEncounterCount(job), now, mode);
    }
    return {
      artists: sources.filter((source) => source.entityType === 'artist').length,
      albums: sources.filter((source) => source.entityType === 'release-group').length,
      claimsCleared,
    };
  }).immediate();
}

export type ResearchQueuePhase = 'ready' | 'first-play' | 'next-play'
  | 'time-delay' | 'running' | 'unavailable';

/** Individual queue rows for the admin Overview, using the same phase rules. */
export function researchQueueDetails(now = new Date(), allowIdleRescans = false, db: Database.Database = open()): Array<{
  id: string; provider: string; capability: string; phase: ResearchQueuePhase;
  subjectType: string; subjectTitle: string; subjectArtist: string | null;
  priority: number; attempts: number; runAfter: string | null;
  wikiNextChunk: number; researchNextSection: number;
}> {
  const jobs = db.prepare(`SELECT job.id, job.provider, job.subject_type AS subjectType,
      job.subject_id AS subjectId, job.capability, job.priority, job.attempts,
      job.origin_local_track_id AS originLocalTrackId,
      job.run_after AS runAfter, job.state, job.operator_requested AS operatorRequested,
      job.wikipedia_refresh_mode AS wikipediaRefreshMode,
      COALESCE(wiki.next_chunk, 0) AS wikiNextChunk,
      COALESCE(progress.next_section, 0) AS researchNextSection,
      COALESCE(progress.plays_consumed, 0) AS playsConsumed,
      rescan.encounter_count_at_request AS rescanAfterEncounters,
      CASE job.subject_type
        WHEN 'artist' THEN COALESCE((SELECT name FROM sleeve_artists WHERE id = job.subject_id), job.subject_id)
        WHEN 'recording' THEN COALESCE((SELECT title FROM sleeve_recordings WHERE id = job.subject_id), job.subject_id)
        WHEN 'local-track' THEN COALESCE((SELECT title FROM sleeve_local_attachments WHERE local_track_id = job.subject_id), job.subject_id)
        WHEN 'release' THEN COALESCE((SELECT title FROM sleeve_releases
          WHERE id = job.subject_id OR musicbrainz_release_group_id = job.subject_id LIMIT 1), job.subject_id)
        ELSE job.subject_id END AS subjectTitle,
      CASE job.subject_type
        WHEN 'recording' THEN (SELECT artist.name FROM sleeve_recordings recording
          LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id WHERE recording.id = job.subject_id)
        WHEN 'local-track' THEN (SELECT artist FROM sleeve_local_attachments WHERE local_track_id = job.subject_id)
        WHEN 'release' THEN (SELECT artist.name FROM sleeve_recording_releases link
          JOIN sleeve_releases release ON release.id = link.release_id
          JOIN sleeve_recordings recording ON recording.id = link.recording_id
          LEFT JOIN sleeve_artists artist ON artist.id = recording.artist_id
          WHERE release.id = job.subject_id OR release.musicbrainz_release_group_id = job.subject_id LIMIT 1)
        ELSE NULL END AS subjectArtist
    FROM sleeve_research_jobs job
    LEFT JOIN sleeve_wikipedia_scan_progress wiki ON wiki.job_id = job.id
    LEFT JOIN sleeve_research_progress progress ON progress.job_id = job.id
    LEFT JOIN sleeve_wikipedia_rescan_requests rescan ON rescan.job_id = job.id
    WHERE job.state IN ('queued', 'retry-at', 'running', 'failed') OR rescan.job_id IS NOT NULL`)
    .all() as Array<repository.PendingResearchJob & {
      subjectTitle: string; subjectArtist: string | null; state: string;
      operatorRequested: number; runAfter: string | null; wikiNextChunk: number; researchNextSection: number; playsConsumed: number;
      rescanAfterEncounters: number | null; wikipediaRefreshMode: WikipediaRefreshMode | null;
    }>;
  return jobs.map((job) => {
    let phase: ResearchQueuePhase;
    if (job.state === 'running') phase = 'running';
    else if (job.state === 'failed') phase = 'unavailable';
    else if (job.rescanAfterEncounters != null) {
      phase = playedEncounterCount(job, undefined, db) > job.rescanAfterEncounters || allowIdleRescans || job.operatorRequested ? 'ready' : 'next-play';
    } else if (job.provider === 'researcher' && ['extract-wikipedia', 'extract-wikipedia-release-group',
      'extract-genius-album'].includes(job.capability)) {
      const firstAlbumWiki = (job.capability === 'extract-wikipedia'
        || job.capability === 'extract-wikipedia-release-group') && job.subjectType === 'release'
        && job.wikiNextChunk === 0 && !job.wikipediaRefreshMode && playedEncounterCount(job, undefined, db) < 1;
      const firstGeniusAlbum = job.capability === 'extract-genius-album'
        && job.playsConsumed === 0 && playedEncounterCount(job, undefined, db) < 1;
      phase = (firstAlbumWiki || firstGeniusAlbum) && !job.operatorRequested ? 'first-play'
        : job.runAfter && Date.parse(job.runAfter) > now.getTime() ? 'time-delay' : 'ready';
    } else {
      phase = job.runAfter && Date.parse(job.runAfter) > now.getTime() ? 'time-delay' : 'ready';
    }
    return {
      id: job.id, provider: job.provider, capability: job.capability, phase,
      subjectType: job.subjectType, subjectTitle: job.subjectTitle,
      subjectArtist: job.subjectArtist, priority: job.priority,
      attempts: job.attempts, runAfter: job.runAfter, wikiNextChunk: job.wikiNextChunk,
      researchNextSection: job.researchNextSection,
    };
  }).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

function nextPlayDrivenResearchJob(allowIdleRescans: boolean): repository.PendingResearchJob | null {
  const jobs = open().prepare(`SELECT id, provider, subject_type AS subjectType,
      subject_id AS subjectId, capability, priority, attempts,
      origin_local_track_id AS originLocalTrackId,
      job.wikipedia_refresh_mode AS wikipediaRefreshMode,
      job.operator_requested AS operatorRequested,
      rescan.encounter_count_at_request AS rescanAfterEncounters,
      rescan.refresh_mode AS refreshMode
    FROM sleeve_research_jobs job
    LEFT JOIN sleeve_wikipedia_rescan_requests rescan ON rescan.job_id = job.id
    LEFT JOIN sleeve_wikipedia_scan_progress wiki ON wiki.job_id = job.id
    LEFT JOIN sleeve_research_progress progress ON progress.job_id = job.id
    WHERE provider = 'researcher' AND capability IN (
      'extract-wikipedia', 'extract-wikipedia-release-group', 'extract-genius-album')
      AND (state IN ('queued', 'retry-at') OR rescan.job_id IS NOT NULL)
      AND (rescan.job_id IS NOT NULL OR run_after IS NULL OR run_after <= ?)
    ORDER BY (SELECT requested_at FROM sleeve_queue_promotions WHERE job_id=job.id) DESC, CASE WHEN rescan.job_id IS NOT NULL THEN 0
      WHEN job.capability IN ('extract-wikipedia', 'extract-wikipedia-release-group')
        THEN COALESCE(wiki.next_chunk, 0)
      ELSE COALESCE(progress.next_section, 0) END ASC,
      CASE WHEN job.subject_type = 'release' THEN 0 ELSE 1 END ASC,
      COALESCE(wiki.updated_at, progress.updated_at, job.created_at) ASC,
      job.priority DESC, job.created_at ASC`)
    .all(new Date().toISOString()) as Array<repository.PendingResearchJob & {
      operatorRequested: number;
      rescanAfterEncounters: number | null; refreshMode: WikipediaRefreshMode | null;
      wikipediaRefreshMode: WikipediaRefreshMode | null;
    }>;
  for (const job of jobs) {
    const wikiJob = job.capability === 'extract-wikipedia'
      || job.capability === 'extract-wikipedia-release-group';
    if (wikiJob) {
      if (job.rescanAfterEncounters != null) {
        const newEncounter = playedEncounterCount(job) > job.rescanAfterEncounters;
        if (!newEncounter && !allowIdleRescans && !job.operatorRequested) continue;
        const db = open();
        const now = new Date().toISOString();
        db.transaction(() => {
          db.prepare(`INSERT INTO sleeve_wikipedia_scan_history
            (job_id, source_document_id, chunk_index, section_path, input_hash, raw_response,
              items_json, elapsed_ms, parsed_count, retained_count, created_at, archived_at)
            SELECT job_id, source_document_id, chunk_index, section_path, input_hash, raw_response,
              items_json, elapsed_ms, parsed_count, retained_count, created_at, ?
            FROM sleeve_wikipedia_scan_chunks WHERE job_id = ?`).run(now, job.id);
          db.prepare('DELETE FROM sleeve_wikipedia_scan_chunks WHERE job_id = ?').run(job.id);
          db.prepare('DELETE FROM sleeve_wikipedia_scan_progress WHERE job_id = ?').run(job.id);
          db.prepare(`UPDATE sleeve_research_jobs SET wikipedia_refresh_mode = ?, state = 'queued', run_after = NULL,
            completed_at = NULL, updated_at = ? WHERE id = ?`).run(job.refreshMode ?? 'replace', now, job.id);
          db.prepare('DELETE FROM sleeve_wikipedia_rescan_requests WHERE job_id = ?').run(job.id);
        }).immediate();
      }
      const scan = open().prepare(`SELECT next_chunk AS nextChunk FROM sleeve_wikipedia_scan_progress
        WHERE job_id = ?`).get(job.id) as { nextChunk: number } | undefined;
      // Keep explicit intent until completion so a failed first chunk or a
      // smaller-chunk restart can retry without requiring a playback encounter.
      // One encounter unlocks automatic scans; later chunks resume quietly.
      if (job.subjectType === 'release' && !scan?.nextChunk
        && playedEncounterCount(job) < 1
        && !job.operatorRequested
        && !job.wikipediaRefreshMode
        && !(job.rescanAfterEncounters != null && allowIdleRescans)) continue;
      return job;
    }
    const consumed = (open().prepare(`SELECT plays_consumed AS playsConsumed
      FROM sleeve_research_progress WHERE job_id = ?`).get(job.id) as { playsConsumed: number } | undefined)?.playsConsumed ?? 0;
    // A first album encounter unlocks every section; later chunks never wait
    // for the album or artist to be played again.
    if (consumed === 0 && playedEncounterCount(job) < 1 && !job.operatorRequested) continue;
    return job;
  }
  return null;
}

/** Recover an omitted scope title only when one of this artist's library titles
 * occurs verbatim in both the proposed fact and its saved evidence. */
function matchingLibraryTitle(artistId: string, candidate: ResearchCandidate,
  kind: 'release' | 'track'): string | undefined {
  const rows = open().prepare(kind === 'release'
    ? `SELECT DISTINCT trim(local.release_title) AS title FROM sleeve_local_attachments local
      JOIN sleeve_recordings recording ON recording.id = local.recording_id
      WHERE recording.artist_id = ? AND length(trim(local.release_title)) >= 4`
    : `SELECT DISTINCT trim(local.title) AS title FROM sleeve_local_attachments local
      JOIN sleeve_recordings recording ON recording.id = local.recording_id
      WHERE recording.artist_id = ? AND length(trim(local.title)) >= 4`)
    .all(artistId) as Array<{ title: string }>;
  const full = candidate.wording.toLocaleLowerCase();
  const evidence = candidate.evidence.toLocaleLowerCase();
  const matches = rows.filter(({ title }) => full.includes(title.toLocaleLowerCase())
    && evidence.includes(title.toLocaleLowerCase()));
  return matches.length === 1 ? matches[0].title : undefined;
}

function titleIsSupported(candidate: ResearchCandidate, title: string | undefined): boolean {
  return Boolean(title && candidate.wording.toLocaleLowerCase().includes(title.toLocaleLowerCase())
    && candidate.evidence.toLocaleLowerCase().includes(title.toLocaleLowerCase()));
}

/** Recover a scope title only from text already present in both Full and
 * Evidence. A model's Wikipedia disambiguator is not part of the work title. */
function supportedScopeTitle(artistId: string, candidate: ResearchCandidate,
  proposed: string | undefined, kind: 'release' | 'track'): string | undefined {
  const title = proposed?.trim();
  if (titleIsSupported(candidate, title)) return title;
  const withoutDisambiguator = title?.replace(/\s+\((?:album|song|single|track|release|\d{4})\)$/iu, '');
  if (titleIsSupported(candidate, withoutDisambiguator)) return withoutDisambiguator;
  const libraryTitle = matchingLibraryTitle(artistId, candidate, kind);
  if (libraryTitle) return libraryTitle;
  const possibleTitles: string[] = [];
  if (kind === 'track') {
    for (const match of candidate.wording.matchAll(/["“]([^"”]{2,100})["”]|[‘']([^’']{2,100})[’']/gu)) {
      possibleTitles.push(match[1] ?? match[2]);
    }
  } else {
    const beforeAlbum = candidate.wording.match(/\bThe\s+([\p{Lu}].{1,79}?)\s+album\b/u)?.[1];
    const afterAlbum = candidate.wording.match(/\balbum,\s+([\p{Lu}][^,(.!?]{1,80})/u)?.[1];
    if (beforeAlbum) possibleTitles.push(beforeAlbum);
    if (afterAlbum) possibleTitles.push(afterAlbum);
  }
  const supported = [...new Set(possibleTitles.map((value) => value.trim())
    .filter((value) => titleIsSupported(candidate, value)))];
  return supported.length === 1 ? supported[0] : undefined;
}

/** Keep earlier candidates in place as later plays add article sections. */
function rankedArticleCandidates(sections: readonly (readonly ResearchCandidate[])[]): ResearchCandidate[] {
  const seen = new Set<string>();
  return sections.flat().filter((candidate) => {
    const key = candidate.wording.normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderArticleCandidates(candidates: readonly ResearchCandidate[], rankedIds: readonly string[]): ResearchCandidate[] {
  const byId = new Map(candidates.map((candidate, index) =>
    [`C${String(index + 1).padStart(3, '0')}`, candidate]));
  const seen = new Set<string>();
  const ordered: ResearchCandidate[] = [];
  for (const id of rankedIds) {
    if (seen.has(id)) continue;
    const candidate = byId.get(id);
    if (!candidate) continue;
    seen.add(id);
    ordered.push(candidate);
  }
  for (const [id, candidate] of byId) {
    if (!seen.has(id)) ordered.push(candidate);
  }
  return ordered;
}

/** Controller-owned final gate from stored evidence to retained research claims. */
export class ResearchWorker {
  private running = false;
  constructor(private readonly quietGate: QuietGate, private readonly researcher: Researcher = new LlmResearcher()) {}

  private researchPairIntervalMs(): number {
    return this.quietGate.isEmptyMaintenanceAllowed?.() === true
      ? emptyStationResearchPairIntervalMs() : RESEARCH_PAIR_INTERVAL_MS;
  }

  private reservePacedResearchSlot(kind:'research'|'review'='research'): string | null {
    const emptyMaintenance = this.quietGate.isEmptyMaintenanceAllowed?.() === true;
    const intervalMs = emptyMaintenance
      ? emptyStationResearchPairIntervalMs() : RESEARCH_PAIR_INTERVAL_MS;
    alignResearchPacing(intervalMs);
    const nextPairAt = reserveResearchPair(intervalMs);
    if(nextPairAt)open().prepare('UPDATE sleeve_research_pacing SET last_slot_kind=? WHERE id=1').run(kind);
    // The pacing row may not exist until the first research slot is reserved.
    // Persist the selected idle mode then so the hysteresis band survives a
    // listener mode change or controller restart.
    if (emptyMaintenance && nextPairAt) {
      open().prepare(`UPDATE sleeve_research_pacing SET empty_station_interval_ms = ? WHERE id = 1`)
        .run(intervalMs);
    }
    return nextPairAt;
  }

  private async processWikipediaChunk(
    job: repository.PendingResearchJob,
    source: NonNullable<ReturnType<typeof repository.latestSourceDocumentForResearch>>,
  ): Promise<boolean> {
    const albumJob = job.subjectType === 'release';
    const subjectKind = albumJob ? 'album' as const : 'artist' as const;
    const configuredClaimLimit = albumJob
      ? settings.get().sleeveNotes.wikipedia.albumClaimLimit
      : settings.get().sleeveNotes.wikipedia.artistClaimLimit;
    const db = open();
    let scan = db.prepare(`SELECT source_document_id AS sourceDocumentId,
        source_format_version AS sourceFormatVersion, chunk_count AS chunkCount,
        next_chunk AS nextChunk, chunk_characters AS chunkCharacters, prompt_hash AS promptHash
      FROM sleeve_wikipedia_scan_progress WHERE job_id = ?`).get(job.id) as {
        sourceDocumentId: string; sourceFormatVersion: number; chunkCount: number; nextChunk: number;
        chunkCharacters: number; promptHash: string;
      } | undefined;
    const profileHash = wikipediaCalibrationProfileHash();
    const promptHash = wikipediaScanHash(profileHash, configuredClaimLimit);
    const adaptiveSubjectType = albumJob ? 'release' : 'artist';
    const recommendedChunkCharacters = adaptiveWikipediaChunkCharacters(profileHash, adaptiveSubjectType);
    // Freeze section boundaries once a scan starts. Calibration changes apply
    // to new scans; only a deadline retries the current scan at a smaller size.
    const scanMatchesCurrentSource = scan && scan.sourceDocumentId === source.id
      && scan.sourceFormatVersion === 2 && scan.promptHash === promptHash;
    const chunkCharacters = scan && scanMatchesCurrentSource ? scan.chunkCharacters : recommendedChunkCharacters;
    const chunks = planWikipediaChunks(source.content, chunkCharacters);
    if (!chunks.length) { repository.finishResearchJob(job.id, 'complete'); return true; }
    if (scan && (scan.sourceDocumentId !== source.id || scan.sourceFormatVersion !== 2
      || scan.promptHash !== promptHash
      || scan.chunkCount !== chunks.length || scan.chunkCharacters !== chunkCharacters)) {
      const archivedAt = new Date().toISOString();
      db.prepare(`INSERT INTO sleeve_wikipedia_scan_history
        (job_id, source_document_id, chunk_index, section_path, input_hash, raw_response,
          items_json, elapsed_ms, parsed_count, retained_count, created_at, archived_at)
        SELECT job_id, source_document_id, chunk_index, section_path, input_hash, raw_response,
          items_json, elapsed_ms, parsed_count, retained_count, created_at, ?
        FROM sleeve_wikipedia_scan_chunks WHERE job_id = ?`).run(archivedAt, job.id);
      db.prepare('DELETE FROM sleeve_wikipedia_scan_chunks WHERE job_id = ?').run(job.id);
      db.prepare('DELETE FROM sleeve_wikipedia_scan_progress WHERE job_id = ?').run(job.id);
      scan = undefined;
    }
    if (!scan) {
      db.prepare(`INSERT INTO sleeve_wikipedia_scan_progress
        (job_id, source_document_id, source_format_version, chunk_count, next_chunk, updated_at, chunk_characters, prompt_hash)
        VALUES (?, ?, 2, ?, 0, ?, ?, ?)`)
        .run(job.id, source.id, chunks.length, new Date().toISOString(), chunkCharacters, promptHash);
      scan = { sourceDocumentId: source.id, sourceFormatVersion: 2, chunkCount: chunks.length,
        nextChunk: 0, chunkCharacters, promptHash };
    }
    if (scan.nextChunk >= chunks.length) { repository.finishResearchJob(job.id, 'complete'); return true; }

    const sectionClaimLimits = allocateWikipediaClaims(chunks, configuredClaimLimit);

    const slotAt = this.reservePacedResearchSlot();
    if (!slotAt) return false;
    const chunkIndex = scan.nextChunk;
    const chunk = chunks[chunkIndex];
    const sourceText = chunk.text;
    const sourceFormatVersion = /^<!--\s*subwave-wikipedia-source-format:2\s*-->/u.test(source.content) ? 2 : 1;
    const researchJob = {
      id: `${job.id}:chunk:${chunkIndex + 1}`,
      document: { ...source, text: sourceText },
      subjectKind,
      categories: albumJob ? wikipediaNoteCategories('release-group') : wikipediaNoteCategories('artist'),
      maxCandidates: 64,
      wikiNumber: sectionClaimLimits[chunkIndex] ?? 0,
      requireShortWording: false,
    };
    const controller = new AbortController();
    let abortReason: '45-second chunk deadline' | 'station left quiet state' | null = null;
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      abortReason = '45-second chunk deadline';
      controller.abort(new ResearchDeferredError('research-budget'));
    }, WIKIPEDIA_CHUNK_TIMEOUT_MS);
    const quietMonitor = setInterval(() => {
      if (!controller.signal.aborted && !this.quietGate.isQuiet()) {
        abortReason = 'station left quiet state';
        controller.abort(new ResearchDeferredError(researchAllowed() ? 'broadcast-priority' : 'station-token-cap'));
      }
    }, 500);
    const startedAt = Date.now();
    let promptInputTokens: number | null = null;
    let promptOutputTokens: number | null = null;
    this.running = true;
    try {
      repository.markResearchJobRunning(job.id);
      if (!this.researcher.extractWikipediaSparks) throw new Error('Researcher has no Wikipedia text extractor');
      const madeLlmCall = researchJob.wikiNumber !== 0;
      const extraction: WikipediaSparkExtraction = !madeLlmCall ? { claims: [], rawResponse: '' }
        : await this.researcher.extractWikipediaSparks(researchJob, chunk.sectionPath, controller.signal,
          undefined, (usage) => {
            if (Number.isFinite(usage.input) && usage.input > 0) promptInputTokens = Math.ceil(usage.input);
            if (Number.isFinite(usage.output) && usage.output >= 0) promptOutputTokens = Math.ceil(usage.output);
          });
      const sparks = extraction.claims;
      const raw = extraction.rawResponse;
      const returnedClaimList = /^\s*(?:\d{1,3}[.):]|[-*•])\s+/mu.test(raw);
      const artistSparkMissingClassification = subjectKind === 'artist'
        && sparks.some((spark) => !spark.category || !spark.airtimeScope);
      if ((returnedClaimList && !sparks.length) || artistSparkMissingClassification) {
        throw new Error('Wikipedia extract omitted required claim category or airtime scope metadata');
      }
      const extractedCandidates = wikipediaCandidatesFromSparks(sparks, sourceText, subjectKind)
        .map((candidate) => ({ ...candidate, extractionSection: chunkIndex + 1 }));
      const scopeRejected = new Set<string>();
      const candidates: ResearchCandidate[] = extractedCandidates.flatMap((candidate): ResearchCandidate[] => {
        if (subjectKind !== 'artist') return [{ ...candidate, airtimeScope: 'general' as const }];
        let scope = candidate.airtimeScope ?? 'general';
        if (candidate.category === 'release-stories' && scope === 'general') scope = 'matching-release-only';
        if (candidate.category === 'track-stories' && scope === 'general') scope = 'matching-track-only';
        const storyCategory = ['artist-stories', 'release-stories', 'track-stories'].includes(candidate.category);
        if (scope === 'matching-release-only') {
          const title = supportedScopeTitle(source.entityId, candidate, candidate.matchingReleaseTitle, 'release');
          if (!title) { scopeRejected.add(candidate.wording); return []; }
          const category: ResearchCandidate['category'] = storyCategory ? 'release-stories' : candidate.category;
          return [{ ...candidate, category, airtimeScope: scope, matchingReleaseTitle: title, matchingTrackTitle: undefined }];
        }
        if (scope === 'matching-track-only') {
          const title = supportedScopeTitle(source.entityId, candidate, candidate.matchingTrackTitle, 'track');
          if (!title) { scopeRejected.add(candidate.wording); return []; }
          const category: ResearchCandidate['category'] = storyCategory ? 'track-stories' : candidate.category;
          return [{ ...candidate, category, airtimeScope: scope, matchingTrackTitle: title, matchingReleaseTitle: undefined }];
        }
        const category: ResearchCandidate['category'] = storyCategory ? 'artist-stories' : candidate.category;
        return [{ ...candidate, category,
          airtimeScope: 'general' as const, matchingReleaseTitle: undefined, matchingTrackTitle: undefined }];
      });
      const screened = screenResearchCandidates(researchJob, candidates);
      const normalizeSpark = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase();
      const candidateByText = new Map(extractedCandidates.map((candidate) => [normalizeSpark(candidate.wording), candidate]));
      const acceptedTexts = new Set(screened.accepted.map((candidate) => normalizeSpark(candidate.wording)));
      const rejectedByText = new Map(screened.rejected.map(({ candidate, reason }) => [normalizeSpark(candidate.wording), reason]));
      const itemDiagnostics = sparks.map((spark) => {
        const key = normalizeSpark(spark.wording);
        const candidate = candidateByText.get(key);
        return {
          wording: spark.wording,
          ...(spark.category ? { category: spark.category } : {}),
          ...(spark.airtimeScope ? { airtimeScope: spark.airtimeScope } : {}),
          ...(spark.matchingReleaseTitle ? { matchingReleaseTitle: spark.matchingReleaseTitle } : {}),
          ...(spark.matchingTrackTitle ? { matchingTrackTitle: spark.matchingTrackTitle } : {}),
          state: scopeRejected.has(candidate?.wording ?? '') ? 'scope-title-unsupported'
            : !candidate ? 'no-source-match' : acceptedTexts.has(key) ? 'retained' : 'source-screen-rejected',
          ...(candidate ? { evidence: candidate.evidence } : {}),
          ...(scopeRejected.has(candidate?.wording ?? '') ? { reason: 'The exact release or track title was not supported by both the claim and its evidence.' }
            : rejectedByText.has(key) ? { reason: rejectedByText.get(key) } : {}),
        };
      });
      const refreshRequest = db.prepare(`SELECT refresh_mode AS refreshMode
        FROM sleeve_wikipedia_rescan_requests WHERE job_id = ?`).get(job.id) as {
          refreshMode: WikipediaRefreshMode;
        } | undefined;
      const refreshJob = db.prepare(`SELECT wikipedia_refresh_mode AS refreshMode
        FROM sleeve_research_jobs WHERE id = ?`).get(job.id) as { refreshMode: WikipediaRefreshMode | null };
      const stageCandidates = refreshJob.refreshMode === 'replace'
        || refreshRequest?.refreshMode === 'clear' || refreshRequest?.refreshMode === 'replace';
      if (!stageCandidates) repository.retainResearchClaims({
        entityType: albumJob ? 'release-group' : 'artist', entityId: job.subjectId,
        sourceDocumentId: source.id, candidates: screened.accepted,
      });
      const elapsedMs = Date.now() - startedAt;
      const nextChunk = chunkIndex + 1;
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(`INSERT OR REPLACE INTO sleeve_wikipedia_scan_chunks
          (job_id, source_document_id, chunk_index, section_path, input_hash, raw_response, elapsed_ms,
            items_json, parsed_count, retained_count, created_at, accepted_candidates_json, input_characters)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(job.id, source.id, chunkIndex, chunk.sectionPath,
            createHash('sha256').update(chunk.text).digest('hex'), raw, elapsedMs, JSON.stringify(itemDiagnostics),
            sparks.length, screened.accepted.length, now, JSON.stringify(stageCandidates ? screened.accepted : []), sourceText.length);
        if (madeLlmCall) {
          db.prepare(`INSERT INTO sleeve_wikipedia_chunk_attempts
            (job_id, source_document_id, chunk_index, input_characters, input_tokens, output_tokens,
              target_characters, elapsed_ms, profile_hash, outcome, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?)`).run(job.id, source.id, chunkIndex,
              sourceText.length, promptInputTokens, promptOutputTokens, chunkCharacters, elapsedMs, profileHash, now);
        }
        db.prepare(`UPDATE sleeve_wikipedia_scan_progress
          SET next_chunk = ?, updated_at = ? WHERE job_id = ?`).run(nextChunk, now, job.id);
        if (nextChunk >= chunks.length) {
          if (refreshJob.refreshMode === 'replace') {
            const stored = db.prepare(`SELECT accepted_candidates_json AS candidates
              FROM sleeve_wikipedia_scan_chunks WHERE job_id = ? AND source_document_id = ?
              ORDER BY chunk_index`).all(job.id, source.id) as Array<{ candidates: string }>;
            const candidates = stored.flatMap(({ candidates }) => JSON.parse(candidates) as ResearchCandidate[]);
            repository.replaceAutomaticWikipediaClaimsInDatabase(db, {
              entityType: albumJob ? 'release-group' : 'artist', entityId: job.subjectId,
              sourceDocumentId: source.id, candidates, now,
            });
          }
          db.prepare('UPDATE sleeve_source_documents SET wikipedia_completed_at=? WHERE id=?').run(now,source.id);
          db.prepare('DELETE FROM sleeve_research_progress WHERE job_id = ?').run(job.id);
          db.prepare(`UPDATE sleeve_research_jobs SET state = 'complete', run_after = NULL, wikipedia_refresh_mode = NULL, operator_requested = 0,
            updated_at = ?, completed_at = ? WHERE id = ?`).run(now, now, job.id);
          if (refreshJob.refreshMode === 'replace') {
            db.prepare(`UPDATE sleeve_research_jobs SET wikipedia_refreshed_at = ? WHERE id = ?`)
              .run(now, job.id);
          }
          const refreshPlan = db.prepare(`SELECT requested_at AS requestedAt
            FROM sleeve_wikipedia_refresh_plan WHERE id = 1`).get() as { requestedAt: string } | undefined;
          if (refreshPlan) {
            const pendingRefresh = db.prepare(`SELECT 1 FROM sleeve_source_documents source
              WHERE source.provider = 'wikipedia' AND source.entity_type IN ('artist', 'release-group')
                AND source.id = (SELECT latest.id FROM sleeve_source_documents latest
                  WHERE latest.provider = 'wikipedia' AND latest.entity_type = source.entity_type
                    AND latest.entity_id = source.entity_id ORDER BY latest.retrieved_at DESC LIMIT 1)
                AND source.retrieved_at <= ?
                AND NOT EXISTS (SELECT 1 FROM sleeve_research_jobs job
                  WHERE job.provider = 'researcher'
                    AND job.subject_type = CASE source.entity_type WHEN 'artist' THEN 'artist' ELSE 'release' END
                    AND job.subject_id = source.entity_id
                    AND job.capability = CASE source.entity_type WHEN 'artist'
                      THEN 'extract-wikipedia' ELSE 'extract-wikipedia-release-group' END
                    AND job.wikipedia_refreshed_at >= ?)
              LIMIT 1`).get(refreshPlan.requestedAt, refreshPlan.requestedAt);
            if (!pendingRefresh) db.prepare('DELETE FROM sleeve_wikipedia_refresh_plan WHERE id = 1').run();
          }
        } else {
          db.prepare(`UPDATE sleeve_research_jobs SET state = 'retry-at', run_after = ?,
            updated_at = ?, completed_at = NULL WHERE id = ?`).run(slotAt, now, job.id);
        }
      }).immediate();
      console.log(`[sleeve-notes] Wikipedia ${subjectKind} section ${nextChunk}/${chunks.length}: ${sparks.length} sparks, ${screened.accepted.length} retained, ${sparks.length - screened.accepted.length} held by source screen, ${sourceText.length} article chars, ${promptInputTokens ?? 'token usage unavailable'} prompt tokens, ${elapsedMs}ms, source format ${sourceFormatVersion}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      const elapsedMs = Date.now() - startedAt;
      const attemptOutcome = error instanceof ResearchDeferredError && error.reason === 'station-token-cap' ? 'quiet'
        : abortReason === '45-second chunk deadline' ? 'deadline'
        : abortReason === 'station left quiet state' ? 'quiet' : 'error';
      db.transaction(() => {
        db.prepare(`INSERT INTO sleeve_wikipedia_chunk_attempts
          (job_id, source_document_id, chunk_index, input_characters, input_tokens, output_tokens,
            target_characters, elapsed_ms, profile_hash, outcome, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(job.id, source.id, chunkIndex, sourceText.length, promptInputTokens, promptOutputTokens,
            chunkCharacters, attemptOutcome === 'deadline' ? WIKIPEDIA_CHUNK_TIMEOUT_MS : elapsedMs,
            profileHash, attemptOutcome, failedAt);
        if (attemptOutcome === 'deadline' && chunkCharacters > MIN_WIKIPEDIA_CHUNK_CHARACTERS) {
          const smallerChunkCharacters = Math.max(MIN_WIKIPEDIA_CHUNK_CHARACTERS,
            Math.min(Math.floor(chunkCharacters * 0.75), adaptiveWikipediaChunkCharacters(profileHash, adaptiveSubjectType)));
          const smallerChunks = planWikipediaChunks(source.content, smallerChunkCharacters);
          db.prepare(`INSERT INTO sleeve_wikipedia_scan_history
            (job_id, source_document_id, chunk_index, section_path, input_hash, raw_response,
              items_json, elapsed_ms, parsed_count, retained_count, created_at, archived_at)
            SELECT job_id, source_document_id, chunk_index, section_path, input_hash, raw_response,
              items_json, elapsed_ms, parsed_count, retained_count, created_at, ?
            FROM sleeve_wikipedia_scan_chunks WHERE job_id = ?`).run(failedAt, job.id);
          db.prepare('DELETE FROM sleeve_wikipedia_scan_chunks WHERE job_id = ?').run(job.id);
          db.prepare(`UPDATE sleeve_wikipedia_scan_progress SET next_chunk = 0, chunk_count = ?,
            chunk_characters = ?, updated_at = ? WHERE job_id = ?`)
            .run(smallerChunks.length, smallerChunkCharacters, failedAt, job.id);
          console.warn(`[sleeve-notes] Wikipedia ${subjectKind} chunk hit the 45-second deadline; restarting its cached article at ${smallerChunkCharacters} characters per chunk.`);
        }
        db.prepare(`UPDATE sleeve_research_jobs SET state = 'retry-at', run_after = ?,
          updated_at = ?, completed_at = NULL WHERE id = ?`).run(slotAt, failedAt, job.id);
      }).immediate();
      console.warn(`[sleeve-notes] Wikipedia ${subjectKind} extraction deferred at chunk ${chunkIndex + 1}/${chunks.length}${abortReason ? ` (${abortReason})` : ''}: ${message}`);
      return true;
    } finally {
      clearTimeout(timeout);
      clearInterval(quietMonitor);
      this.running = false;
    }
  }

  async runOnce(): Promise<boolean> {
    return runResearchDatabaseWork(()=>this.runOnceInner());
  }
  private async runOnceInner(): Promise<boolean> {
    if (this.running || !researchAllowed() || settings.get().djBehaviour.extendedSleeveNotes !== true || settings.get().djBehaviour.sleeveNotesCollectionPaused === true || !this.quietGate.isQuiet()) return false;
    const allowIdleRescans = this.quietGate.isEmptyMaintenanceAllowed?.() === true;
    alignResearchPacing(this.researchPairIntervalMs());
    const queued = nextPlayDrivenResearchJob(allowIdleRescans);
    const review=nextAiringReview();
    const reviewPriority=review?queuePromotion(open(),`review:${review.id}`):'';
    const researchPriority=queued?queuePromotion(open(),queued.id):'';
    const lastSlot=open().prepare('SELECT last_slot_kind AS kind FROM sleeve_research_pacing WHERE id=1').get() as {kind:string}|undefined;
    // Alternate normal slots under contention so neither reviews nor a long
    // article refresh can starve the other. Explicit promotions win ties.
    if (review && (!queued || reviewPriority>researchPriority
      || reviewPriority===researchPriority && (!!reviewPriority || lastSlot?.kind!=='review'))) {
      if (!this.reservePacedResearchSlot('review')) return false;
      this.running=true;
      try {return await runAiringReview(review,this.quietGate);} finally {this.running=false;}
    }
    if (!queued) return false;
    const geniusAlbumJob = queued.capability === 'extract-genius-album';
    const albumJob = queued.subjectType === 'release';
    const entityType = albumJob ? 'release-group' : 'artist';
    const sourceProvider = geniusAlbumJob ? 'genius' : 'wikipedia';
    const source = repository.latestSourceDocumentForResearch(entityType, queued.subjectId, sourceProvider);
    if (!source) { repository.finishResearchJob(queued.id, 'failed'); return true; }
    if(sourceProvider==='wikipedia'&&source.wikipediaPrunedAt) {
      repository.requestWikipediaArticleRefetch(queued);
      return true;
    }
    if (queued.capability === 'extract-wikipedia'
      || queued.capability === 'extract-wikipedia-release-group') {
      return this.processWikipediaChunk(queued, source);
    }
    const sections = splitResearchSource(source.content);
    if (!sections.length) { repository.finishResearchJob(queued.id, 'complete'); return true; }
    const progress = researchProgress(queued.id, source.id);
    const nextPairAt = this.reservePacedResearchSlot();
    if (!nextPairAt) return false;
    this.running = true;
    try {
      console.log(`[sleeve-notes] Play-driven research of ${sourceProvider} ${albumJob ? 'album' : 'artist'} biography: ${source.entityName ?? queued.subjectId}`);
      if (progress.nextSection === 0 && !progress.pendingCandidates && !progress.candidateSections.length) {
        repository.markResearchJobRunning(queued.id);
      }
      else open().prepare(`UPDATE sleeve_research_jobs SET state = 'running', updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), queued.id);
      try {
        const fullJob = {
          id: `${queued.id}:full`,
          document: { ...source, text: source.content },
          subjectKind: albumJob ? 'album' as const : 'artist' as const,
          categories: RELEASE_GROUP_NOTE_CATEGORIES,
          maxCandidates: MAX_CANDIDATES_PER_ARTIST_RESEARCH,
          requireShortWording: false,
          airtimeContext: repository.airtimeContextForResearchJob(queued) ?? undefined,
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          if (!controller.signal.aborted) controller.abort(new ResearchDeferredError('research-budget'));
        }, ARTICLE_INDEX_TIMEOUT_MS);
        const quietMonitor = setInterval(() => {
          if (!controller.signal.aborted && !this.quietGate.isQuiet()) {
            controller.abort(new ResearchDeferredError(researchAllowed() ? 'broadcast-priority' : 'station-token-cap'));
          }
        }, 1_000);
        try {
          let usedThisEncounter = false;
          let firstEncounterCheckSize = 1;
          const needsIndex = progress.rankedClaimIds === null;
          if (needsIndex) {
            const startedAt = Date.now();
            const extracted = await this.researcher.extract(fullJob, controller.signal);
            const screened = screenResearchCandidates(fullJob, extracted);
            progress.candidateSections.push(screened.accepted);
            progress.nextSection = sections.length;
            const pool = rankedArticleCandidates(progress.candidateSections);
            progress.rankedClaimIds = pool.length > 1
              ? await this.researcher.rankForAirtime?.(fullJob, screened.accepted, controller.signal) ?? []
              : pool.map((_, index) => `C${String(index + 1).padStart(3, '0')}`);
            progress.playsConsumed++;
            usedThisEncounter = true;
            firstEncounterCheckSize = Date.now() - startedAt <= FIRST_ENCOUNTER_TWO_CHECKS_MS ? 2 : 1;
            console.log(`[sleeve-notes] Article section ${progress.nextSection}/${sections.length}: ${extracted.length} ranked leads, ${screened.accepted.length} passed evidence screening`);
            deferResearchSection(queued.id, source.id, progress, nextPairAt);
            if (screened.accepted.length &&
              (Date.now() - startedAt > FIRST_ENCOUNTER_CHECK_HEADROOM_MS || !this.quietGate.isQuiet())) return true;
          }
          const pool = rankedArticleCandidates(progress.candidateSections);
          const ranked = orderArticleCandidates(pool, progress.rankedClaimIds ?? []);
          const approvedSoFar = progress.acceptedSections.reduce((count, batch) => count + batch.length, 0);
          const batch = ranked.slice(progress.checkCursor,
            progress.checkCursor + (usedThisEncounter ? firstEncounterCheckSize : 1));
          if (batch.length && !this.quietGate.isQuiet()) {
            deferResearchSection(queued.id, source.id, progress, nextPairAt);
            return true;
          }
          const decisions = batch.length
            ? await this.researcher.reviewForAirtime?.(fullJob, batch, controller.signal) ?? []
            : [];
          const byId = new Map(decisions.map((decision) => [decision.claimId, decision]));
          if (batch.some((_, index) => !byId.has(`C${String(index + 1).padStart(3, '0')}`))) {
            // Persist the same cursor and retry later; an absent verdict is not a rejection.
            deferResearchSection(queued.id, source.id, progress, nextPairAt);
            console.warn('[sleeve-notes] Airtime review was incomplete; candidates remain unresolved');
            return true;
          }
          const sectionResult: ValidatedResearch = { accepted: [], rejected: [] };
          for (const [position, candidate] of batch.entries()) {
            if (approvedSoFar + sectionResult.accepted.length >= MAX_RETAINED_CLAIMS_PER_ARTICLE) break;
            const decision = byId.get(`C${String(position + 1).padStart(3, '0')}`);
            const outcome = applyAirtimeDecision(fullJob, candidate, decision,
              (value, title, kind) => supportedScopeTitle(source.entityId, value, title, kind));
            if (outcome.accepted) sectionResult.accepted.push(outcome.accepted);
            if (outcome.rejected) sectionResult.rejected.push(outcome.rejected);
          }
          progress.acceptedSections.push(sectionResult.accepted);
          progress.rejected.push(...sectionResult.rejected);
          progress.checkCursor += batch.length;
          if (batch.length && !usedThisEncounter) progress.playsConsumed++;
          const retainedSoFar = approvedSoFar + sectionResult.accepted.length;
          if (retainedSoFar < MAX_RETAINED_CLAIMS_PER_ARTICLE
            && (progress.checkCursor < ranked.length || progress.nextSection < sections.length)) {
            open().transaction(() => {
              if (sectionResult.accepted.length) repository.retainResearchClaims({
                entityType, entityId: source.entityId, sourceDocumentId: source.id,
                candidates: sectionResult.accepted,
              });
              deferResearchSection(queued.id, source.id, progress, nextPairAt);
            }).immediate();
            return true;
          }
          const validated = screenResearchCandidates(fullJob,
            progress.acceptedSections.flat());
          const outcomeObserver = this.researcher as Partial<ResearchOutcomeObserver>;
          const candidateKey = (candidate: ResearchCandidate) =>
            `${candidate.wording}\u0000${candidate.evidence}`;
          const rankByKey = new Map(ranked.map((candidate, index) => [candidateKey(candidate), index]));
          const recycleCandidates = [...progress.rejected]
            .filter(({ candidate, reason }) => reason === 'editorial' && usefulRepairCandidate(candidate))
            .sort((left, right) => (rankByKey.get(candidateKey(left.candidate)) ?? Number.MAX_SAFE_INTEGER)
              - (rankByKey.get(candidateKey(right.candidate)) ?? Number.MAX_SAFE_INTEGER))
            .slice(0, Math.min(MAX_RECYCLE_CANDIDATES_PER_ARTICLE,
              MAX_RETAINED_CLAIMS_PER_ARTICLE - validated.accepted.length));
          const retainedKeys = new Set(validated.accepted.map(candidateKey));
          const rejectedByKey = new Map(progress.rejected.map((item) => [candidateKey(item.candidate), item]));
          for (const [index, section] of progress.candidateSections.entries()) {
            outcomeObserver.recordOutcome?.({ ...fullJob, id: `${queued.id}:section:${index + 1}` }, {
              accepted: section.filter((candidate) => retainedKeys.has(candidateKey(candidate))),
              rejected: section.flatMap((candidate) => {
                const rejected = rejectedByKey.get(candidateKey(candidate));
                return rejected ? [rejected] : [];
              }),
            });
          }
          open().transaction(() => {
            repository.retainResearchClaims({
              entityType, entityId: source.entityId, sourceDocumentId: source.id,
              candidates: validated.accepted,
            });
            retainRejectedCandidates({
              sourceDocumentId: source.id, entityType, entityId: source.entityId,
              rejected: recycleCandidates,
              origin: 'generic-dj',
            });
            open().prepare('DELETE FROM sleeve_research_progress WHERE job_id = ?').run(queued.id);
            repository.finishResearchJob(queued.id, 'complete');
          }).immediate();
          const rejectedCount = progress.rejected.length + validated.rejected.length;
          console.log(`[sleeve-notes] Research retained ${validated.accepted.length} claim${validated.accepted.length === 1 ? '' : 's'} (${rejectedCount} rejected across ${sections.length} source sections; ${recycleCandidates.length} sent to Recycle Bin)`);
          if (rejectedCount > 0) {
            const reasons = new Map<string, number>();
            for (const { reason } of [...progress.rejected, ...validated.rejected]) {
              reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
            }
            console.log(`[sleeve-notes] Genius album rejection reasons: ${[...reasons]
              .map(([reason, count]) => `${reason} ${count}`).join(', ')}`);
          }
        } finally {
          clearTimeout(timeout);
          clearInterval(quietMonitor);
        }
      } catch (err: unknown) {
        if (err instanceof ResearchDeferredError && err.reason === 'station-token-cap') {
          deferResearchSection(queued.id,source.id,progress,nextPairAt);
          repository.retryResearchJob(queued.id);
          console.log('[sleeve-notes] Research paused by station token budget; job retained');
          return true;
        }
        progress.playsConsumed = Math.max(progress.playsConsumed, playedEncounterCount(queued));
        deferResearchSection(queued.id, source.id, progress, nextPairAt);
        console.warn(`[sleeve-notes] Research failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    } finally { this.running = false; }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startResearchWorker(quietGate: QuietGate): void {
  if (timer) return;
  const worker = new ResearchWorker(quietGate);
  timer = setInterval(() => { void worker.runOnce(); }, 10_000);
  timer.unref();
  const expiryTimer = setInterval(() => {
    if (!settings.get().djBehaviour.extendedSleeveNotes || !quietGate.isQuiet()) return;
    void runResearchDatabaseWork(async () => {
      const started = performance.now();
      try {
        expireRecycleBin();
        pruneCompletedWikipediaArticlesInDatabase(open());
      } finally {
        const elapsed = Math.round(performance.now() - started);
        if (elapsed >= 1_000) console.warn(`[sleeve-notes] Slow database housekeeping: ${elapsed}ms (controller)`);
      }
      return true;
    }).catch(error => console.warn('[sleeve-notes] Recycle Bin cleanup deferred:', error instanceof Error ? error.message : String(error)));
  }, 60 * 60 * 1000);
  expiryTimer.unref();
}
