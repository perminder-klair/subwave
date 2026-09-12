// The Spotify "library": SUB/WAVE's catalog on Spotify is a POOL the operator
// curates — their playlists (settings.spotify.pool.playlistIds, or every playlist
// they own when empty) plus, optionally, their saved tracks and saved albums.
// Spotify's catalog is unbounded, so random/genre/browse/walk all need a finite
// set to draw from, and this is it.
//
// The pool is memoised for POOL_TTL_MS, single-flight, and PERSISTED
// (pool-store.ts). The client is INJECTED so every path is testable against
// canned pages (scripts/spotify-source.test.ts).
//
// THREE RULES SHAPE THIS FILE, and all three exist because Development Mode's
// rolling 30-second quota is permanent here — extended quota is
// organisations-only (≥250k MAU), so the fix for a rate limit is always FEWER
// REQUESTS, never more retry.
//
// 1. A RESTART MUST COST NOTHING. The pool used to live only in memory, so every
//    restart re-walked every playlist and every saved track: ~100 back-to-back
//    requests for a 5000-track pool, and Docker restart policies made that a
//    loop. The snapshot on disk is loaded before the first get() answers, and a
//    stale one is SERVED WHILE it refreshes behind — the station is playing
//    before it has spoken to Spotify at all.
//
// 2. A REFRESH REVALIDATES, IT DOES NOT REBUILD. Every row of GET /me/playlists
//    carries `snapshot_id`, Spotify's own marker for "these contents did not
//    change" — and the pool already walks that listing, so the signal is free.
//    An unchanged playlist keeps its rows instead of being re-walked, and saved
//    tracks/albums are checked with a one-item probe for count + newest id. A
//    steady-state refresh drops from ~100 requests to a handful. Spotify's own
//    rate-limit page names snapshot_id as the mitigation. A FULL walk still runs
//    on `spotify.pool.fullWalkHours`, because a count-plus-newest-id fingerprint
//    cannot see a swap that keeps both.
//
// 3. ARTIST GENRES ARE A DRIP, NOT A BURST. Spotify tags ARTISTS, never tracks,
//    and February 2026 removed the batch read (GET /artists?ids=) — not restored
//    in the July 2026 changelog either — so genres cost ONE REQUEST PER ARTIST,
//    low thousands on a 5000-track pool. Three things make that affordable:
//      • the cache is PERSISTED (state/spotify/artist-genres.json). Artist
//        genres do not change, so on disk this is a one-time cost for the life
//        of the station.
//      • the fill is a paced BACKGROUND DRIP (`spotify.quota.genresPerHour`)
//        that runs on its own rather than inside a build. Bolted to builds it
//        managed at most one budget per thirty minutes, and NONE AT ALL while
//        the gate was closed — because get() correctly refuses to rebuild then,
//        so the one job that could still make progress was switched off exactly
//        when it had the most time to do it in.
//      • it stands down the instant the client's shared gate closes, and an
//        unfilled genre is `genresPending`, NOT `partial` — enrichment that has
//        not finished is not a broken pool, and conflating the two would drive
//        the empty-pool retry and the doctor.
//
// A miss is remembered as a miss so it is not re-queried every pass.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Song, Album } from '../types.js';
import type { SpotifyClient } from './client.js';
import { mapTrack, mapAlbum, unwrapItem } from './map.js';
import { albumEraSuspect } from '../../era-suspect.js';
import { mapPool } from '../../../util/async-pool.js';
import { writeFileAtomic } from '../../../util/atomic-file.js';
import { SPOTIFY_STATE_DIR } from './token-file.js';
import { listMyPlaylists, invalidateSpotifyReads } from './reads.js';
import { unplayableIds } from './unplayable-file.js';
import {
  SPOTIFY_POOL_PATH, SRC_SAVED_TRACKS, SRC_SAVED_ALBUMS, POOL_SNAPSHOT_VERSION,
  compactTrack, expandTrack, compactAlbum, expandAlbum, readSnapshot, writeSnapshot,
  type PoolSnapshot, type SnapshotPlaylist, type SavedFingerprint,
} from './pool-store.js';

export const POOL_TTL_MS = 30 * 60 * 1000;

// A build that produced NOTHING is not worth half an hour of silence: the
// transport's fallback reads an empty pool as "nothing to play" and the dead-air
// guard covers the air until the memo lapses. Retry soon instead.
export const POOL_EMPTY_RETRY_MS = 2 * 60 * 1000;

// Spotify's page cap. Asking for more is not clamped politely — the server
// trims the page and `paginate` reads a short page as the last one.
const PAGE = 50;

// NEW artists a single BUILD may look up, on top of whatever the drip is doing.
// A first-ever pool should not be genre-less, but the drip is what actually
// converges, and a build is already the most expensive thing the station does.
export const ARTIST_GENRE_BUDGET = 100;
// Concurrent GET /artists/{id} calls during a genre fill. Low on purpose — the
// client's pacer bounds the rate anyway, so width here buys very little and
// costs a deeper hole when the limit does bite.
const ARTIST_FETCH_CONCURRENCY = 2;

// How often the background drip wakes. The per-tick batch is derived from
// `spotify.quota.genresPerHour`, so this is only the granularity.
export const GENRE_DRIP_INTERVAL_MS = 60_000;
// How long an artist whose lookup failed for a non-429 reason is stood down.
// Long enough that a permanently broken id cannot dominate the ranked queue,
// short enough that a blip costs one artist a few minutes of enrichment.
export const GENRE_RETRY_BACKOFF_MS = 30 * 60_000;

// Where the persisted genre cache lives. Not a credential, so no 0600 — and
// deliberately NOT in routes/backup.ts's INCLUDE_FILES: it is a cache, and it
// should rebuild rather than restore.
export const ARTIST_GENRE_CACHE_PATH = path.join(SPOTIFY_STATE_DIR, 'artist-genres.json');

export interface PoolConfig {
  playlistIds: string[];
  includeSaved: boolean;
  includeSavedAlbums: boolean;
  // Hard cap on tracks per build — a runaway playlist set must not turn every
  // rebuild into thousands of requests.
  maxTracks: number;
  // How stale a snapshot may get before a revalidate is replaced by a full walk.
  fullWalkHours: number;
  // Artist-genre enrichment rate for the background drip; 0 = off.
  genresPerHour: number;
}

