import { librarySourceKey } from './local-identity.js';
import { open, runResearchDatabaseWork } from './db.js';
// Quiet-time, resumable Navidrome sweep for all cached MusicBrainz Series.
// Exact recording and release-group MBIDs attach claims without making the DJ
// wait for provider calls or bulk-enqueueing unrelated biography research.
import * as subsonic from '../music/subsonic.js';
import * as musicbrainz from '../music/musicbrainz.js';
import * as settings from '../settings.js';
import * as repository from './research-repository.js';
import type { QuietGate } from './musicbrainz-worker.js';

const ALBUMS_PER_PASS = 25;
const PASS_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 10 * 60_000;

function titleKey(value: unknown): string {
  return String(value ?? '').replace(/\s*[\[(][^)\]]*(?:remaster|deluxe|expanded|anniversary|edition|reissue|bonus)[^)\]]*[)\]]\s*$/iu, '')
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export class MusicBrainzSeriesLibraryWorker {
  private running = false;
  private retryAfter = 0;

  constructor(
    private readonly quietGate: QuietGate,
    private readonly catalogue: Pick<typeof subsonic, 'getAlbumList' | 'getAlbumWithSongs'> = subsonic,
  ) {}

  async runOnce(): Promise<boolean> {
    return runResearchDatabaseWork(()=>this.runOnceInner());
  }
  private async runOnceInner(): Promise<boolean> {
    if (this.running || Date.now() < this.retryAfter || settings.get().djBehaviour.extendedSleeveNotes !== true || settings.get().djBehaviour.sleeveNotesCollectionPaused === true || !this.quietGate.isQuiet()) return false;
    if (!repository.hasCachedSeriesMembers()) return false;
    const offset = repository.dueSeriesLibraryScanOffset();
    const pending = offset == null ? repository.pendingSeriesLibraryAlbums(ALBUMS_PER_PASS) : [];
    if (offset == null && !pending.length) return false;
    const sourceKey=librarySourceKey();
    this.running = true;
    try {
      const albums: Array<{ id?: string; name?: string; musicBrainzId?: string }> = offset == null ? pending.map(id => ({ id }))
        : await this.catalogue.getAlbumList(offset, ALBUMS_PER_PASS, { requireComplete: true });
      if(sourceKey!==librarySourceKey())return false;
      if (!albums.length) {
        repository.advanceSeriesLibraryScan(null);
        console.log('[sleeve-notes] MusicBrainz Series library sweep complete');
        return true;
      }
      const titles = repository.seriesAlbumTitleHints();
      let linked = 0;
      let processed = 0;
      for (const album of albums) {
        if (!this.quietGate.isQuiet()) break;
        const localAlbumId = String(album?.id ?? '').trim();
        if (!localAlbumId) { processed++; continue; }
        const detail = await this.catalogue.getAlbumWithSongs(localAlbumId, { requireComplete: true });
        if (!detail) throw new Error(`Incomplete Series library album: ${localAlbumId}`);
        const songs = detail.songs.map((song) => ({
          id: String(song?.id ?? '').trim(),
          musicBrainzId: typeof song?.musicBrainzId === 'string' ? song.musicBrainzId.trim().toLowerCase() : null,
        })).filter((song) => song.id);
        const albumMbid = String(detail.album.musicBrainzId ?? album.musicBrainzId ?? '').trim().toLowerCase();
        const mayBeListed = titles.has(titleKey(detail.album.name ?? album.name));
        let releaseGroupMbid: string | null = null;
        if (albumMbid && repository.isCachedSeriesReleaseGroup(albumMbid)) {
          releaseGroupMbid = albumMbid;
        } else if (albumMbid) {
          const cached = repository.cachedSeriesReleaseGroupForRelease(albumMbid);
          if (cached) releaseGroupMbid = cached.releaseGroupMbid;
          else if (mayBeListed) {
            releaseGroupMbid = await musicbrainz.lookupReleaseGroupForRelease(albumMbid);
            repository.cacheSeriesReleaseGroupForRelease(albumMbid, releaseGroupMbid);
          }
        }
        if(sourceKey!==librarySourceKey())return false;
        linked += repository.retainLibrarySeriesClaims({ localAlbumId, releaseGroupMbid, songs });
        repository.observeSeriesLibraryAlbum(open(), { ...detail.album, id: localAlbumId }, detail.songs, true);
        processed++;
        // Persist each completed album so an error later in the page does not replay it.
        if (offset != null) repository.advanceSeriesLibraryScan(offset + processed);
      }
      if (linked) console.log(`[sleeve-notes] MusicBrainz Series library sweep attached ${linked} local claim link${linked === 1 ? '' : 's'} (${processed} albums)`);
      return true;
    } catch (error) {
      // The cursor already records completed albums. A changed-album retry
      // must not wake an otherwise completed full sweep.
      this.retryAfter = Date.now() + RETRY_INTERVAL_MS;
      if (offset != null) repository.deferSeriesLibraryScan(RETRY_INTERVAL_MS);
      console.warn(`[sleeve-notes] MusicBrainz Series library sweep deferred: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    } finally {
      this.running = false;
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMusicBrainzSeriesLibraryWorker(quietGate: QuietGate): void {
  if (timer) return;
  const worker = new MusicBrainzSeriesLibraryWorker(quietGate);
  void worker.runOnce();
  timer = setInterval(() => { void worker.runOnce(); }, PASS_INTERVAL_MS);
  timer.unref();
}
