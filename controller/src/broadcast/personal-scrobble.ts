// Personal browser-playback accounting. The browser reports only whether its
// audio element is genuinely advancing; the controller owns track identity,
// time and provider submission. Per-tab intervals are merged into one coverage
// set, so two open players can confirm the same seconds without counting or
// submitting them twice.

import { isEligibleScrobble, type ScrobbleTrackLike } from './scrobble-pure.js';
import type { QueueItem } from './queue/types.js';

// Background-tab timers can be throttled to roughly one tick per minute. A
// 75-second confirmation window keeps real background listening countable;
// no interval is ever credited unless a later heartbeat or stop confirms it.
export const PERSONAL_HEARTBEAT_GAP_MS = 75_000;
const MAX_SESSIONS = 32;
const MAX_AIRINGS = 8;

export interface PersonalAiring {
  key: string;
  track: ScrobbleTrackLike;
  /** Listener-time boundary (live edge start + configured stream buffer). */
  startedAtMs: number;
}

interface Coverage {
  startMs: number;
  endMs: number;
}

interface AiringState extends PersonalAiring {
  coverage: Coverage[];
  firstHeardAtMs: number;
  nowPlayingSent: boolean;
  submitted: boolean;
  touchedAtMs: number;
}

interface PlaybackSession {
  trackKey: string;
  lastSeenAtMs: number;
}

export interface PersonalPlaybackReport {
  playbackId: string;
  playing: boolean;
  airing: PersonalAiring | null;
  nowMs?: number;
}

export interface PersonalPlaybackResult {
  heardSeconds: number;
  submitted: boolean;
  trackKey: string | null;
}

export interface PersonalScrobbleCallbacks {
  onNowPlaying: (track: ScrobbleTrackLike) => void;
  onSubmit: (track: ScrobbleTrackLike, listenedAt: string) => void;
}

function trackFromItem(item: QueueItem): ScrobbleTrackLike {
  return {
    id: item.track.id || null,
    title: item.track.title || null,
    artist: item.track.artist || null,
    album: item.track.album || null,
    duration: item.track.duration ?? null,
  };
}

/** Resolve what a browser listener is hearing, not what is at the live edge. */
export function personalAiringAt(
  current: QueueItem | null,
  history: QueueItem[],
  bufferSeconds: number,
  nowMs: number = Date.now(),
): PersonalAiring | null {
  const leadMs = Math.min(Math.max(Number(bufferSeconds) || 0, 0), 60) * 1000;
  const heardAtMs = nowMs - leadMs;
  const candidates = current ? [current, ...history] : history;
  for (const item of candidates) {
    const startedAtMs = Date.parse(item.startedAt || '');
    const endedAtMs = item.endedAt ? Date.parse(item.endedAt) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(startedAtMs) || (item.endedAt && !Number.isFinite(endedAtMs))) continue;
    if (heardAtMs < startedAtMs || heardAtMs >= endedAtMs) continue;
    const track = trackFromItem(item);
    if (!track.title || !track.artist) return null;
    const listenerStartedAtMs = startedAtMs + leadMs;
    const identity = String(track.id || `${track.artist}\u0000${track.title}`);
    return {
      key: `${identity}\u0000${item.startedAt}`,
      track,
      startedAtMs: listenerStartedAtMs,
    };
  }
  return null;
}

function coveredMs(coverage: Coverage[]): number {
  return coverage.reduce((sum, span) => sum + Math.max(0, span.endMs - span.startMs), 0);
}

export class PersonalScrobbleTracker {
  private readonly sessions = new Map<string, PlaybackSession>();
  private readonly airings = new Map<string, AiringState>();

  constructor(private readonly callbacks: PersonalScrobbleCallbacks) {}

  private stateFor(airing: PersonalAiring, nowMs: number): AiringState {
    const found = this.airings.get(airing.key);
    if (found) {
      found.touchedAtMs = nowMs;
      return found;
    }
    const state: AiringState = {
      ...airing,
      coverage: [],
      firstHeardAtMs: nowMs,
      nowPlayingSent: false,
      submitted: false,
      touchedAtMs: nowMs,
    };
    this.airings.set(airing.key, state);
    return state;
  }