export interface SpotifyPool {
  tracks: Map<string, Song>;
  albums: Map<string, Album>;
  // artist id → genres
  artistGenres: Map<string, string[]>;
  // genre → track count
  genres: Map<string, number>;
  playlists: SnapshotPlaylist[];
  builtAt: number;
  // When the last FULL catalogue walk ran. Separate from `builtAt`, which a
  // cheap revalidate also moves: if the full-walk clock rode on builtAt, every
  // revalidate would postpone the walk it is an alternative to, and the full
  // walk would never happen again.
  walkedAt: number;
  partial: boolean; // true when a source page failed — the pool is still usable
  // Why it is partial, in operator words. `partial` alone sent the admin UI to
  // the container logs to find out what broke, which is where an afternoon of
  // 403s went unread; these ride out on /settings/spotify instead.
  notes: string[];
  // Artists in the pool whose genres are not looked up yet. Enrichment still to
  // do — NOT a fault, and deliberately not folded into `partial`, which drives
  // the empty-pool retry and the doctor.
  genresPending: number;
  // The walk stopped at `maxTracks` rather than at the end of the operator's
  // playlists, so this pool is a PREFIX of the library, not the library. Unlike
  // `partial` this is not a failure and nothing should retry over it — but it
  // does mean the walk can never be read as "everything that exists", which is
  // what the orphan reconcile needs (music/prune-policy.ts).
  truncated: boolean;
  // The pool definition it was built from; a settings edit changes it and the
  // next get() rebuilds rather than serving a stale curation.
  cfgSig: string;
  // Fingerprints the next revalidate compares against.
  savedTracks: SavedFingerprint | null;
  savedAlbums: SavedFingerprint | null;
  // When the genre drip last ran, and why it did nothing if it did nothing.
  // A silent early return that fires every minute is how "0 of 123 tagged"
  // survived eight hours with no log line and nothing on the admin card to
  // explain it — the operator could not tell a paused drip from a finished one.
  dripAt: number;
  dripSkip: string | null;
  // This pool came off disk and has NOT been confirmed against Spotify in this
  // process. Load-bearing for catalogHealth(): the orphan reconcile deletes the
  // tags, moods and vectors of every track a walk did not yield, and a snapshot
  // is by definition a walk that happened in some earlier process.
  fromDisk: boolean;
}

export function poolConfigSignature(cfg: PoolConfig): string {
  // Deliberately only the CURATION. `fullWalkHours` and `genresPerHour` are
  // pacing knobs: changing one must not throw the pool away and re-walk the
  // whole catalogue, which is the exact cost they exist to control.
  return JSON.stringify([[...cfg.playlistIds].sort(), cfg.includeSaved, cfg.includeSavedAlbums, cfg.maxTracks]);
}

// Era suspicion, stamped from the pool's own MAPPED rows rather than from the
// raw Spotify objects. That is what lets a revalidate treat reused rows and
// freshly-walked ones identically: a reused row still carries `albumType` and
// its joined `artist` string, which is everything albumEraSuspect() reads. Same
// call the Navidrome walk makes, on the same facts.
export function stampEraSuspicion(tracks: Map<string, Song>, albums: Map<string, Album>): void {
  const byAlbum = new Map<string, Song[]>();
  for (const s of tracks.values()) {
    if (!s.albumId) continue;
    const list = byAlbum.get(s.albumId) ?? [];
    list.push(s);
    byAlbum.set(s.albumId, list);
  }
  for (const [albumId, songs] of byAlbum) {
    const album = albums.get(albumId);
    const suspicion = albumEraSuspect({
      isCompilation: songs[0]?.albumType === 'compilation' ? true : null,
      albumArtist: album?.artist ?? null,
      title: album?.name ?? null,
      year: album?.year ?? null,
      trackArtists: songs.map((s) => String(s.artist ?? '')),
    });
    for (const s of songs) {
      s.albumIsCompilation = s.albumIsCompilation || (suspicion.suspect && suspicion.reason === 'compilation-flag');
      s.albumEraUntrusted = suspicion.suspect;
      s.albumEraReason = suspicion.reason;
    }
  }
}

export class SpotifyPoolCache {
  private pool: SpotifyPool | null = null;
  // Everything the last walk (or snapshot) actually yielded, BEFORE refused
  // tracks are withheld. `pool.tracks` is what the station reads; this is what
  // the snapshot is written from and what a cleared refusal list is restored
  // from, so forgetting a refusal costs no catalogue requests. The Song objects
  // are shared by reference with `pool.tracks`, so this is one extra Map of
  // pointers, not a second copy of the library.
  private walked: Map<string, Song> | null = null;
  private refreshing: Promise<SpotifyPool> | null = null;
  private snapshotLoaded = false;
  // Set by invalidate(): the next refresh must happen even if the pool looks
  // fresh, because something changed underneath it (the account, or an operator
  // asking). Cleared by the refresh that honours it.
  private forceRefresh = false;
  private dripTimer: NodeJS.Timeout | null = null;
  // artist id → genres, or null for "asked, Spotify had nothing". Deliberately
  // OUTSIDE the pool object: it survives invalidate() and every rebuild, and it
  // is mirrored to disk, which together are what make one-request-per-artist
  // affordable at all.
  private readonly genreCache = new Map<string, string[] | null>();
  // Artist ids whose lookup FAILED for a reason that was not a 429, and the
  // time they may be tried again. `rankedArtists` is a stable sort, so without
  // this the drip recomputed the identical `missing` list every tick and sliced
  // the identical first batch — a persistently failing head of the list blocked
  // every artist behind it forever, showing "+0, N still pending" once a minute
  // and never reaching artist N+1. Deliberately in memory only: it is a backoff,
  // not a verdict, and a restart should retry.
  private readonly genreRetryAfter = new Map<string, number>();
  private genreCacheLoaded = false;
  private genreCacheDirty = false;

  constructor(
    private readonly client: () => SpotifyClient,
    private readonly cfg: () => PoolConfig,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
    // Injected so the tests can drive the persisted caches without a state dir.
    private readonly cachePath: string = ARTIST_GENRE_CACHE_PATH,
    private readonly snapshotPath: string = SPOTIFY_POOL_PATH,
  ) {}

