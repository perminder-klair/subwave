// The Spotify transport's decisions, pure. The transport (transport.ts) owns the
// IO — marker reads, Web API commands, telnet — and asks these functions what
// to do; scripts/spotify-seam.test.ts pins them without a player, a mixer or a
// clock of their own.
//
// Model: librespot reports events (spotify-player-pure.ts). From them the
// transport keeps ONE `current` playing track with the last known position and
// when it was known; remaining time is extrapolated from there. The SEAM is the
// moment the next pick must be commanded: `seamLeadMs` before the current track
// ends, or immediately when the player says it has ended/stopped.

import type { SpotifyPlayerEvent } from '../../../broadcast/spotify-player-pure.js';

export interface CurrentTrack {
  id: string;
  durationMs: number | null;
  positionMs: number;
  // ms epoch at which positionMs was true.
  positionAt: number;
  playing: boolean;
  // The player reported end_of_track / stopped for this track.
  ended: boolean;
}

export function positionNow(cur: CurrentTrack, now: number): number {
  if (!cur.playing) return cur.positionMs;
  return cur.positionMs + Math.max(0, now - cur.positionAt);
}

// Milliseconds left, or null when the duration is unknown.
export function remainingMs(cur: CurrentTrack | null, now: number): number | null {
  if (!cur || cur.durationMs == null) return null;
  if (cur.ended) return 0;
  return Math.max(0, cur.durationMs - positionNow(cur, now));
}

// Fold one player event into the current-track model. Returns the new model
// (never mutates) plus what the event MEANS for the transport.
export type EventMeaning =
  | { kind: 'started'; trackId: string }        // track_changed → a track began
  | { kind: 'progress' }                          // position/pause/resume
  | { kind: 'ended' }                             // end_of_track / stopped
  | { kind: 'unavailable'; trackId: string | null }
  | { kind: 'session'; connected: boolean }
  | { kind: 'ignore' };

export function applyEvent(cur: CurrentTrack | null, ev: SpotifyPlayerEvent): { current: CurrentTrack | null; meaning: EventMeaning } {
  switch (ev.event) {
    case 'track_changed': {
      if (!ev.trackId) return { current: cur, meaning: { kind: 'ignore' } };
      return {
        current: {
          id: ev.trackId,
          durationMs: ev.durationMs,
          positionMs: 0,
          positionAt: ev.at,
          // librespot fires `playing` right after; until then assume it is.
          playing: true,
          ended: false,
        },
        meaning: { kind: 'started', trackId: ev.trackId },
      };
    }
    case 'playing':
    case 'seeked':
    case 'position_correction': {
      if (!cur || (ev.trackId && ev.trackId !== cur.id)) {
        // Position for a track we never saw start (a restart mid-song): adopt
        // it as current so the seam clock is real rather than absent.
        if (ev.trackId) {
          return {
            current: { id: ev.trackId, durationMs: cur?.id === ev.trackId ? cur.durationMs : null, positionMs: ev.positionMs ?? 0, positionAt: ev.at, playing: true, ended: false },
            meaning: { kind: 'started', trackId: ev.trackId },
          };
        }
        return { current: cur, meaning: { kind: 'ignore' } };
      }
      return {
        current: { ...cur, positionMs: ev.positionMs ?? positionNow(cur, ev.at), positionAt: ev.at, playing: true, ended: false },
        meaning: { kind: 'progress' },
      };
    }
    case 'paused': {
      if (!cur) return { current: cur, meaning: { kind: 'ignore' } };
      return {
        current: { ...cur, positionMs: ev.positionMs ?? positionNow(cur, ev.at), positionAt: ev.at, playing: false },
        meaning: { kind: 'progress' },
      };
    }
    case 'end_of_track':
    case 'stopped': {
      if (!cur) return { current: cur, meaning: { kind: 'ended' } };
      return { current: { ...cur, playing: false, ended: true }, meaning: { kind: 'ended' } };
    }
    case 'unavailable':
      return { current: cur, meaning: { kind: 'unavailable', trackId: ev.trackId } };
    case 'session_connected':
      return { current: cur, meaning: { kind: 'session', connected: true } };
    case 'session_disconnected':
      return { current: cur, meaning: { kind: 'session', connected: false } };
    default:
      return { current: cur, meaning: { kind: 'ignore' } };
  }
}

