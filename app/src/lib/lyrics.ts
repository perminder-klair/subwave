// Synced lyrics for the track this listener is hearing, copied from the web
// so the two players time lines alike. Sources of truth, each kept in sync by
// scripts/lyrics.test.ts:
//   - web/components/skins/lyrics.ts, the pure half: every function and
//     constant it shares with this file keeps the web's body;
//   - web/components/skins/classic/AmbientLyrics.tsx, the focus rule
//     (lyricFocusLine) and the tick;
//   - web/lib/stationClient.ts currentLyrics, the status mapping
//     (lyricsResultFor);
//   - controller/src/schemas/lyrics.ts, the payload, its sources and the
//     offset bounds, which parseLyricsPayload checks by hand (no zod here).
// The app has no admin sign-in, so it applies the station's per-track offset
// but never edits it: the only correction a listener makes is this device's
// own nudge.

import type { LyricsSource, PublicLyricLine, PublicLyricsPayload } from './types';

// The controller's bounds on either correction (LYRIC_OFFSET_MIN_MS/MAX_MS).
export const LYRIC_OFFSET_MIN_MS = -30_000;
export const LYRIC_OFFSET_MAX_MS = 30_000;
export const LYRIC_OFFSET_STEP_MS = 50;
export const LYRIC_OFFSET_NUDGE_MS = 100;

// How long the stage stays laid out for lyrics after they stop showing.
// Between two tracks that both have them the new lines take a moment to load,
// and dropping out of the lyrics layout for that moment would flick the page.
export const LYRICS_LAYOUT_HOLD_MS = 1500;

// The web's phone layout needs a screen at least this tall, and below it
// leaves the lyrics out so the track info keeps the room
// (AmbientLyrics' max-height:699px rule). Points here, CSS pixels there.
export const LYRICS_MIN_SCREEN_HEIGHT = 700;

// Backoff for a station that did not answer: 5s, 10s, 20s, 40s, then every
// 60s while lyrics stay on. A Retry-After waits longer, up to that same
// minute: the station's own lyrics retry asks for 10s, and a station-read
// 429, which can ask for minutes, answers an early ask with another 429
// without spending an attempt.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

// A station still looking a track up on LRCLIB says `pending`, and asks
// LRCLIB again 5s and 15s later, so the app keeps asking for 40s; past that
// it keeps what it has.
export const PENDING_RECHECK_MS = 4_000;
export const PENDING_MAX_ASKS = 10;

export type LyricsStatus =
  /** No library track to ask about. */
  | 'idle'
  | 'loading'
  | 'ready'
  /** The station or the network did not answer; the hook is asking again. */
  | 'unavailable'
  /** The operator has the Lyrics panel switched off. */
  | 'disabled'
  /** The track left the station's recent-play window before we asked. */
  | 'gone'
  /** A private station refused the stored password (or there is none). */
  | 'locked';

/** How `GET /lyrics/current` answered. `unavailable` is the only kind worth
 *  asking again: the music server (or the network) did not answer. `locked`
 *  is never retried, since every refusal spends the address's station-read
 *  attempts (20 per 15 minutes, shared by a household). */
export type LyricsResult =
  | { kind: 'ok'; payload: PublicLyricsPayload }
  | { kind: 'disabled' }
  | { kind: 'gone' }
  | { kind: 'locked' }
  | { kind: 'unavailable'; retryAfterSec: number | null };

export const LYRICS_SOURCES: readonly LyricsSource[] = ['music-server', 'lrclib'];

function parseLine(raw: unknown): PublicLyricLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const { startMs, text } = raw as Record<string, unknown>;
  if (typeof text !== 'string') return null;
  if (startMs === null) return { startMs: null, text };
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return null;
  return { startMs, text };
}

/** The payload, or null when it is not one: the schema's rules, by hand,
 *  since the app carries no zod. A source this app does not know reads as
 *  null rather than failing the whole payload, as on the web. */
export function parseLyricsPayload(raw: unknown): PublicLyricsPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const { songId, synced, offsetMs, lines, source, pending } = body;
  if (songId !== null && typeof songId !== 'string') return null;
  if (typeof synced !== 'boolean') return null;
  if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) return null;
  if (!Array.isArray(lines)) return null;
  if (pending !== undefined && typeof pending !== 'boolean') return null;
  const parsed: PublicLyricLine[] = [];
  for (const line of lines) {
    const ok = parseLine(line);
    if (!ok) return null;
    parsed.push(ok);
  }
  const payload: PublicLyricsPayload = { songId, synced, offsetMs, lines: parsed };
  if (source !== undefined) {
    payload.source = LYRICS_SOURCES.includes(source as LyricsSource) ? (source as LyricsSource) : null;
  }
  if (pending !== undefined) payload.pending = pending;
  return payload;
}

/** Map one response to a result. `body` is the parsed JSON, or undefined when
 *  it was not JSON. */