  // Drop the pool AND the shared catalogue reads it was built from. The two must
  // go together: every caller of invalidate() is an event that changed the
  // ACCOUNT (a connect, a pasted token, a disconnect) or an operator explicitly
  // asking for fresh data, and a rebuild that re-used a five-minute-old playlist
  // listing would answer the wrong question.
  //
  // The snapshot on disk is left alone: the rebuild that follows overwrites it,
  // and deleting it first would leave a failed rebuild with nothing at all.
  // NOTE WHAT THIS DOES NOT DO: it does not throw the pool away.
  //
  // It used to — `this.pool = null` plus `snapshotLoaded = true` — and that
  // made the admin's "Rebuild pool now" button a live grenade. Pressed while
  // Spotify was refusing requests, it discarded the working library BEFORE
  // attempting anything, every call in the rebuild was then refused, an empty
  // pool was published, and the good snapshot on disk had been marked as
  // already-read so it could never be served again. The station went to dead
  // air on the emergency loop and only a restart could get it back. It is also
  // the button the doctor's own hint sent operators to press.
  //
  // So this marks the pool as needing a refresh and drops the shared catalogue
  // reads it was built from; the replacement is swapped in by `finish()` only
  // once there is one.
  invalidate(): void {
    this.forceRefresh = true;
    invalidateSpotifyReads();
  }

  peek(): SpotifyPool | null { return this.pool; }

  // Wait for any refresh started behind a stale-but-usable pool to finish.
  // get() deliberately does NOT await that one — serving the station is the
  // point — so anything that needs the refreshed answer rather than a fast one
  // (a test, an operator action reporting a result) says so explicitly.
  async settled(): Promise<void> {
    try { await this.refreshing; } catch { /* refresh() already logged and kept the old pool */ }
  }

  // How long the current pool may be served. An EMPTY pool is dead air whatever
  // the reason, so it is held only briefly — the failure need not have announced
  // itself as one. Two builds returned `0 tracks, 0 playlists` with `partial:
  // false` (an empty /me/playlists reads as a successful walk), and gating the
  // short retry on `partial` earned each of those thirty minutes of silence.
  // get() already refuses to rebuild while the rate-limit gate is closed, so
  // this cannot become a hammer loop.
  private ttlFor(p: SpotifyPool): number {
    return p.tracks.size === 0 ? POOL_EMPTY_RETRY_MS : POOL_TTL_MS;
  }

  private fullWalkMs(): number {
    const h = Number(this.cfg().fullWalkHours);
    return (Number.isFinite(h) && h > 0 ? h : 24) * 3_600_000;
  }

  async get(): Promise<SpotifyPool> {
    await this.loadSnapshot();
    const p = this.pool;
    const sig = poolConfigSignature(this.cfg());
    if (p && !this.forceRefresh && p.cfgSig === sig && this.now() - p.builtAt < this.ttlFor(p)) return p;
    // Never refresh into a closed rate-limit gate. The short empty-pool retry
    // exists so a transient failure costs one track instead of half an hour —
    // but if the emptiness IS the rate limit, retrying every two minutes is just
    // the same storm on a timer. Serve what we have and wait it out.
    if (p && this.client().rateLimitedForMs() > 0) return p;
    // A pool that is merely STALE is served now and refreshed behind it. This is
    // what the snapshot is for: a restarted station answers its first pick from
    // disk instead of waiting on a catalogue walk.
    //
    // Two pools may NOT be served that way. One built from a DIFFERENT curation
    // is the wrong library, and an EMPTY one is not an answer at all — handing
    // it back while a refresh runs behind would turn POOL_EMPTY_RETRY_MS into a
    // timer that never puts music back on, which is the opposite of why that
    // short window exists. Both wait for the refresh.
    if (p && p.cfgSig === sig && p.tracks.size > 0) {
      void this.startRefresh().catch(() => {});
      return p;
    }
    return this.startRefresh();
  }

  // Force a FULL walk — the "Rebuild pool now" button. It bypasses the
  // revalidate path entirely: an operator pressing it is saying they do not
  // trust what is cached, and answering with a snapshot_id comparison against
  // that same cache would be answering a different question.
  async rebuild(): Promise<SpotifyPool> {
    this.invalidate();
    return this.startRefresh(true);
  }

  // Whether a refresh is owed regardless of the TTL — read by refresh() and
  // cleared there, so a failed attempt still owes one.
  private takeForceRefresh(): boolean {
    const owed = this.forceRefresh;
    this.forceRefresh = false;
    return owed;
  }

