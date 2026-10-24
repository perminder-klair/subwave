import { runResearchDatabaseWork } from './db.js';
// Slow, quiet-time refresh of the curated MusicBrainz Series allowlist. The
// shared MusicBrainz client applies the same global request spacing as identity
// matching, and this worker adds at most one list request per minute.
import * as musicbrainz from '../music/musicbrainz.js';
import * as settings from '../settings.js';
import * as repository from './research-repository.js';
import type { QuietGate } from './musicbrainz-worker.js';
import type { DefaultMusicBrainzSeries } from './musicbrainz-series-catalog.js';

export interface MusicBrainzSeriesLookup {
  lookup(id: string, entityType: DefaultMusicBrainzSeries['entityType']): Promise<musicbrainz.MusicBrainzSeriesSnapshot | null>;
}

export class MusicBrainzSeriesWorker {
  private running = false;

  constructor(
    private readonly quietGate: QuietGate,
    private readonly lookup: MusicBrainzSeriesLookup = { lookup: musicbrainz.lookupMusicBrainzSeries },
  ) {}

  async runOnce(): Promise<boolean> {
    return runResearchDatabaseWork(()=>this.runOnceInner());
  }
  private async runOnceInner(): Promise<boolean> {
    if (this.running || settings.get().djBehaviour.extendedSleeveNotes !== true || settings.get().djBehaviour.sleeveNotesCollectionPaused === true || !this.quietGate.isQuiet()) return false;
    const series = repository.reserveDueMusicBrainzSeries();
    if (!series) return false;
    this.running = true;
    let requestId: string | null = null;
    try {
      console.log(`[sleeve-notes] MusicBrainz Series refresh: ${series.label}`);
      requestId = repository.startProviderRequest({ provider: 'musicbrainz', capability: 'series' });
      const snapshot = await this.lookup.lookup(series.id, series.entityType);
      if (!snapshot) {
        repository.finishProviderRequest(requestId, 'no-match', 404);
        repository.deferMusicBrainzSeriesRefresh(series.id, 'MusicBrainz Series was not found or returned an invalid response', 24 * 60 * 60 * 1000);
        console.warn(`[sleeve-notes] MusicBrainz Series unavailable: ${series.label}`);
        return true;
      }
      if (snapshot.members.length === 0) {
        repository.finishProviderRequest(requestId, 'no-match');
        repository.deferMusicBrainzSeriesRefresh(series.id, 'MusicBrainz Series returned no usable members', 24 * 60 * 60 * 1000);
        console.warn(`[sleeve-notes] MusicBrainz Series returned no usable members: ${series.label}`);
        return true;
      }
      const result = repository.retainMusicBrainzSeriesSnapshot(series, snapshot);
      repository.finishProviderRequest(requestId, 'ready');
      console.log(`[sleeve-notes] MusicBrainz Series cached: ${series.label} (${result.members} members; ${result.claimsEnabled} local recognition claims)`);
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const status = Number(message.match(/HTTP\s+(\d{3})/)?.[1]) || null;
      if (requestId) repository.finishProviderRequest(requestId, status === 429 ? 'rate-limited' : 'failed', status);
      const attempts = series.attempts;
      const delayMs = status === 429 || status === 503
        ? repository.musicBrainzOutageDelay(attempts)
        : repository.musicBrainzRetryDelay(attempts);
      repository.deferMusicBrainzSeriesRefresh(series.id, message, delayMs);
      console.warn(`[sleeve-notes] MusicBrainz Series refresh deferred for ${Math.round(delayMs / 60_000)}m: ${series.label} (${message})`);
      return true;
    } finally {
      this.running = false;
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Refresh one allowlisted Series at a time during the existing quiet window. */
export function startMusicBrainzSeriesWorker(quietGate: QuietGate): void {
  if (timer) return;
  const worker = new MusicBrainzSeriesWorker(quietGate);
  void worker.runOnce();
  timer = setInterval(() => { void worker.runOnce(); }, 60_000);
  timer.unref();
}
