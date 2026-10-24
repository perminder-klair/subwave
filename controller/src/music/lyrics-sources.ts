// Where a track's lyrics come from: the music server first, then LRCLIB
// (music/lrclib.ts) for a track the music server has no TIMED lyrics for, when
// the operator has switched the fallback on (`settings.lyrics.lrclib`).
//
//   music-server synced > LRCLIB synced > music-server plain > LRCLIB plain
//
// This serves the listener Lyrics panel and nothing else. The analyzer reads
// the music server's lyrics through `subsonic.getStructuredLyrics()` and never
// these: a crowd file timed to a different cut only mistimes the panel, where
// the station offset fixes it, but in the analyzer it would mistime the DJ
// talking over the vocals.
//
// The lookup runs when a track is QUEUED (`onTrackQueued`, called by
// `queue.push()`), minutes before it airs, and again when it goes ON AIR
// (`onTrackStarted`) if that left it unanswered; never because a listener
// asked. The on-air hook alone was too late: LRCLIB refuses in bursts, and its
// three tries span about 20 s, close to the whole `stream.bufferSeconds`
// before listeners reach the track (measured 2026-10-24: a station's first two
// on-air lookups were each refused three times, and the same requests were
// answered minutes later). A track that never went through the queue (the
// auto playlist) still gets the on-air lookup. The read path never waits on
// LRCLIB (degrade immediately, never through a timeout): a listener who asks
// first gets the music server's answer marked `pending`, and asking again
// picks up the stored one.
//
// Every answer is kept in library.db (`lyrics_external`). A synced hit is kept
// for good; a miss or an untimed hit is asked about again after
// RECHECK_AFTER_DAYS, so a library that cycles the same tracks costs LRCLIB
// one request per track per month at most. A failure is not an answer and is
// never stored; that track waits FAILURE_BACKOFF_MS instead, which keeps
// listener polls from asking again. The on-air hook is exempt, once per play,
// so a refusal at queue time cannot cost the play it was queued for.
import * as settings from '../settings.js';
import * as library from './library.js';
import * as subsonic from './subsonic.js';
import { BoundedLyricsCache } from './lyrics-cache.js';
import { isInstrumentalMarker } from './lyric-vocal.js';
import { parseLrc, plainLyrics } from './lrc.js';
import { lrclib, type LrclibRecord, type LrclibTrack } from './lrclib.js';
import { BoundedKeyMap } from '../util/bounded-key-map.js';
import type { ExternalLyrics } from './library-db.js';
import type { LyricsSource, StructuredLyricsInput } from './lyrics-public.js';

// How long a player should wait after the music server failed to answer.
// Matches the cache's negative TTL, inside which a retry would only be told
// the same thing.
export const LYRICS_RETRY_AFTER_SEC = 10;

export const RECHECK_AFTER_DAYS = 30;
export const FAILURE_BACKOFF_MS = 10 * 60_000;

// Shared by the listener read and the on-air lookup, so the read a listener
// makes a buffer later is normally a cache hit.
const musicServerCache = new BoundedLyricsCache<StructuredLyricsInput>({
  negativeTtlMs: LYRICS_RETRY_AFTER_SEC * 1000,
});

/** The music server's lyrics for a track. Throws when it did not answer. */
export function musicServerLyrics(songId: string): Promise<StructuredLyricsInput | null> {
  return musicServerCache.get(songId, () => subsonic.fetchStructuredLyrics(songId));
}

const sung = (l: { text: string }) => !!l.text.trim() && !isInstrumentalMarker(l.text);

/** Lyrics a player can highlight line by line. */
export function isTimed(lyrics: StructuredLyricsInput | null | undefined): lyrics is StructuredLyricsInput {
  return lyrics?.synced === true && lyrics.lines.some((l) => Number.isFinite(l.startMs) && sung(l));
}

function hasWords(lyrics: StructuredLyricsInput | null | undefined): lyrics is StructuredLyricsInput {
  return !!lyrics?.lines.some(sung);
}

export interface ChosenLyrics {
  lyrics: StructuredLyricsInput | null;
  source: LyricsSource;
}

/** The precedence in the header, as one decision. */
export function chooseLyrics(
  musicServer: StructuredLyricsInput | null,
  external: StructuredLyricsInput | null,
): ChosenLyrics {
  if (isTimed(musicServer)) return { lyrics: musicServer, source: 'music-server' };
  if (isTimed(external)) return { lyrics: external, source: 'lrclib' };
  if (hasWords(musicServer)) return { lyrics: musicServer, source: 'music-server' };
  if (hasWords(external)) return { lyrics: external, source: 'lrclib' };
  return { lyrics: musicServer, source: 'music-server' };
}

/** LRCLIB's stored answer as lyrics: synced first, else its plain text. */
export function externalLyrics(row: ExternalLyrics | null): StructuredLyricsInput | null {
  if (!row || row.instrumental) return null;
  return parseLrc(row.syncedLrc) ?? plainLyrics(row.plainText);
}

/** A stored answer is final once it is timed; anything else is asked again. */
export function needsRecheck(row: ExternalLyrics | null, now = Date.now()): boolean {
  if (!row) return true;
  if (row.instrumental || parseLrc(row.syncedLrc)) return false;
  const checked = Date.parse(row.checkedAt);
  return !Number.isFinite(checked) || now - checked >= RECHECK_AFTER_DAYS * 86_400_000;
}

export function fallbackEnabled(): boolean {
  const ly = settings.get()?.lyrics;
  return ly?.enabled === true && ly?.lrclib === true;
}

const inFlight = new Map<string, Promise<void>>();
const failedAt = new BoundedKeyMap<number>({
  maxKeys: 500,
  isLive: (at, now) => now - at < FAILURE_BACKOFF_MS,
});