  private startRefresh(force = false): Promise<SpotifyPool> {
    if (!this.refreshing) {
      this.refreshing = this.refresh(force).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async refresh(force: boolean): Promise<SpotifyPool> {
    const p = this.pool;
    const sig = poolConfigSignature(this.cfg());
    const forced = this.takeForceRefresh();
    const fullDue = force
      || forced
      || !p
      || p.cfgSig !== sig
      || p.tracks.size === 0
      || this.now() - p.walkedAt >= this.fullWalkMs();
    try {
      return fullDue ? await this.build() : await this.revalidate(p!);
    } catch (err: any) {
      // A refresh that throws must never take the pool with it — the station is
      // playing off it. Keep what we have and say what happened.
      this.log(`[spotify] pool refresh failed: ${err?.message ?? err}`);
      if (!p) throw err;
      // …but hold the retry off, or the pool stays stale, every get() starts
      // another refresh, and a persistent failure becomes one attempt per pick.
      // The short empty-pool window is the house figure for "try again soon".
      p.builtAt = this.now() - this.ttlFor(p) + POOL_EMPTY_RETRY_MS;
      return p;
    }
  }

  // ── persisted pool snapshot ────────────────────────────────────────────────

  private async loadSnapshot(): Promise<void> {
    if (this.snapshotLoaded) return;
    this.snapshotLoaded = true;
    if (this.pool) return;
    const snap = await readSnapshot(this.snapshotPath, this.log);
    if (!snap) return;
    if (snap.cfgSig !== poolConfigSignature(this.cfg())) {
      this.log('[spotify] the pool definition changed since the snapshot was written — rebuilding rather than serving the old curation');
      return;
    }
    await this.loadGenreCache();
    const tracks = new Map<string, Song>();
    for (const row of snap.tracks) {
      const s = expandTrack(row, (id) => (id ? this.genreCache.get(id) ?? [] : []));
      if (s) tracks.set(s.id, s);
    }
    const albums = new Map<string, Album>();
    for (const row of snap.albums) {
      const a = expandAlbum(row);
      if (a) albums.set(a.id, a);
    }
    const pendingArtists = [...new Set([...tracks.values()].map((s) => s.artistId).filter(Boolean))] as string[];
    this.walked = tracks;
    const published = this.publishable(tracks);
    this.pool = {
      tracks: published, albums,
      ...this.deriveGenreMaps(published),
      playlists: snap.playlists,
      builtAt: snap.builtAt,
      walkedAt: snap.builtAt,
      partial: snap.partial,
      notes: snap.notes,
      truncated: snap.truncated,
      genresPending: pendingArtists.filter((id) => !this.genreCache.has(id)).length,
      dripAt: 0,
      dripSkip: null,
      cfgSig: snap.cfgSig,
      savedTracks: snap.savedTracks,
      savedAlbums: snap.savedAlbums,
      fromDisk: true,
    };
    const age = Math.round((this.now() - snap.builtAt) / 60_000);
    this.log(`[spotify] pool restored from disk: ${tracks.size} tracks, ${albums.size} albums, ${snap.playlists.length} playlists, written ${age}m ago — no catalogue requests spent`);
  }

  private async saveSnapshot(p: SpotifyPool): Promise<void> {
    const snap: PoolSnapshot = {
      version: POOL_SNAPSHOT_VERSION,
      cfgSig: p.cfgSig,
      builtAt: p.builtAt,
      partial: p.partial,
      notes: p.notes,
      truncated: p.truncated,
      playlists: p.playlists,
      savedTracks: p.savedTracks,
      savedAlbums: p.savedAlbums,
      tracks: [...p.tracks.values()].map(compactTrack),
      albums: [...p.albums.values()].map(compactAlbum),
    };
    await writeSnapshot(snap, this.snapshotPath, this.log);
  }

  // ── persisted genre cache ──────────────────────────────────────────────────
  //
  // Load-once, repair rows, never block boot: a missing file is the normal first
  // run and a corrupt one starts empty rather than wedging the station
  // (music/blocklist.ts's load() is the pattern).
  private async loadGenreCache(): Promise<void> {
    if (this.genreCacheLoaded) return;
    this.genreCacheLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.cachePath, 'utf8'));
      let kept = 0;
      for (const [id, genres] of Object.entries(raw ?? {})) {
        if (typeof id !== 'string' || !id) continue;
        if (genres === null) { this.genreCache.set(id, null); kept++; continue; }
        if (Array.isArray(genres)) { this.genreCache.set(id, genres.map(String)); kept++; }
      }
      if (kept) this.log(`[spotify] artist genre cache: ${kept} artists loaded from disk`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') this.log(`[spotify] artist genre cache unreadable, starting empty: ${err?.message ?? err}`);
    }
  }

  private async saveGenreCache(): Promise<void> {
    if (!this.genreCacheDirty) return;
    this.genreCacheDirty = false;
    try {
      mkdirSync(path.dirname(this.cachePath), { recursive: true });
      await writeFileAtomic(this.cachePath, JSON.stringify(Object.fromEntries(this.genreCache)));
    } catch (err: any) {
      // A cache that cannot be written is slower, not broken.
      this.log(`[spotify] artist genre cache could not be saved: ${err?.message ?? err}`);
    }
  }

  // Artists in the pool, busiest first — coverage per request is the whole game
  // when each genre costs a request and the queue is thousands long.
  private rankedArtists(p: SpotifyPool): string[] {
    const trackCount = new Map<string, number>();
    for (const s of p.tracks.values()) {
      if (s.artistId) trackCount.set(s.artistId, (trackCount.get(s.artistId) ?? 0) + 1);
    }
    return [...trackCount.keys()].sort((a, b) => (trackCount.get(b) ?? 0) - (trackCount.get(a) ?? 0));
  }

  // Look up genres for at most `budget` artists, busiest first.
  //
  // Returns how many artists still have no entry afterwards, which is the pool's
  // `genresPending`. Note what this does NOT do: it never reports a failure as a
  // broken pool, and it stops the moment the client's shared gate closes rather
  // than grinding the remaining queue into a live rate limit.
  private async fetchArtistGenres(ranked: string[], budget: number): Promise<{ filled: number; pending: number }> {
    await this.loadGenreCache();
    // `pending` counts everything still unknown; `ready` is what may be TRIED
    // now. The two differ by the ids in backoff, and reporting the first while
    // spending on the second is what keeps the progress line honest.
    const missing = ranked.filter((id) => !this.genreCache.has(id));
    if (!missing.length || budget <= 0) return { filled: 0, pending: missing.length };
    const now = this.now();
    const ready = missing.filter((id) => (this.genreRetryAfter.get(id) ?? 0) <= now);
    if (!ready.length) return { filled: 0, pending: missing.length };

    const c = this.client();
    const batch = ready.slice(0, budget);
    let done = 0;
    let limited = false;

    await mapPool(batch, ARTIST_FETCH_CONCURRENCY, async (id) => {
      // One worker hitting the limit ends the pass for all of them; the client
      // would refuse these anyway, and asking is how a limit renews itself.
      if (limited || c.rateLimitedForMs() > 0) { limited = true; return; }
      try {
        const a: any = await c.getArtist(id, { background: true });
        this.genreCache.set(id, Array.isArray(a?.genres) ? a.genres.map(String) : null);
        this.genreCacheDirty = true;
        done++;
      } catch (err: any) {
        // A 429 is transient and must NOT be cached as a miss, or the artist is
        // written off permanently over a moment — and it must not count as this
        // artist's fault either, so it earns no backoff.
        if (err?.status === 429) { limited = true; return; }
        // Anything else already resolved to null via allow404, so this is a
        // genuine failure. Stand this id down for a while so it cannot hold the
        // whole ranked queue behind it.
        this.genreRetryAfter.set(id, this.now() + GENRE_RETRY_BACKOFF_MS);
      }
    });

    await this.saveGenreCache();
    const pending = ranked.filter((id) => !this.genreCache.has(id)).length;
    if (done || pending) {
      const held = c.rateLimitedForMs();
      const why = limited && held > 0 ? `, paused ${Math.ceil(held / 1000)}s by Spotify's rate limit` : '';
      this.log(`[spotify] artist genres: +${done}, ${pending} still pending${why}`);
    }
    return { filled: done, pending };
  }

  // ── the background genre drip ──────────────────────────────────────────────