export function lyricsResultFor(status: number, retryAfter: string | null, body: unknown): LyricsResult {
  if (status === 403) return { kind: 'disabled' };
  if (status === 409) return { kind: 'gone' };
  if (status === 401) return { kind: 'locked' };
  if (status < 200 || status >= 300) {
    const sec = Number(retryAfter);
    return { kind: 'unavailable', retryAfterSec: Number.isFinite(sec) && sec > 0 ? sec : null };
  }
  const payload = parseLyricsPayload(body);
  return payload ? { kind: 'ok', payload } : { kind: 'unavailable', retryAfterSec: null };
}

export interface LyricsAnswer {
  status: LyricsStatus;
  lyrics: PublicLyricsPayload | null;
}

/** An answer, and the track it answers for. */
export interface TrackAnswer extends LyricsAnswer {
  songId: string | null;
}

/** Synced lines, which the stage plays along with the song. */
export function syncedLyricsReady({ status, lyrics }: LyricsAnswer): boolean {
  return status === 'ready' && !!lyrics?.synced && lyrics.lines.length > 0;
}

/** Untimed lines, which the stage shows in the same place to scroll by hand. */
export function plainLyricsReady({ status, lyrics }: LyricsAnswer): boolean {
  return status === 'ready' && !!lyrics && !lyrics.synced && lyrics.lines.length > 0;
}

/** One line for the lyrics settings on what this track has, or why nothing. */
export function lyricsNote(track: LyricsAnswer, shown: boolean): string {
  if (!shown) return 'Hidden on this device.';
  const { status, lyrics } = track;
  if (status === 'disabled') return 'The station has lyrics switched off.';
  if (status === 'loading') return 'Looking for lyrics…';
  if (status === 'unavailable') return 'The station isn’t answering. Trying again…';
  if (status === 'idle') return 'No lyrics right now.';
  if (status !== 'ready' || !lyrics) return 'No lyrics for this song.';
  if (syncedLyricsReady(track)) {
    return lyrics.source === 'lrclib' ? 'Synced lyrics, from LRCLIB.' : 'Synced lyrics, from the station’s library.';
  }
  if (plainLyricsReady(track)) {
    return lyrics.pending
      ? 'Untimed for now, still looking for synced ones.'
      : 'Not timed, so they don’t follow the song. Scroll through them.';
  }
  return lyrics.pending ? 'Looking for lyrics…' : 'No lyrics for this song.';
}

export function clampLyricOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(LYRIC_OFFSET_MAX_MS, Math.max(LYRIC_OFFSET_MIN_MS, Math.round(value)));
}

