import {reconcileProvisionalArtists} from './artist-identity.js';
import { librarySourceKey } from './local-identity.js';
import { runResearchDatabaseWork } from './db.js';
// Bounded recurring catalogue reconciliation. New tracks can resolve old
// connections without queuing biography research or querying Genius again.
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import * as settings from '../settings.js';
import * as subsonic from '../music/subsonic.js';
import { open } from './db.js';
import { observeSeriesLibraryAlbum } from './research-repository.js';
import { cacheConnectionLibraryTracks, connectionRevision } from './library-connections.js';
import { reconcileConnectionsInBackground } from './connection-compute.js';
import type { QuietGate } from './musicbrainz-worker.js';

const ALBUMS_PER_PASS = 10;
const PASS_INTERVAL_MS = 30_000;
const SWEEP_INTERVAL_MS = 15 * 60_000;
const MATCH_INTERVAL_MS = 5 * 60_000;
const RETRY_INTERVAL_MS = 10 * 60_000;
interface Catalogue {
  getAlbumList: typeof subsonic.getAlbumList;
  getAlbumWithSongs: typeof subsonic.getAlbumWithSongs;
  getScanStatus: typeof subsonic.getScanStatus;
}

export class ConnectionLibraryWorker {
  private running = false;
  private lastFactsRevision = -1;
  private matchRunAfter = 0;
  private nextArtistRepair = 0;
  private artistRepairCursor = '';
  constructor(
    private readonly quietGate: QuietGate,
    private readonly catalogue: Catalogue = subsonic,
    private readonly database: () => Database.Database = open,
    private readonly enabled = () => settings.get().djBehaviour.extendedSleeveNotes === true && settings.get().djBehaviour.sleeveNotesCollectionPaused !== true,
    private readonly reconcile = reconcileConnectionsInBackground,
  ) {}

  private async reconcileIfChanged(db: Database.Database, nowMs: number): Promise<void> {
    if (!this.quietGate.isQuiet() || nowMs < this.matchRunAfter || connectionRevision(db, 'facts') === this.lastFactsRevision) return;
    // Batch non-critical index changes. Reserve before starting so a rejected
    // stale snapshot cannot cause another full rebuild on the next 30s tick.
    this.matchRunAfter = nowMs + MATCH_INTERVAL_MS;
    try {
      const published = await this.reconcile(db);
      if (published !== null) this.lastFactsRevision = published;
    } catch (error) { this.matchRunAfter = nowMs + RETRY_INTERVAL_MS; throw error; }
  }