  // One pass of enrichment against the pool already in memory. Deliberately
  // takes NO rebuild: bolted to build(), the fill was capped at one budget per
  // thirty minutes and — worse — stopped entirely while the rate-limit gate was
  // closed, because get() refuses to rebuild then.
  async dripGenresOnce(): Promise<{ filled: number; pending: number }> {
    // Load the snapshot if nothing has yet: the drip reads the in-memory pool
    // directly, and only get() used to populate it — so on a station whose pick
    // paths had not run, enrichment was dead and reported `pending: 0`, which
    // the admin card renders as "finished".
    await this.loadSnapshot();
    const p = this.pool;
    const skip = (why: string, pending: number) => {
      if (p) { p.dripAt = this.now(); p.dripSkip = why; }
      return { filled: 0, pending };
    };
    if (!p || !p.tracks.size) return skip('the pool is empty', 0);
    const perHour = Number(this.cfg().genresPerHour);
    if (!Number.isFinite(perHour) || perHour <= 0) {
      return skip('genre enrichment is switched off (spotify.quota.genresPerHour is 0)', p.genresPending);
    }
    // Stand down while Spotify is holding us off, and resume by ourselves when
    // it clears — no rebuild, no operator action, nothing to re-arm.
    const held = this.client().rateLimitedForMs();
    if (held > 0) {
      return skip(`paused — Spotify is holding the station off for another ${Math.ceil(held / 1000)}s`, p.genresPending);
    }

    const batch = Math.max(1, Math.round((perHour * GENRE_DRIP_INTERVAL_MS) / 3_600_000));
    const { filled, pending } = await this.fetchArtistGenres(this.rankedArtists(p), batch);
    p.genresPending = pending;
    p.dripAt = this.now();
    p.dripSkip = filled || !pending ? null : 'asked, but Spotify returned nothing usable';
    if (filled) {
      // Re-stamp the LIVE pool, so genre browsing and genre picking sharpen as
      // the drip runs rather than in thirty-minute steps at the next rebuild.
      // The SNAPSHOT is deliberately not rewritten here: genres are derived and
      // stripped from it (pool-store.ts), so a multi-MB atomic rewrite every
      // minute would carry exactly zero new information. saveGenreCache() has
      // already persisted the part that changed.
      this.restampGenres(p);
    }
    return { filled, pending };
  }

  // Start the drip. Idempotent, and unref'd so it never holds the process open.
  startGenreDrip(intervalMs = GENRE_DRIP_INTERVAL_MS): void {
    if (this.dripTimer) return;
    this.dripTimer = setInterval(() => {
      this.dripGenresOnce().catch((err: any) => this.log(`[spotify] genre drip failed: ${err?.message ?? err}`));
    }, intervalMs);
    (this.dripTimer as any).unref?.();
  }

  stopGenreDrip(): void {
    if (this.dripTimer) clearInterval(this.dripTimer);
    this.dripTimer = null;
  }

  // ── derived maps ───────────────────────────────────────────────────────────

  private restampGenres(p: SpotifyPool): void {
    for (const s of p.tracks.values()) {
      const g = s.artistId ? this.genreCache.get(s.artistId) ?? [] : [];
      s.genres = g;
      s.genre = g[0];
    }
    const derived = this.deriveGenreMaps(p.tracks);
    p.artistGenres = derived.artistGenres;
    p.genres = derived.genres;
  }

  private deriveGenreMaps(tracks: Map<string, Song>): { artistGenres: Map<string, string[]>; genres: Map<string, number> } {
    const artistGenres = new Map<string, string[]>();
    const genres = new Map<string, number>();
    for (const s of tracks.values()) {
      const g: string[] = Array.isArray(s.genres) ? s.genres : [];
      if (s.artistId && !artistGenres.has(s.artistId)) artistGenres.set(s.artistId, g);
      for (const name of g) genres.set(name, (genres.get(name) ?? 0) + 1);
    }
    return { artistGenres, genres };
  }

  // The one-item probe behind a saved-list fingerprint: `total` plus the newest
  // id, which between them catch an add, a remove and a reorder-by-recency —
  // every way a saved list normally changes, for ONE request instead of a walk.
  // Taken from a dedicated read rather than from the walk, because a walk may
  // have stopped at maxTracks and a partial count would make every future
  // revalidate believe the list had changed.
  private async fingerprint(page: () => Promise<any>, pick: (row: any) => string | null): Promise<SavedFingerprint | null> {
    try {
      const r: any = await page();
      const total = Number(r?.total);
      const newestId = pick(r?.items?.[0]);
      if (!Number.isFinite(total) || !newestId) return null;
      return { total, newestId };
    } catch {
      // An unanswerable probe is not a match — the walk happens.
      return null;
    }
  }

  // ── revalidate ─────────────────────────────────────────────────────────────

