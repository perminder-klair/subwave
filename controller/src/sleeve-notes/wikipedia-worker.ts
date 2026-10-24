import { runResearchDatabaseWork } from './db.js';
import * as settings from '../settings.js';
import * as repository from './research-repository.js';
import * as wikipedia from './wikipedia.js';
import type { QuietGate } from './musicbrainz-worker.js';

const ARTIST_CAPABILITY = 'biography';
const RELEASE_GROUP_CAPABILITY = 'release-group-biography';
const RELEASE_GROUP_EXTRACTION = 'extract-wikipedia-release-group';
const BACKFILL_INTERVAL_MS = 60_000;

/** Identity-first Wikipedia collection for artists and canonical album groups. */
export class WikipediaWorker {
  private running = false;
  private lastBackfillAt = 0;
  constructor(private readonly quietGate: QuietGate, private readonly sources: Pick<typeof wikipedia, 'fetchWikipediaArtistDocument' | 'fetchWikipediaReleaseGroupDocument'> = wikipedia) {}

  async runOnce(): Promise<boolean> {
    return runResearchDatabaseWork(()=>this.runOnceInner());
  }
  private async runOnceInner(): Promise<boolean> {
    if (this.running || settings.get().djBehaviour.extendedSleeveNotes !== true || settings.get().djBehaviour.sleeveNotesCollectionPaused === true || !this.quietGate.isQuiet()) return false;

    const now = Date.now();
    if (now - this.lastBackfillAt >= BACKFILL_INTERVAL_MS) {
      repository.enqueueMissingWikipediaArticleJobs();
      this.lastBackfillAt = now;
    }

    // Album groups are the less repetitive source, so let those lookups run
    // before the existing artist-biography backlog.
    const releaseGroupJob = repository.nextPendingResearchJob('wikipedia', {
      subjectType: 'release', capability: RELEASE_GROUP_CAPABILITY,
    });
    const artistJob = releaseGroupJob ? null : repository.nextPendingResearchJob('wikipedia', {
      subjectType: 'artist', capability: ARTIST_CAPABILITY,
    });
    const job = repository.nextPendingResearchJob('wikipedia',{promotedOnly:true}) ?? releaseGroupJob ?? artistJob;
    if (!job) return false;
    return job.subjectType === 'release'
      ? this.fetchReleaseGroup(job)
      : this.fetchArtist(job);
  }

  private async fetchArtist(job: repository.PendingResearchJob): Promise<boolean> {
    const artist = repository.artistForResearch(job.subjectId);
    if (!artist) { repository.finishResearchJob(job.id, 'failed'); return true; }
    this.running = true;
    try {
      console.log(`[sleeve-notes] Wikipedia biography: ${artist.name}`);
      repository.markResearchJobRunning(job.id);
      const requestId = repository.startProviderRequest({ provider: 'wikipedia', capability: ARTIST_CAPABILITY });
      let document: wikipedia.WikipediaArtistDocument | null;
      try {
        document = await this.sources.fetchWikipediaArtistDocument(artist.musicBrainzId);
      } catch (error) {
        this.retryProviderRequest(job, requestId, error);
        return true;
      }
      if (!document) {
        repository.finishProviderRequest(requestId, 'no-match');
        repository.finishResearchJob(job.id, 'failed');
        console.log(`[sleeve-notes] Wikipedia biography unavailable: ${artist.name}`);
      } else {
        repository.finishProviderRequest(requestId, 'ready');
        repository.retainSourceDocument({
          entityType: 'artist', entityId: artist.id, provider: 'wikipedia',
          sourceUrl: document.url, revisionId: document.revisionId,
          contentKind: 'bounded-text', content: document.text, attribution: document.attribution,
        });
        repository.enqueueResearchJob({
          provider: 'researcher', subjectType: 'artist', subjectId: artist.id,
          capability: 'extract-wikipedia', priority: 300,
          originLocalTrackId: job.originLocalTrackId,
        });
        repository.forwardOperatorResearchRequest(job,'researcher','extract-wikipedia');
        repository.finishResearchJob(job.id, 'complete');
        console.log(`[sleeve-notes] Wikipedia biography retained: ${artist.name} (revision ${document.revisionId})`);
      }
      return true;
    } finally { this.running = false; }
  }