  async runOnce(nowMs = Date.now()): Promise<boolean> {
    return runResearchDatabaseWork(()=>this.runOnceInner(nowMs));
  }
  private async runOnceInner(nowMs:number): Promise<boolean> {
    if (this.running || !this.enabled() || !this.quietGate.isQuiet()) return false;
    this.running = true;
    let db: Database.Database | null = null;
    try {
      const sourceKey=librarySourceKey();
      const assertAllowed=()=>{
        if(sourceKey!==librarySourceKey())throw new Error('Music library changed; catalogue scan will restart');
        if(!this.enabled() || !this.quietGate.isQuiet())throw new Error('Catalogue scan paused for settings or broadcast work');
      };
      const database = this.database();
      db = database;
      if (nowMs >= this.nextArtistRepair) {
        this.nextArtistRepair = nowMs + MATCH_INTERVAL_MS;
        this.artistRepairCursor = reconcileProvisionalArtists(database, this.artistRepairCursor);
      }
      let scan = database.prepare(`SELECT generation, album_offset AS albumOffset, run_after AS runAfter
        FROM sleeve_connection_library_scan WHERE id = 1`).get() as {
          generation: string; albumOffset: number; runAfter: string | null;
        } | undefined;
      if (scan?.runAfter && Date.parse(scan.runAfter) > nowMs) {
        await this.reconcileIfChanged(database, nowMs);
        return false;
      }
      if (!scan || scan.albumOffset === 0) {
        const generation = randomUUID();
        database.prepare(`INSERT INTO sleeve_connection_library_scan (id, generation, album_offset)
          VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation,
            album_offset = 0, run_after = NULL`).run(generation);
        scan = { generation, albumOffset: 0, runAfter: null };
      }
      if (await this.catalogue.getScanStatus() === true) {
        database.prepare('UPDATE sleeve_connection_library_scan SET album_offset = 0 WHERE id = 1').run();
        throw new Error('Navidrome is still scanning; connection library sweep deferred');
      }
      assertAllowed();
      const albums = await this.catalogue.getAlbumList(scan.albumOffset, ALBUMS_PER_PASS, { requireComplete: true });
      assertAllowed();
      if (!albums.length) {
        const seen = (database.prepare(`SELECT COUNT(*) AS count FROM sleeve_connection_library_tracks
          WHERE scan_generation = ?`).get(scan.generation) as { count: number }).count;
        const total = (database.prepare('SELECT COUNT(*) AS count FROM sleeve_connection_library_tracks').get() as { count: number }).count;
        if (!seen && total) throw new Error('Empty catalogue sweep cannot replace existing connection matches');
        const scanning = await this.catalogue.getScanStatus();
        if (scanning === true) {
          database.prepare('UPDATE sleeve_connection_library_scan SET album_offset = 0 WHERE id = 1').run();
          throw new Error('Navidrome scan began during the connection sweep');
        }
        if (scanning === null && total > seen) throw new Error('Navidrome scan status is unknown; keeping existing connection matches');
        assertAllowed();
        database.transaction(() => {
          database.prepare(`DELETE FROM sleeve_connection_library_matches WHERE local_track_id IN (
            SELECT local_track_id FROM sleeve_connection_library_tracks WHERE scan_generation <> ?)`)
            .run(scan!.generation);
          database.prepare('DELETE FROM sleeve_connection_library_tracks WHERE scan_generation <> ?').run(scan!.generation);
          database.prepare('DELETE FROM sleeve_series_library_albums WHERE scan_generation IS NOT ?').run(scan!.generation);
          database.prepare(`UPDATE sleeve_connection_library_scan SET album_offset = 0, completed_at = ?, run_after = ?
            WHERE id = 1`).run(new Date(nowMs).toISOString(), new Date(nowMs + SWEEP_INTERVAL_MS).toISOString());
        })();
        await this.reconcileIfChanged(database, nowMs);
        console.log(`[sleeve-notes] Connection library sweep complete (${seen} tracks)`);
        return true;
      }
      for (const album of albums) {
        if (!this.quietGate.isQuiet()) break;
        const id = typeof album?.id === 'string' ? album.id.trim() : '';
        if (!id) throw new Error('Malformed album in connection library sweep');
        const detail = await this.catalogue.getAlbumWithSongs(id, { requireComplete: true });
        assertAllowed();
        if (!detail || !Array.isArray(detail.songs)) throw new Error(`Incomplete connection library album: ${id}`);
        if (detail.songs.some((song) => !song?.id || !song?.title)) throw new Error(`Malformed connection library tracks: ${id}`);
        if (await this.catalogue.getScanStatus() === true) {
          database.prepare('UPDATE sleeve_connection_library_scan SET album_offset = 0 WHERE id = 1').run();
          throw new Error('Navidrome scan began during the connection sweep');
        }
        assertAllowed();
        database.transaction(() => {
          observeSeriesLibraryAlbum(database, { ...detail.album, id }, detail.songs, false, scan!.generation);
          cacheConnectionLibraryTracks(database, detail.songs.map((song) => ({
            id: String(song.id), title: String(song.title), artist: String(song.artist ?? ''),
            album: typeof song.album === 'string' ? song.album : null,
            musicbrainzId: typeof song.musicBrainzId === 'string' ? song.musicBrainzId : null,
          })), scan!.generation);
          scan!.albumOffset++;
          database.prepare(`UPDATE sleeve_connection_library_scan SET album_offset = ?, run_after = NULL WHERE id = 1`)
            .run(scan!.albumOffset);
        })();
      }
      await this.reconcileIfChanged(database, nowMs);
      return true;
    } catch (error) {
      try {
        db?.prepare(`UPDATE sleeve_connection_library_scan SET run_after = ? WHERE id = 1`)
          .run(new Date(nowMs + RETRY_INTERVAL_MS).toISOString());
      } catch { /* The next timer tick retries an unavailable store. */ }
      console.warn(`[sleeve-notes] Connection library matching deferred: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally { this.running = false; }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startConnectionLibraryWorker(quietGate: QuietGate): void {
  if (timer) return;
  const worker = new ConnectionLibraryWorker(quietGate);
  void worker.runOnce();
  timer = setInterval(() => { void worker.runOnce(); }, PASS_INTERVAL_MS);
  timer.unref();
}