  private async revalidate(prev: SpotifyPool): Promise<SpotifyPool> {
    const c = this.client();
    const cfg = this.cfg();
    const tracks = new Map<string, Song>();
    const albums = new Map<string, Album>();
    const started = this.now();

    let partial = false;
    const notes: string[] = [];
    const record = (line: string) => {
      this.log(`[spotify] ${line}`);
      if (notes.length < 10 && !notes.includes(line)) notes.push(line);
    };
    const fail = (note: string) => { partial = true; record(note); };

    const add = (raw: any, addedAt: string | null | undefined, src: string) => {
      const t = unwrapItem(raw);
      if (!t || tracks.size >= cfg.maxTracks) return;
      const song = mapTrack(t, { addedAt });
      if (!song) return;
      song.srcPlaylistId = src;
      tracks.set(song.id, song);
      if (t.album?.id && !albums.has(t.album.id)) {
        const a = mapAlbum(t.album);
        if (a) albums.set(a.id, a);
      }
    };
    // Carry over every row a given source contributed last time, unchanged.
    const reuse = (src: string): number => {
      let n = 0;
      for (const s of prev.tracks.values()) {
        if (s.srcPlaylistId !== src || tracks.has(s.id) || tracks.size >= cfg.maxTracks) continue;
        tracks.set(s.id, s);
        n++;
        if (s.albumId && !albums.has(s.albumId)) {
          const a = prev.albums.get(s.albumId);
          if (a) albums.set(a.id, a);
        }
      }
      return n;
    };

    let playlists: SnapshotPlaylist[] = prev.playlists;
    let reusedLists = 0;
    let walkedLists = 0;
    try {
      const mine: any[] = await listMyPlaylists(c);
      const wanted = cfg.playlistIds.length ? mine.filter((p) => cfg.playlistIds.includes(p.id)) : mine;
      for (const id of cfg.playlistIds) {
        if (!wanted.some((p) => p.id === id)) {
          try {
            const p = await c.getPlaylist(id);
            if (p) wanted.push(p);
            else fail(`playlist ${id} not found`);
          } catch (err: any) {
            fail(`playlist ${id} unavailable: ${err?.message ?? err}`);
          }
        }
      }
      const knownSnapshot = new Map(prev.playlists.map((p) => [p.id, p.snapshotId]));
      const next: SnapshotPlaylist[] = [];
      for (const p of wanted) {
        const snapshotId = typeof p.snapshot_id === 'string' ? p.snapshot_id : undefined;
        const known = knownSnapshot.get(p.id);
        next.push({ id: p.id, name: p.name ?? '', songCount: p.items?.total ?? p.tracks?.total, snapshotId });
        // Spotify's own statement that these contents did not change. Reusing on
        // it is not a guess — it is the mitigation Spotify's rate-limit page
        // names, and it is why a refresh costs a handful of requests rather than
        // one per fifty tracks.
        if (snapshotId && known && known === snapshotId) {
          reusedLists++;
          reuse(p.id);
          continue;
        }
        walkedLists++;
        let seen = 0;
        const claimed = p.items?.total ?? p.tracks?.total;
        try {
          for await (const item of c.paginate<any>((o) => c.getPlaylistItems(p.id, { offset: o, limit: PAGE }), { pageSize: PAGE })) {
            seen++;
            add(item, item?.added_at ?? null, p.id);
            if (tracks.size >= cfg.maxTracks) break;
          }
          if (seen === 0 && claimed !== 0) {
            fail(`playlist "${p.name}" returned no items — since February 2026 Spotify serves playlist contents only for playlists this account owns or collaborates on`);
          }
        } catch (err: any) {
          fail(`playlist "${p.name}" walk failed: ${err?.message ?? err}`);
          // A playlist we could not re-read is not a playlist that went away.
          // Keep what it contributed last time rather than letting a blip look
          // like the operator emptying it — which the reconcile reads as
          // deletion (music/prune-policy.ts).
          reuse(p.id);
        }
        if (tracks.size >= cfg.maxTracks) break;
      }
      playlists = next;
    } catch (err: any) {
      fail(`playlist listing failed: ${err?.message ?? err}`);
      for (const p of prev.playlists) reuse(p.id);
    }

    let savedTracks = prev.savedTracks;
    if (cfg.includeSaved && tracks.size < cfg.maxTracks) {
      const fp = await this.fingerprint(
        () => c.getSavedTracks({ limit: 1 }),
        (row) => unwrapItem(row)?.id ?? null,
      );
      if (fp && prev.savedTracks && fp.total === prev.savedTracks.total && fp.newestId === prev.savedTracks.newestId) {
        reuse(SRC_SAVED_TRACKS);
      } else {
        try {
          for await (const item of c.paginate<any>((o) => c.getSavedTracks({ offset: o, limit: PAGE }), { pageSize: PAGE })) {
            add(item, item?.added_at ?? null, SRC_SAVED_TRACKS);
            if (tracks.size >= cfg.maxTracks) break;
          }
          savedTracks = fp;
        } catch (err: any) {
          fail(`saved-tracks walk failed: ${err?.message ?? err}`);
          reuse(SRC_SAVED_TRACKS);
        }
      }
    }

    let savedAlbums = prev.savedAlbums;
    if (cfg.includeSavedAlbums && tracks.size < cfg.maxTracks) {
      const fp = await this.fingerprint(
        () => c.getSavedAlbums({ limit: 1 }),
        (row) => (typeof row?.album?.id === 'string' ? row.album.id : null),
      );
      if (fp && prev.savedAlbums && fp.total === prev.savedAlbums.total && fp.newestId === prev.savedAlbums.newestId) {
        reuse(SRC_SAVED_ALBUMS);
      } else {
        try {
          for await (const item of c.paginate<any>((o) => c.getSavedAlbums({ offset: o, limit: PAGE }), { pageSize: PAGE })) {
            const album = item?.album;
            if (!album?.id) continue;
            const a = mapAlbum(album);
            if (a) { a.created = item?.added_at ?? undefined; albums.set(a.id, a); }
            for (const t of album.tracks?.items ?? []) add({ ...t, album }, item?.added_at ?? null, SRC_SAVED_ALBUMS);
            if (tracks.size >= cfg.maxTracks) break;
          }
          savedAlbums = fp;
        } catch (err: any) {
          fail(`saved-albums walk failed: ${err?.message ?? err}`);
          reuse(SRC_SAVED_ALBUMS);
        }
      }
    }

    const pool = await this.finish({
      tracks, albums, playlists, partial, notes, cfg,
      savedTracks, savedAlbums, walkedAt: prev.walkedAt, genreBudget: 0,
    });
    this.log(`[spotify] pool revalidated in ${Math.round((this.now() - started) / 1000)}s: ${reusedLists} playlist(s) unchanged, ${walkedLists} re-walked, ${pool.tracks.size} tracks${partial ? ' (partial)' : ''}`);
    return pool;
  }

  // ── full build ─────────────────────────────────────────────────────────────