  private credit(trackKey: string, startMs: number, endMs: number): void {
    const state = this.airings.get(trackKey);
    if (!state || endMs <= startMs) return;
    state.firstHeardAtMs = Math.min(state.firstHeardAtMs, startMs);
    state.touchedAtMs = endMs;
    const spans = [...state.coverage, { startMs, endMs }]
      .sort((a, b) => a.startMs - b.startMs);
    const merged: Coverage[] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (!last || span.startMs > last.endMs) merged.push({ ...span });
      else last.endMs = Math.max(last.endMs, span.endMs);
    }
    state.coverage = merged;
    const heardSeconds = coveredMs(merged) / 1000;
    if (!state.submitted && isEligibleScrobble(state.track, heardSeconds)) {
      // Set before the side effect: a synchronous throw or a repeat report must
      // never fan out a duplicate submission.
      state.submitted = true;
      this.callbacks.onSubmit(state.track, new Date(state.firstHeardAtMs).toISOString());
    }
  }

  private prune(nowMs: number): void {
    for (const [id, session] of this.sessions) {
      if (nowMs - session.lastSeenAtMs > PERSONAL_HEARTBEAT_GAP_MS) this.sessions.delete(id);
    }
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()]
        .sort((a, b) => a[1].lastSeenAtMs - b[1].lastSeenAtMs)[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
    while (this.airings.size > MAX_AIRINGS) {
      const oldest = [...this.airings.entries()]
        .sort((a, b) => a[1].touchedAtMs - b[1].touchedAtMs)[0];
      if (!oldest) break;
      this.airings.delete(oldest[0]);
    }
  }

  report(input: PersonalPlaybackReport): PersonalPlaybackResult {
    const nowMs = input.nowMs ?? Date.now();
    const previous = this.sessions.get(input.playbackId);
    const gapOk = !!previous
      && nowMs >= previous.lastSeenAtMs
      && nowMs - previous.lastSeenAtMs <= PERSONAL_HEARTBEAT_GAP_MS;

    if (!input.playing || !input.airing) {
      if (gapOk && previous) this.credit(previous.trackKey, previous.lastSeenAtMs, nowMs);
      this.sessions.delete(input.playbackId);
      this.prune(nowMs);
      const state = previous ? this.airings.get(previous.trackKey) : null;
      return {
        heardSeconds: state ? coveredMs(state.coverage) / 1000 : 0,
        submitted: !!state?.submitted,
        trackKey: previous?.trackKey ?? null,
      };
    }

    const state = this.stateFor(input.airing, nowMs);
    if (!state.nowPlayingSent) {
      state.nowPlayingSent = true;
      this.callbacks.onNowPlaying(state.track);
    }

    if (gapOk && previous) {
      if (previous.trackKey === input.airing.key) {
        this.credit(input.airing.key, previous.lastSeenAtMs, nowMs);
      } else {
        // The controller knows the delayed audible boundary. Split the confirmed
        // interval there rather than assigning one heartbeat to both tracks.
        const boundary = Math.min(
          Math.max(input.airing.startedAtMs, previous.lastSeenAtMs),
          nowMs,
        );
        this.credit(previous.trackKey, previous.lastSeenAtMs, boundary);
        this.credit(input.airing.key, boundary, nowMs);
      }
    }
    this.sessions.set(input.playbackId, {
      trackKey: input.airing.key,
      lastSeenAtMs: nowMs,
    });
    this.prune(nowMs);
    return {
      heardSeconds: coveredMs(state.coverage) / 1000,
      submitted: state.submitted,
      trackKey: state.key,
    };
  }

  /** Tests and station switches can explicitly discard process-local state. */
  reset(): void {
    this.sessions.clear();
    this.airings.clear();
  }
}
