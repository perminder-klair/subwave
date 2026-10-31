import { librarySourceKey } from './local-identity.js';
import { runResearchDatabaseWork } from './db.js';
import { enqueueNextGeniusLibrarySeed, librarySeedRecording, associateCachedLibrarySeed } from './genius-seeding.js';
import { cachedGeniusSong, expandGeniusSamples, registerGeniusTraversal,
  traversalHasSource, traversalRecording, geniusTraversalArtistAllowed, knownGeniusSongId, associateCachedGeniusSong } from './genius-traversal.js';
import * as settings from '../settings.js';
import { GeniusProvider, GeniusRequestError } from './genius.js';
import { geniusAccessToken } from './genius-token.js';
import type { FetchLike } from './genius.js';
import type { QuietGate } from './musicbrainz-worker.js';
import * as repository from './research-repository.js';

// A search followed by song detail must survive the shared ten-second spacing.
const REQUEST_WAIT_LIMIT_MS = 12_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60 * 1000;

class GeniusWorkPaused extends Error {}
class GeniusBudgetWait extends Error {
  constructor(readonly waitMs: number) { super('Genius request budget is currently full'); }
}

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export class GeniusResearchWorker {
  private running = false;
  private notBefore = 0;
  private pilotQueued = false;

  constructor(private readonly quietGate: QuietGate) {}

  async runOnce(): Promise<boolean> {
    return runResearchDatabaseWork(()=>this.runOnceInner());
  }
  status() { return { running: this.running, quiet: this.quietGate.isQuiet() }; }

  private async runOnceInner(): Promise<boolean> {
    const token = geniusAccessToken();
    if (this.running || Date.now() < this.notBefore || !this.isEnabled() || !token || !this.quietGate.isQuiet()) return false;
    if (!this.pilotQueued) {
      const queued = repository.enqueueGeniusAlbumPilotJobs();
      if (queued) console.log(`[sleeve-notes] Queued ${queued} encountered albums for the Genius biography pilot`);
      this.pilotQueued = true;
    }
    let job = repository.nextPendingResearchJob('genius', {promotedOnly:true})
      ?? repository.nextPendingResearchJob('genius', { subjectType: 'local-track', capability: 'connections' })
      ?? repository.nextPendingResearchJob('genius', { subjectType: 'recording', capability: 'connections' })
      ?? repository.nextPendingResearchJob('genius', { subjectType: 'release', capability: 'album-biography' })
      ?? repository.nextPendingResearchJob('genius', { capability: 'expand-samples' })
      ?? repository.nextPendingResearchJob('genius', { capability: 'sample-traversal' });
    if (!job) {
      job = repository.nextPendingResearchJob('genius', { capability: 'library-seed' });
      if (!job && enqueueNextGeniusLibrarySeed()) job = repository.nextPendingResearchJob('genius', { capability: 'library-seed' });
    }
    if (!job) return false;
    const recording = job.subjectType === 'local-track' ? repository.localRecordingForGenius(job.subjectId)
      : job.subjectType === 'recording' ? repository.recordingForGenius(job.subjectId) ?? traversalRecording(job.subjectId)
        ?? (job.capability === 'library-seed' ? librarySeedRecording(job.subjectId) : null) : null;
    if (job.capability === 'sample-traversal' && recording && !geniusTraversalArtistAllowed(recording.artist)) {
      repository.finishResearchJob(job.id, 'complete');
      return true;
    }
    const albumSource = job.subjectType === 'release' ? repository.geniusAlbumPilotSource(job.subjectId) : null;
    if (job.subjectType === 'release' && albumSource && (albumSource.songIds?.length ?? 1) < 3
      && repository.geniusAlbumConnectionsPending(job.subjectId)) {
      repository.retryResearchJob(job.id, 60_000);
      return true;
    }
    if ((job.subjectType !== 'release' && !recording) || (job.subjectType === 'release' && !albumSource)) {
      if (job.subjectType === 'release' && repository.geniusAlbumConnectionsPending(job.subjectId)) {
        repository.retryResearchJob(job.id, 60_000);
      } else repository.finishResearchJob(job.id, 'failed');
      return true;
    }

    this.running = true;
    repository.markResearchJobRunning(job.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), job.subjectType === 'release' ? 180_000 : 45_000);
    try {
      if (job.capability === 'expand-samples') {
        if (expandGeniusSamples(job.subjectId)) repository.finishResearchJob(job.id, 'complete');
        else repository.requeueResearchJob(job.id);
        return true;
      }
      if (job.capability === 'sample-traversal' && traversalHasSource(job.subjectId)) {
        repository.finishResearchJob(job.id, 'complete');
        return true;
      }
      const provider = new GeniusProvider(token, this.budgetedFetch(controller.signal,
        job.subjectType === 'release' ? 'album-biography' : 'connections'));
      if (job.subjectType === 'release' && albumSource) {
        const lookup = await provider.fetchAlbumBiography(albumSource.songIds ?? [albumSource.songId],
          { title: albumSource.title, artist: albumSource.artist }, controller.signal);
        const biography = lookup.biography;
        if (biography) {
          repository.retainSourceDocument({
            entityType: 'release-group', entityId: albumSource.releaseGroupId,
            provider: 'genius', sourceUrl: biography.url, revisionId: null,
            contentKind: 'bounded-text', content: biography.text,
            attribution: 'Album description from Genius',
          });
          repository.enqueueResearchJob({
            provider: 'researcher', subjectType: 'release', subjectId: albumSource.releaseGroupId,
            capability: 'extract-genius-album', priority: 325,
            originLocalTrackId: job.originLocalTrackId,
          });
          repository.forwardOperatorResearchRequest(job,'researcher','extract-genius-album');
          console.log(`[sleeve-notes] Genius album biography retained: ${biography.artist} — ${biography.title}`);
        } else {
          console.log(`[sleeve-notes] Genius album biography skipped: ${albumSource.artist} — ${albumSource.title} (${lookup.reason})`);
        }
      } else if (recording) {
        const sourceKey=librarySourceKey();
        const localAtStart = job.subjectType === 'local-track' ? repository.localAttachmentForMatch(job.subjectId) : null;
        const entity = { kind: 'track' as const, title: recording.title, artist: recording.artist ?? undefined };
        const cached = cachedGeniusSong(recording);
        const songId = recording.geniusSongId ?? knownGeniusSongId(recording);
        const result = cached ?? (songId
          ? await provider.fetchSong(songId, entity, controller.signal)
          : await provider.fetch(entity, controller.signal));
        if (job.subjectType === 'local-track') {
          const current = repository.localAttachmentForMatch(job.subjectId);
          if (sourceKey!==librarySourceKey() || !current || current.title !== localAtStart?.title || current.artist !== localAtStart?.artist
            || current.musicbrainzRecordingId !== localAtStart?.musicbrainzRecordingId) {
            if(sourceKey===librarySourceKey())repository.requeueResearchJob(job.id);
            return true;
          }
        }
        if (job.capability === 'library-seed' && !librarySeedRecording(job.subjectId)) {
          repository.finishResearchJob(job.id, 'failed');
          return true;
        }
        if (result) {
          if (!this.isEnabled() || !this.quietGate.isQuiet()) throw new GeniusWorkPaused();
          const localTrackId = job.subjectType === 'local-track' ? job.subjectId : job.originLocalTrackId;
          const reused = cached && localTrackId && (job.capability === 'library-seed'
            ? associateCachedLibrarySeed(localTrackId, result.identity.providerId)
            : associateCachedGeniusSong(localTrackId, result.identity.providerId));
          if (!reused) repository.retainGeniusResult(recording, result);
          // Shared cached sources already have a durable expansion job.
          if (!reused) registerGeniusTraversal(recording, result);
        }
      }
      repository.finishResearchJob(job.id, 'complete');
    } catch (error) {
      if (error instanceof GeniusBudgetWait) {
        repository.retryResearchJob(job.id, error.waitMs);
        this.notBefore = Date.now() + error.waitMs;
      } else if (error instanceof GeniusWorkPaused) {
        repository.requeueResearchJob(job.id);
      } else if (error instanceof GeniusRequestError && (error.status === 401 || error.status === 403)) {
        repository.finishResearchJob(job.id, 'failed');
        console.warn(`[sleeve-notes] Genius ${job.capability} request was denied (HTTP ${error.status})`);
      } else if (error instanceof GeniusRequestError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        repository.finishResearchJob(job.id, 'complete');
        console.log(`[sleeve-notes] Genius ${job.capability} returned HTTP ${error.status}; no source retained`);
      } else {
        repository.retryResearchJob(job.id, retryDelayMs(job.attempts + 1));
      }
    } finally {
      clearTimeout(timeout);
      this.running = false;
    }
    return true;
  }

  private isEnabled(): boolean {
    return settings.get().djBehaviour.extendedSleeveNotes === true && settings.get().djBehaviour.sleeveNotesCollectionPaused !== true
      && settings.get().sleeveNotes.providers.genius.enabled === true;
  }

  private budgetedFetch(signal: AbortSignal, capability: string): FetchLike {
    return async (input, init) => {
      const requestSignal = init?.signal ?? signal;
      let requestId: string | null = null;
      while (!requestId) {
        if (!this.isEnabled() || !this.quietGate.isQuiet()) throw new GeniusWorkPaused();
        if (requestSignal.aborted) throw requestSignal.reason ?? new Error('Genius request aborted');
        const reservation = repository.reserveGeniusProviderRequest(new Date(), capability);
        if ('requestId' in reservation) requestId = reservation.requestId;
        else if (reservation.waitMs > (capability === 'album-biography' ? 65_000 : REQUEST_WAIT_LIMIT_MS)) {
          throw new GeniusBudgetWait(reservation.waitMs);
        }
        else await abortableDelay(reservation.waitMs, requestSignal);
      }
      try {
        const response = await fetch(input, init);
        const outcome = response.status === 429 ? 'rate-limited' : response.ok ? 'ready' : 'failed';
        repository.finishGeniusProviderRequest(requestId, outcome, response.status);
        return response;
      } catch (error) {
        repository.finishGeniusProviderRequest(requestId, 'failed', null);
        throw error;
      }
    };
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let activeWorker: GeniusResearchWorker | null = null;
export function geniusWorkerStatus() { return activeWorker?.status() ?? null; }

/** Start the explicitly enabled, lyrics-free Genius metadata worker. */
export function startGeniusResearchWorker(quietGate: QuietGate): void {
  if (timer) return;
  const worker = new GeniusResearchWorker(quietGate);
  activeWorker = worker;
  timer = setInterval(() => { void worker.runOnce(); }, 2_000);
  timer.unref();
}