  private async build(): Promise<SpotifyPool> {
    // A rebuild that FOLLOWS AN EMPTY POOL must not reuse the shared catalogue
    // reads that produced it. POOL_EMPTY_RETRY_MS exists so an empty pool costs
    // two minutes rather than thirty; serving that retry a five-minute-old memo
    // of the same empty listing would hand back the same nothing and quietly
    // undo the short window.
    if (this.pool && this.pool.tracks.size === 0) invalidateSpotifyReads();
    const c = this.client();
    const cfg = this.cfg();
    const tracks = new Map<string, Song>();
    const albums = new Map<string, Album>();
    const started = this.now();

    // One chokepoint for "this build lost something": marks the pool partial,
    // logs it, and keeps the reason for the admin UI. Capped so a pool of a
    // thousand unreachable artists cannot grow an unbounded status payload.
    let partial = false;
    const notes: string[] = [];
    const record = (line: string) => {
      this.log(`[spotify] ${line}`);
      if (notes.length < 10 && !notes.includes(line)) notes.push(line);
    };
    const fail = (note: string) => { partial = true; record(note); };
    // Something the operator needs told, that is NOT a failure — an account with
    // no playlists is a configuration, not a fault, but it must not produce a
    // silently empty pool either.
    const note = (line: string) => record(line);

    const add = (raw: any, addedAt: string | null | undefined, src: string) => {
      const t = unwrapItem(raw);
      if (!t || tracks.size >= cfg.maxTracks) return;
      const song = mapTrack(t, { addedAt });
      if (!song) return;
      // Which source this row came from, so the next revalidate can keep it when
      // Spotify says that source did not change.
      song.srcPlaylistId = src;
      tracks.set(song.id, song);
      if (t.album?.id && !albums.has(t.album.id)) {
        const a = mapAlbum(t.album);
        if (a) albums.set(a.id, a);
      }
    };

    // 1. Playlists — the configured ids, or everything the account owns/follows.
    let playlists: SnapshotPlaylist[] = [];
    try {
      // Shared with getPlaylists() (reads.ts): the admin's playlist pickers and
      // every pool build used to walk this listing separately.
      const mine: any[] = await listMyPlaylists(c);
      // An empty listing is a successful walk that found nothing, so it sets no
      // error and no `partial` — and used to produce a completely unexplained
      // `0 tracks, 0 playlists` pool. Say it, whichever way the pool is scoped.
      if (mine.length === 0) {
        note(cfg.playlistIds.length
          ? 'the account owns or follows no playlists, so the configured ids can only be resolved one by one'
          : 'the account returned no playlists — with no playlist ids configured the pool draws from every playlist it owns or follows, and there are none');
      }
      const wanted = cfg.playlistIds.length ? mine.filter((p) => cfg.playlistIds.includes(p.id)) : mine;
      // Configured ids the account does not own/follow still RESOLVE, so the
      // name and cover render — but since February 2026 only a playlist the
      // connected account owns or collaborates on returns its contents. Someone
      // else's playlist answers metadata and an empty page, no error, which is
      // why the walk below reports a zero-item playlist explicitly.
      for (const id of cfg.playlistIds) {
        if (!wanted.some((p) => p.id === id)) {
          try {
            const p = await c.getPlaylist(id);
            if (p) wanted.push(p);
            else fail(`playlist ${id} not found`);
          } catch (err: any) {
            fail(`playlist ${id} unavailable: ${err?.message ?? err}`);
          }
        }
      }
      playlists = wanted.map((p) => ({
        id: p.id,
        name: p.name ?? '',
        songCount: p.items?.total ?? p.tracks?.total,
        snapshotId: typeof p.snapshot_id === 'string' ? p.snapshot_id : undefined,
      }));
      for (const p of wanted) {
        // Count what the WALK yielded, not how much the pool grew: `add`
        // de-duplicates, so a playlist whose every track is already in the pool
        // would otherwise read as unreadable.
        let seen = 0;
        const claimed = p.items?.total ?? p.tracks?.total;
        try {
          for await (const item of c.paginate<any>((o) => c.getPlaylistItems(p.id, { offset: o, limit: PAGE }), { pageSize: PAGE })) {
            seen++;
            add(item, item?.added_at ?? null, p.id);
            if (tracks.size >= cfg.maxTracks) break;
          }
          if (seen === 0 && claimed !== 0) {
            fail(`playlist "${p.name}" returned no items — since February 2026 Spotify serves playlist contents only for playlists this account owns or collaborates on`);
          }
        } catch (err: any) {
          fail(`playlist "${p.name}" walk failed: ${err?.message ?? err}`);
        }
        if (tracks.size >= cfg.maxTracks) break;
      }
    } catch (err: any) {
      fail(`playlist listing failed: ${err?.message ?? err}`);
    }

    // 2. Saved tracks.
    let savedTracks: SavedFingerprint | null = null;
    if (cfg.includeSaved && tracks.size < cfg.maxTracks) {
      try {
        for await (const item of c.paginate<any>((o) => c.getSavedTracks({ offset: o, limit: PAGE }), { pageSize: PAGE })) {
          add(item, item?.added_at ?? null, SRC_SAVED_TRACKS);
          if (tracks.size >= cfg.maxTracks) break;
        }
        savedTracks = await this.fingerprint(
          () => c.getSavedTracks({ limit: 1 }),
          (row) => unwrapItem(row)?.id ?? null,
        );
      } catch (err: any) {
        fail(`saved-tracks walk failed: ${err?.message ?? err}`);
      }
    }

    // 3. Saved albums (their tracks lack the album object — attach it).
    let savedAlbums: SavedFingerprint | null = null;
    if (cfg.includeSavedAlbums && tracks.size < cfg.maxTracks) {
      try {
        for await (const item of c.paginate<any>((o) => c.getSavedAlbums({ offset: o, limit: PAGE }), { pageSize: PAGE })) {
          const album = item?.album;
          if (!album?.id) continue;
          const a = mapAlbum(album);
          if (a) { a.created = item?.added_at ?? undefined; albums.set(a.id, a); }
          for (const t of album.tracks?.items ?? []) add({ ...t, album }, item?.added_at ?? null, SRC_SAVED_ALBUMS);
          if (tracks.size >= cfg.maxTracks) break;
        }
        savedAlbums = await this.fingerprint(
          () => c.getSavedAlbums({ limit: 1 }),
          (row) => (typeof row?.album?.id === 'string' ? row.album.id : null),
        );
      } catch (err: any) {
        fail(`saved-albums walk failed: ${err?.message ?? err}`);
      }
    }

    const pool = await this.finish({
      tracks, albums, playlists, partial, notes, cfg,
      savedTracks, savedAlbums, walkedAt: this.now(), genreBudget: ARTIST_GENRE_BUDGET,
    });
    const retry = this.ttlFor(pool) === POOL_EMPTY_RETRY_MS ? `, retrying in ${Math.round(POOL_EMPTY_RETRY_MS / 1000)}s` : '';
    const pending = pool.genresPending ? `, ${pool.genresPending} artists awaiting genres` : '';
    this.log(`[spotify] pool built: ${pool.tracks.size} tracks, ${pool.albums.size} albums, ${playlists.length} playlists, ${pool.genres.size} genres in ${Math.round((this.now() - started) / 1000)}s${partial ? ' (partial)' : ''}${pending}${retry}`);
    return pool;
  }