  private async fetchReleaseGroup(job: repository.PendingResearchJob): Promise<boolean> {
    const releaseGroupId = job.subjectId.trim();
    if (!releaseGroupId) { repository.finishResearchJob(job.id, 'failed'); return true; }
    this.running = true;
    try {
      console.log(`[sleeve-notes] Wikipedia album lookup: MusicBrainz release group ${releaseGroupId}`);
      repository.markResearchJobRunning(job.id);
      const requestId = repository.startProviderRequest({ provider: 'wikipedia', capability: RELEASE_GROUP_CAPABILITY });
      let document: wikipedia.WikipediaArticleDocument | null;
      try {
        document = await this.sources.fetchWikipediaReleaseGroupDocument(releaseGroupId);
      } catch (error) {
        this.retryProviderRequest(job, requestId, error);
        return true;
      }
      if (!document) {
        repository.finishProviderRequest(requestId, 'no-match');
        repository.finishResearchJob(job.id, 'failed');
        repository.enqueueResearchJob({
          provider: 'genius', subjectType: 'release', subjectId: releaseGroupId,
          capability: 'album-biography', priority: 340,
          originLocalTrackId: job.originLocalTrackId,
        });
        repository.forwardOperatorResearchRequest(job,'genius','album-biography');
        console.log(`[sleeve-notes] Wikipedia album article unavailable; queued Genius fallback for release group ${releaseGroupId}`);
      } else {
        repository.finishProviderRequest(requestId, 'ready');
        repository.retainSourceDocument({
          entityType: 'release-group', entityId: releaseGroupId, provider: 'wikipedia',
          sourceUrl: document.url, revisionId: document.revisionId,
          contentKind: 'bounded-text', content: document.text, attribution: document.attribution,
        });
        repository.enqueueResearchJob({
          provider: 'researcher', subjectType: 'release', subjectId: releaseGroupId,
          capability: RELEASE_GROUP_EXTRACTION, priority: 350,
          originLocalTrackId: job.originLocalTrackId,
        });
        repository.forwardOperatorResearchRequest(job,'researcher',RELEASE_GROUP_EXTRACTION);
        repository.finishResearchJob(job.id, 'complete');
        console.log(`[sleeve-notes] Wikipedia album article retained: ${document.title} (release group ${releaseGroupId}, revision ${document.revisionId})`);
      }
      return true;
    } finally { this.running = false; }
  }

  private retryProviderRequest(job: repository.PendingResearchJob, requestId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]) || null;
    repository.finishProviderRequest(requestId, status === 429 ? 'rate-limited' : 'failed', status);
    repository.retryResearchJob(job.id, repository.wikipediaRetryDelay(job.attempts + 1));
    const transient = status === null || status === 408 || status === 429 || status >= 500;
    if (transient) {
      const outageDelay = repository.wikipediaOutageDelay(job.attempts + 1);
      const deferred = repository.deferWikipediaResearchJobs(outageDelay);
      console.warn(`[sleeve-notes] Wikipedia source service unavailable; deferred ${deferred} lookup${deferred === 1 ? '' : 's'} for ${Math.round(outageDelay / 60_000)}m (attempt ${job.attempts + 1}): ${message}`);
    } else {
      console.warn(`[sleeve-notes] Wikipedia lookup retrying: ${message}`);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startWikipediaWorker(quietGate: QuietGate): void {
  if (timer) return;
  const worker = new WikipediaWorker(quietGate);
  timer = setInterval(() => { void worker.runOnce(); }, 5_000);
  timer.unref();
}