export interface SeamInputs {
  now: number;
  current: CurrentTrack | null;
  // A play command has been issued and its track_changed has not arrived yet.
  awaitingStart: boolean;
  // ms epoch of that command, for the "it never started" timeout.
  commandedAt: number | null;
  // Something is waiting to be played (a handed-off pick).
  hasPending: boolean;
  seamLeadMs: number;
  // When the transport last commanded anything — bounds the idle re-start.
  lastCommandAt: number | null;
  // How long to wait for a commanded track to report track_changed.
  startTimeoutMs: number;
  // How long a silent, non-playing feed may sit before the transport restarts
  // it with a fallback pick (the "station must keep making sound" rule).
  idleMs: number;
}

export type SeamDecision =
  | { action: 'hold'; reason: string }
  | { action: 'command-next'; reason: string }
  | { action: 'command-timeout'; reason: string };

export const DEFAULT_START_TIMEOUT_MS = 12_000;
export const DEFAULT_IDLE_MS = 15_000;

export function seamDecision(i: SeamInputs): SeamDecision {
  if (i.awaitingStart) {
    if (i.commandedAt != null && i.now - i.commandedAt > i.startTimeoutMs) {
      return { action: 'command-timeout', reason: `commanded ${Math.round((i.now - i.commandedAt) / 1000)}s ago and never started` };
    }
    return { action: 'hold', reason: 'awaiting track start' };
  }
  const rem = remainingMs(i.current, i.now);
  if (i.current && !i.current.ended && i.current.playing) {
    if (rem == null) return { action: 'hold', reason: 'playing, duration unknown' };
    if (rem <= i.seamLeadMs) {
      return i.hasPending
        ? { action: 'command-next', reason: `${Math.round(rem)}ms left` }
        : { action: 'command-next', reason: `${Math.round(rem)}ms left, nothing picked — fallback` };
    }
    return { action: 'hold', reason: `${Math.round(rem / 1000)}s left` };
  }
  // Not playing: ended, paused, or nothing ever started.
  if (i.current?.ended) return { action: 'command-next', reason: 'track ended' };
  if (!i.current) {
    // Nothing known yet. Give a fresh boot a moment for a marker, then start.
    const sinceCmd = i.lastCommandAt == null ? Infinity : i.now - i.lastCommandAt;
    return sinceCmd > i.idleMs
      ? { action: 'command-next', reason: 'no track playing' }
      : { action: 'hold', reason: 'waiting for the player' };
  }
  // Paused by someone: respect it for idleMs, then treat as idle and move on —
  // a paused station is dead air, and the operator has /dj/skip for intent.
  const pausedFor = i.now - i.current.positionAt;
  return pausedFor > i.idleMs
    ? { action: 'command-next', reason: `paused for ${Math.round(pausedFor / 1000)}s` }
    : { action: 'hold', reason: 'paused' };
}

// What to do when the player started a track we did not command.
export type MismatchPolicy = 'reclaim' | 'follow';
export type MismatchAction = 'reclaim' | 'adopt';

export function mismatchAction(policy: MismatchPolicy, reclaimAttempts: number, maxReclaims = 1): MismatchAction {
  if (policy === 'follow') return 'adopt';
  return reclaimAttempts < maxReclaims ? 'reclaim' : 'adopt';
}

// The metadata handed to the mixer (telnet spotify_track) for a started track —
// the same keys annotate: carries in file mode, so on_meta/now-playing/ICY need
// no change. `subsonic_id` is the frozen wire name for "track id".
export function mixerMetadataFor(song: { id: string; title?: string | null; artist?: string | null; album?: string | null; year?: number | null; genres?: string[] | null; albumIsCompilation?: boolean | null }): Record<string, string> {
  const m: Record<string, string> = {
    title: String(song.title ?? ''),
    artist: String(song.artist ?? ''),
    album: String(song.album ?? ''),
    subsonic_id: song.id,
  };
  // Era rule (#1418): a compilation's year is its own release date and is
  // withheld rather than asserted wrong; Spotify has no original-release date.
  if (song.year && !song.albumIsCompilation) m.year = String(song.year);
  if (song.genres?.length) m.genre = song.genres.join(', ');
  return m;
}