  // The tail both paths share: genres, era suspicion, publish, persist.
  private async finish(args: {
    tracks: Map<string, Song>;
    albums: Map<string, Album>;
    playlists: SnapshotPlaylist[];
    partial: boolean;
    notes: string[];
    cfg: PoolConfig;
    savedTracks: SavedFingerprint | null;
    savedAlbums: SavedFingerprint | null;
    walkedAt: number;
    genreBudget: number;
  }): Promise<SpotifyPool> {
    const { tracks, albums, playlists, partial, notes, cfg, savedTracks, savedAlbums, walkedAt, genreBudget } = args;

    // A walk that FAILED must never replace a working library with nothing.
    //
    // The two empty pools are not the same thing: an account that genuinely has
    // no playlists SHOULD publish an empty pool with its explanation, but a walk
    // whose every request was refused must leave what we had alone. Conflating
    // them is what turned a rebuild pressed during a rate-limit hold into dead
    // air, because `get()` then serves that empty pool for as long as the hold
    // lasts and the transport reads it as "nothing to play".
    const existing = this.pool;
    if (!tracks.size && partial && existing && existing.tracks.size > 0) {
      existing.partial = true;
      existing.notes = notes.length ? notes : existing.notes;
      // Retry on the short window rather than the full TTL: whatever broke may
      // well be transient, and the pool we kept is by definition stale.
      existing.builtAt = this.now() - POOL_TTL_MS + POOL_EMPTY_RETRY_MS;
      this.log(`[spotify] the refresh could not read the library (${notes[0] ?? 'every request was refused'}) — keeping the ${existing.tracks.size} tracks we already had rather than publishing an empty pool`);
      return existing;
    }

    // Artist genres. Deliberately NOT `fail()`: unfilled genres are enrichment
    // still to do, not a broken pool. Calling it partial would drive the
    // empty-pool retry and turn a cosmetic gap into a rebuild loop against a
    // live rate limit. The BULK of this work belongs to the drip — a build only
    // tops up so a first-ever pool is not genre-less.
    const artistIds = this.rankedArtists({ tracks } as SpotifyPool);
    await this.loadGenreCache();
    const pending = genreBudget > 0
      ? (await this.fetchArtistGenres(artistIds, genreBudget)).pending
      : artistIds.filter((id) => !this.genreCache.has(id)).length;

    for (const s of tracks.values()) {
      const g = s.artistId ? this.genreCache.get(s.artistId) ?? [] : [];
      s.genres = g;
      s.genre = g[0];
    }
    stampEraSuspicion(tracks, albums);

    const walked = tracks;
    this.walked = walked;
    const published = this.publishable(walked);
    this.pool = {
      tracks: published, albums,
      ...this.deriveGenreMaps(published),
      playlists,
      builtAt: this.now(),
      walkedAt,
      partial, notes,
      genresPending: pending,
      dripAt: existing?.dripAt ?? 0,
      dripSkip: existing?.dripSkip ?? null,
      // Measured on the WALK: a refusal withholding a row does not mean the
      // walk stopped at its cap, and truncated drives the orphan reconcile.
      truncated: walked.size >= cfg.maxTracks,
      cfgSig: poolConfigSignature(cfg),
      savedTracks, savedAlbums,
      // Confirmed against Spotify in THIS process, which is what catalogHealth()
      // needs before the orphan reconcile may delete against it.
      fromDisk: false,
    };
    this.snapshotLoaded = true;
    // The SNAPSHOT is written from the walked set, not the published one. A
    // refusal is a fact about this account's licensing today, while pool.json is
    // the only copy of a walk that cost ~100 requests — so the row stays on disk
    // and only the station's view of it goes. That is what makes "Forget refused
    // tracks", and the 30-day expiry, free rather than a full catalogue re-walk.
    if (walked.size) await this.saveSnapshot({ ...this.pool, tracks: walked });
    return this.pool;
  }

  // Withhold tracks Spotify has refused to play. Applied at the two points a
  // SpotifyPool is published (a finished walk, a restored snapshot) so every
  // consumer of `pool.tracks` — the picker, the agent's tools, iterateAllSongs
  // and therefore the tagger, coverage and the orphan reconcile — sees the same
  // library.
  //
  // ALWAYS A NEW MAP, even when nothing is refused. Handing the walked map back
  // as the published one is the obvious saving and it is wrong: `dropTrack` then
  // deletes from both, so the very thing the split exists for — the snapshot
  // keeping a row the station is not playing — is lost the moment it is used.
  // Same shape as the never-starve rule in the track floor: a filter must not
  // return its input.
  private publishable(walked: Map<string, Song>): Map<string, Song> {
    const refused = unplayableIds();
    const out = new Map<string, Song>();
    let held = 0;
    for (const [id, song] of walked) {
      if (refused.size && refused.has(id)) { held++; continue; }
      out.set(id, song);
    }
    if (held) this.log(`[spotify] holding back ${held} track(s) Spotify refused to play; the snapshot keeps them, so clearing the list costs no requests`);
    return out;
  }

  // A track was just refused on air: take it out of the live pool now rather
  // than at the next build. Deliberately does NOT invalidate() — that marks a
  // refresh owed and drops the shared read memos, i.e. buys a catalogue re-walk
  // to remove one row we have already removed — and does NOT rewrite the
  // snapshot, which keeps the row on purpose (see finish()).
  dropTrack(id: string): boolean {
    const p = this.pool;
    if (!p || !p.tracks.has(id)) return false;
    p.tracks.delete(id);
    Object.assign(p, this.deriveGenreMaps(p.tracks));
    return true;
  }

  // The mirror: the refused list was cleared (or entries expired), so republish
  // from the walked set held in memory. No disk read and no request — and if
  // there is nothing to republish from, the existing pool is left exactly as it
  // is rather than being thrown away.
  republish(): number {
    const p = this.pool;
    if (!p || !this.walked) return 0;
    const before = p.tracks.size;
    p.tracks = this.publishable(this.walked);
    Object.assign(p, this.deriveGenreMaps(p.tracks));
    return p.tracks.size - before;
  }
}

// Fisher–Yates over a copy; `size` capped at the input length.
export function sample<T>(list: T[], size: number, rand: () => number = Math.random): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, Math.min(size, a.length)));
}