// Artist, title, album and length, from the library index first and the music
// server for a track the index has not reached. null when any of the three
// LRCLIB needs is missing.
async function lookupKey(trackId: string): Promise<LrclibTrack | null> {
  const row = library.get(trackId);
  let meta = row?.title && row?.artist && row?.durationSec > 0
    ? { title: row.title, artist: row.artist, album: row.album, durationSec: Number(row.durationSec) }
    : null;
  if (!meta) {
    const song = await subsonic.getSong(trackId).catch(() => null);
    if (song?.title && song?.artist && Number(song.duration) > 0) {
      meta = { title: song.title, artist: song.artist, album: song.album, durationSec: Number(song.duration) };
    }
  }
  return meta ? { ...meta, album: meta.album ?? null } : null;
}

function toStored(record: LrclibRecord | null): Omit<ExternalLyrics, 'checkedAt'> {
  const synced = typeof record?.syncedLyrics === 'string' && record.syncedLyrics.trim() ? record.syncedLyrics : null;
  const plain = typeof record?.plainLyrics === 'string' && record.plainLyrics.trim() ? record.plainLyrics : null;
  return {
    source: 'lrclib',
    syncedLrc: synced,
    plainText: plain,
    instrumental: record?.instrumental === true,
    externalId: record?.id != null ? String(record.id) : null,
  };
}

/**
 * Start (or join) the LRCLIB lookup for a track when one is owed: the switch
 * is on, `stored` (the track's row, read by the caller) is missing or stale,
 * and the track is not backing off from a failure (unless `pastBackoff`, the
 * on-air hook's once-per-play exemption). Returns the lookup, or null when
 * none is owed, decided before returning so a caller can tell a listener
 * whether to ask again. Never rejects.
 */
export function ensureLookup(
  trackId: string | null | undefined,
  stored: ExternalLyrics | null,
  { pastBackoff = false }: { pastBackoff?: boolean } = {},
): Promise<void> | null {
  if (!trackId || !fallbackEnabled()) return null;
  const running = inFlight.get(trackId);
  if (running) return running;
  if (!needsRecheck(stored)) return null;
  const failed = failedAt.get(trackId);
  if (!pastBackoff && failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS) return null;

  const lookup = (async () => {
    try {
      const key = await lookupKey(trackId);
      // Nothing to ask with is not an answer to store, but asking again on
      // every listener poll would not find the missing length either.
      if (!key) {
        failedAt.set(trackId, Date.now());
        return;
      }
      const record = await lrclib().find(key);
      await library.setExternalLyrics(trackId, toStored(record));
      failedAt.delete(trackId);
    } catch (err) {
      failedAt.set(trackId, Date.now());
      console.warn(`[lyrics] LRCLIB lookup for ${trackId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })().finally(() => inFlight.delete(trackId));
  inFlight.set(trackId, lookup);
  return lookup;
}

// Look a track up unless LRCLIB already answered for it or the music server
// has it timed. The stored answer is read first, so a track already settled
// costs the music server nothing. Fire-and-forget.
function lookupUnlessTimed(trackId: string | null | undefined, when: string, pastBackoff: boolean): void {
  if (!trackId || !fallbackEnabled()) return;
  void (async () => {
    const stored = await library.getExternalLyrics(trackId);
    if (!needsRecheck(stored)) return;
    const lyrics = await musicServerLyrics(trackId).catch(() => null);
    if (isTimed(lyrics)) return;
    await ensureLookup(trackId, stored, { pastBackoff });
  })().catch((err) => {
    console.warn(`[lyrics] ${when} lookup for ${trackId} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * A track joined the queue: look it up now, minutes before it airs, so a
 * refusal has time to clear before the on-air hook asks again.
 */
export function onTrackQueued(trackId: string | null | undefined): void {
  lookupUnlessTimed(trackId, 'queued', false);
}

/**
 * A track went on air: look it up now, a stream buffer before any listener
 * hears it, if the queue-time lookup left it unanswered. Exempt from the
 * failure backoff, so this play gets its own try.
 */
export function onTrackStarted(trackId: string | null | undefined): void {
  lookupUnlessTimed(trackId, 'on-air', true);
}

export class LyricsServerDown extends Error {
  constructor() {
    super('The music server did not answer for lyrics');
  }
}

export interface ListenerLyrics extends ChosenLyrics {
  /** An LRCLIB lookup for this track is in flight; the answer may improve. */
  pending: boolean;
}

/**
 * The lyrics to show a listener for `songId`. Never waits on LRCLIB. Throws
 * LyricsServerDown when the music server did not answer and nothing stored
 * can stand in for it.
 */
export async function listenerLyrics(songId: string): Promise<ListenerLyrics> {
  let fromServer: StructuredLyricsInput | null = null;
  let serverDown = false;
  try {
    fromServer = await musicServerLyrics(songId);
  } catch {
    serverDown = true;
  }
  if (isTimed(fromServer)) return { lyrics: fromServer, source: 'music-server', pending: false };
  // Switched off, LRCLIB is not read either: the panel behaves exactly as it
  // did before the fallback existed.
  if (!fallbackEnabled()) {
    if (serverDown) throw new LyricsServerDown();
    return { lyrics: fromServer, source: 'music-server', pending: false };
  }

  const row = await library.getExternalLyrics(songId);
  const stored = externalLyrics(row);
  const pending = ensureLookup(songId, row) !== null;
  if (serverDown) {
    // A timed LRCLIB answer is what the panel would show anyway unless the
    // music server has its own timed lyrics, which is the rare case.
    if (isTimed(stored)) return { lyrics: stored, source: 'lrclib', pending };
    throw new LyricsServerDown();
  }
  return { ...chooseLyrics(fromServer, stored), pending };
}
