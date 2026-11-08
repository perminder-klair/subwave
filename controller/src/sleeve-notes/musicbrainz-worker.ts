import { librarySourceKey } from './local-identity.js';
import { runResearchDatabaseWork } from './db.js';
// Quiet-time Stage 2 matching. This intentionally has no timer or server
// wiring yet: the caller must supply the station's playback-critical quiet
// gate, so a future scheduler cannot accidentally turn it into a foreground
// collector.
import { finishBrainAlbumMatchesInDatabase } from './brain-album-research.js';
import { queueBrainArtistInDatabase } from './brain-coverage.js';
import { open } from './db.js';
import * as musicbrainz from '../music/musicbrainz.js';
import * as settings from '../settings.js';
import * as repository from './research-repository.js';
import { gatedListenerCount } from '../broadcast/listeners.js';

export interface QuietGate {
  isQuiet(): boolean;
  /** True only for confirmed zero-listener background-maintenance windows. */
  isEmptyMaintenanceAllowed?(): boolean;
}

export interface CanonicalRecordingLookup {
  lookup(track: { title: string; artist: string | null; mbid: string | null }): Promise<musicbrainz.CanonicalMusicBrainzRecording | null>;
}

export class MusicBrainzMatchWorker {
  private running = false;

  constructor(
    private readonly quietGate: QuietGate,
    private readonly lookup: CanonicalRecordingLookup = { lookup: musicbrainz.lookupCanonicalRecording },
  ) {}

  async runOnce(): Promise<boolean> {
    return runResearchDatabaseWork(()=>this.runOnceInner());
  }
  private async runOnceInner(): Promise<boolean> {
    if (this.running || settings.get().djBehaviour.extendedSleeveNotes !== true || settings.get().djBehaviour.sleeveNotesCollectionPaused === true || !this.quietGate.isQuiet()) return false;
    const job = repository.nextPendingResearchJob('musicbrainz', {promotedOnly:true})
      ?? repository.nextPendingResearchJob('musicbrainz', { subjectType: 'local-track', capability: 'match' })
      ?? repository.nextPendingResearchJob('musicbrainz', { subjectType: 'release', capability: 'release-context' });
    if (!job) return false;
    if (job.subjectType === 'release') return this.retainReleaseContext(job);
    const attachment = repository.localAttachmentForMatch(job.subjectId);
    if (!attachment) {
      repository.finishResearchJob(job.id, 'failed');
      return true;
    }
    const sourceKey=librarySourceKey();
    this.running = true;
    try {
      console.log(`[sleeve-notes] MusicBrainz match: ${attachment.artist ? `${attachment.artist} — ` : ''}${attachment.title}`);
      repository.markResearchJobRunning(job.id);
      const requestId = repository.startProviderRequest({ provider: 'musicbrainz', capability: 'match' });
      try {
        const result = await this.lookup.lookup({
          title: attachment.title, artist: attachment.artist, mbid: attachment.musicbrainzRecordingId,
        });
        const current = repository.localAttachmentForMatch(job.subjectId);
        if (sourceKey!==librarySourceKey() || !current || current.title !== attachment.title || current.artist !== attachment.artist
          || current.musicbrainzRecordingId !== attachment.musicbrainzRecordingId) {
          repository.finishProviderRequest(requestId, result ? 'ready' : 'no-match');
          if (current && sourceKey===librarySourceKey()) repository.requeueResearchJob(job.id);
          return true;
        }
        if (!result) {
          finishBrainAlbumMatchesInDatabase(open(), attachment.localTrackId, false);
          repository.finishProviderRequest(requestId, 'no-match');
          repository.finishResearchJob(job.id, 'failed');
          console.log(`[sleeve-notes] MusicBrainz no confident match: ${attachment.artist ? `${attachment.artist} — ` : ''}${attachment.title}`);
        }
        else {
          repository.finishProviderRequest(requestId, 'ready');
          repository.retainCanonicalMusicBrainzMatch(attachment.localTrackId, result,
            (gatedListenerCount() ?? 0) > 0);
          const db = open();
          finishBrainAlbumMatchesInDatabase(db, attachment.localTrackId, true);
          const requested = db.prepare('SELECT operator_requested AS requested FROM sleeve_research_jobs WHERE id = ?').get(job.id) as { requested: number } | undefined;
          if (requested?.requested) {
            const artist = db.prepare(`SELECT recording.artist_id AS id FROM sleeve_local_attachments local
              JOIN sleeve_recordings recording ON recording.id = local.recording_id WHERE local.local_track_id = ?`).get(attachment.localTrackId) as { id: string | null } | undefined;
            if (!artist?.id) {
              repository.finishResearchJob(job.id, 'failed');
              console.warn('[sleeve-notes] Operator research could not resolve a confirmed artist identity for this library track.');
              return true;
            }
            queueBrainArtistInDatabase(db, artist.id);
            db.prepare('UPDATE sleeve_research_jobs SET operator_requested = 0 WHERE id = ?').run(job.id);
          }
          repository.finishResearchJob(job.id, 'complete');
          console.log(`[sleeve-notes] MusicBrainz matched: ${result.artist?.name ?? 'Unknown artist'} — ${result.title}`);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
      const status = Number(message.match(/HTTP\s+(\d{3})/)?.[1]) || null;
        repository.finishProviderRequest(requestId, status === 429 ? 'rate-limited' : 'failed', status);
        const delayMs = repository.musicBrainzRetryDelay(job.attempts + 1);
        repository.retryResearchJob(job.id, delayMs);
        if (status === 429 || status === 503) {
          const outageDelay = repository.musicBrainzOutageDelay(job.attempts + 1);
          const deferred = repository.deferMusicBrainzMatches(outageDelay);
          console.warn(`[sleeve-notes] MusicBrainz ${status}; deferred ${deferred} pending match${deferred === 1 ? '' : 'es'} for ${Math.round(outageDelay / 60_000)}m (attempt ${job.attempts + 1})`);
        } else {
          console.warn(`[sleeve-notes] MusicBrainz temporarily unavailable; retrying in ${Math.round(delayMs / 60_000)}m (attempt ${job.attempts + 1}): ${message}`);
        }
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  private async retainReleaseContext(job: repository.PendingResearchJob): Promise<boolean> {
    const release = repository.canonicalReleaseForResearch(job.subjectId);
    if (!release) { repository.finishResearchJob(job.id, 'failed'); return true; }
    this.running = true;
    try {
      console.log(`[sleeve-notes] MusicBrainz release context: ${release.title}`);
      repository.markResearchJobRunning(job.id);
      repository.retainSourceDocument({
        entityType: 'release', entityId: release.id, provider: 'musicbrainz',
        sourceUrl: `https://musicbrainz.org/release/${encodeURIComponent(release.musicbrainzReleaseId)}`,
        revisionId: null, contentKind: 'structured-json', attribution: 'MusicBrainz data, CC0',
        content: JSON.stringify({
          title: release.title, date: release.date, country: release.country,
          primaryType: release.primaryType, status: release.status,
          releaseGroupId: release.releaseGroupId, selectionReason: release.selectionReason,
        }),
      });
      repository.finishResearchJob(job.id, 'complete');
      console.log(`[sleeve-notes] MusicBrainz release context retained: ${release.title}`);
      return true;
    } finally { this.running = false; }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the deliberately slow, single-flight Stage-2 matcher. */
export function startMusicBrainzMatchWorker(quietGate: QuietGate): void {
  if (timer) return;
  const worker = new MusicBrainzMatchWorker(quietGate);
  timer = setInterval(() => { void worker.runOnce(); }, 5_000);
  timer.unref();
}