export function formatLyricOffset(ms: number): string {
  if (ms === 0) return '0.00s';
  return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(2)}s`;
}

/** The line being sung `elapsedMs` into the track, -1 before the first. */
export function activeLyricLineIndex(
  lyrics: PublicLyricsPayload | null,
  elapsedMs: number,
  offsetMs: number,
): number {
  if (!lyrics?.synced) return -1;
  // The corrections apply to the clock, never to the lines.
  const adjustedElapsedMs = Math.max(0, elapsedMs + offsetMs);
  let active = -1;
  for (let i = 0; i < lyrics.lines.length; i += 1) {
    const startMs = lyrics.lines[i]?.startMs;
    if (startMs == null) continue;
    if (startMs > adjustedElapsedMs) break;
    active = i;
  }
  return active;
}

// How a line is paced when only its start is known (LRC times lines, not
// words): roughly this long per word, never under the floor, and never past the
// next line. A line left up longer than LINE_HOLD_MS with nothing following is
// an instrumental break, so the stage rests; the line after it is teased
// TEASE_MS before it is sung.
const WORD_MS = 380;
const MIN_SUNG_MS = 900;
export const LINE_HOLD_MS = 9_000;
export const TEASE_MS = 3_500;

export interface LyricMoment {
  /** The line being sung, or -1 in an intro, a break, or after the last line. */
  current: number;
  /** How far through `current`'s words the singing is, 0 to 1. */
  progress: number;
  /** The line to show faintly after it, or -1. */
  next: number;
  /** Nothing is being sung: an intro, an instrumental break or the outro. */
  resting: boolean;
}

/** What the lyrics display shows at `positionMs` on the lyric clock. Its
 *  word count is lyricWordCount's, inlined to keep the web's body. */
export function lyricMoment(lyrics: PublicLyricsPayload | null, positionMs: number): LyricMoment {
  const lines = lyrics?.synced ? lyrics.lines : [];
  const at = (i: number) => lines[i]?.startMs;
  const firstTimed = lines.findIndex((l) => l.startMs != null);
  if (firstTimed < 0) return { current: -1, progress: 0, next: -1, resting: false };

  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = at(i);
    if (start == null) continue;
    if (start > positionMs) break;
    active = i;
  }
  let following = -1;
  for (let i = active + 1; i < lines.length; i++) {
    if (at(i) != null) {
      following = i;
      break;
    }
  }
  const teased = (i: number) => (i >= 0 && (at(i) as number) - positionMs <= TEASE_MS ? i : -1);

  if (active < 0) return { current: -1, progress: 0, next: teased(firstTimed), resting: true };

  const start = at(active) as number;
  const nextStart = following >= 0 ? (at(following) as number) : Number.POSITIVE_INFINITY;
  // Past the hold with the next line still far off: a break, not a held note.
  if (positionMs - start > LINE_HOLD_MS && nextStart - start > LINE_HOLD_MS) {
    return { current: -1, progress: 0, next: teased(following), resting: true };
  }
  const words = lines[active]?.text.split(/\s+/).filter(Boolean).length || 1;
  const sungMs = Math.min(Math.max(words * WORD_MS, MIN_SUNG_MS), nextStart - start);
  const progress = Math.min(1, Math.max(0, (positionMs - start) / sungMs));
  return { current: active, progress, next: following, resting: false };
}

/** The line the column centres: the one being sung; in an intro or a break,
 *  the one to come; after the last, the last. AmbientLyrics' SyncedColumn
 *  works this out inline; `positionMs` already carries both corrections. */
export function lyricFocusLine(lyrics: PublicLyricsPayload, moment: LyricMoment, positionMs: number): number {
  if (moment.current >= 0) return moment.current;
  return Math.min(lyrics.lines.length - 1, activeLyricLineIndex(lyrics, positionMs, 0) + 1);
}

/** How many words lyricMoment paces `text` by. */
export function lyricWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** `text` split for lighting word by word: the spaces are kept, so wrapping
 *  sees the real text, and each word carries its place among lyricWordCount's
 *  words (-1 on a space). */
export function lyricWordParts(text: string): { part: string; index: number }[] {
  const parts: { part: string; index: number }[] = [];
  let words = 0;
  for (const part of text.split(/(\s+)/)) {
    if (part) parts.push({ part, index: part.trim() ? words++ : -1 });
  }
  return parts;
}

/** When to ask again about an answer marked `pending`, after `asks` such asks;
 *  null once the app should settle for what it has. */
export function pendingRecheckDelayMs(asks: number): number | null {
  return asks < PENDING_MAX_ASKS ? PENDING_RECHECK_MS : null;
}

/** How long to wait before asking again after the `attempt`th miss (0-based). */
export function lyricsRetryDelayMs(attempt: number, retryAfterSec: number | null): number {
  const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
  const floor = retryAfterSec != null && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
  return Math.max(backoff, Math.min(floor, RETRY_MAX_MS));
}

/** An answer that asking again would not change. */
export function lyricsSettled(answer: LyricsAnswer): boolean {
  if (answer.status === 'ready') return !answer.lyrics?.pending;
  return answer.status === 'disabled' || answer.status === 'gone' || answer.status === 'locked';
}

/** What one reply to `GET /lyrics/current?songId=id` does to the ask loop in
 *  useTrackLyrics. */
export interface LyricsStep {
  /** The answer to show, given the one showing (a state updater). */
  answer: (shown: TrackAnswer) => TrackAnswer;
  /** When to ask again, or null to stop asking. */
  askAgainMs: number | null;
  /** That ask is a recheck of a pending answer, which counts toward
   *  PENDING_MAX_ASKS, rather than a retry, which counts toward the backoff. */
  recheck: boolean;
}

/** `attempt` is the retries already made in this run of the loop;
 *  `pendingAsks` is the rechecks already made for this track in any run, so
 *  the cap holds across trips to the background. */
export function lyricsStep(id: string, result: LyricsResult, attempt: number, pendingAsks: number): LyricsStep {
  if (result.kind === 'ok') {
    // The station answers for the id it was asked about; anything else
    // cannot be shown as this track's lyrics.
    if (result.payload.songId !== id) {
      return { answer: () => ({ songId: id, status: 'gone', lyrics: null }), askAgainMs: null, recheck: false };
    }
    // Shown at once, and asked again while the station says a better answer
    // (LRCLIB's timed lyrics) may be on its way. Once the app stops asking,
    // it stops saying it is looking.
    const delay = result.payload.pending ? pendingRecheckDelayMs(pendingAsks) : null;
    const payload = result.payload.pending && delay == null ? { ...result.payload, pending: false } : result.payload;
    return { answer: () => ({ songId: id, status: 'ready', lyrics: payload }), askAgainMs: delay, recheck: true };
  }
  if (result.kind !== 'unavailable') {
    const status = result.kind;
    return { answer: () => ({ songId: id, status, lyrics: null }), askAgainMs: null, recheck: false };
  }
  // Unlike the web, lyrics already showing stay up while the station does not
  // answer a recheck: a phone drops requests far more often than a desk, and
  // blanking them would flip the Live page out of its lyrics layout for the
  // backoff. They stop claiming a better answer is coming, since nothing says
  // so any more; a later answer can say it again.
  const answer = (shown: TrackAnswer): TrackAnswer => {
    if (shown.songId !== id || !shown.lyrics) return { songId: id, status: 'unavailable', lyrics: null };
    return shown.lyrics.pending ? { ...shown, lyrics: { ...shown.lyrics, pending: false } } : shown;
  };
  return { answer, askAgainMs: lyricsRetryDelayMs(attempt, result.retryAfterSec), recheck: false };
}
