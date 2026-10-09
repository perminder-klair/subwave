// Serialize handoff writes per file until Liquidsoap consumes them. airVoice also serializes
// playback across voice channels and waits for active jingles. #140, #310, #997.

import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { writeFileAtomicSync } from '../../util/atomic-file.js';
import * as settings from '../../settings.js';
import { sleep, type Interposed } from './pure.js';
import { awaitVoiceAir } from './voice-marker.js';

const _handoffChains: Map<string, Promise<void>> = new Map();

async function waitForConsumed(path: string, maxWaitMs: number) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await stat(path);
    } catch {
      return; // liquidsoap deleted it — file gone, safe to write next
    }
    await sleep(100);
  }
  // Timed out — file still on disk. Caller proceeds anyway.
}

export async function writeHandoff(path: string, contents: string | (() => string), { maxWaitMs = 1500, beforeWrite = () => true, onWritten }: { maxWaitMs?: number; beforeWrite?: () => boolean; onWritten?: () => void } = {}) {
  const prev = _handoffChains.get(path) || Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      // Make sure liquidsoap has already consumed whatever was there. If the
      // file doesn't exist (the common case — liquidsoap polled in the
      // meantime, or this is the first write of the session), this returns
      // immediately.
      if (existsSync(path)) await waitForConsumed(path, maxWaitMs);
      // Write-to-temp + rename so liquidsoap's poll never observes a
      // half-written (or truncated-but-empty) file — its poll handlers read,
      // DELETE, then check non-empty, so a poll landing mid-write would drop
      // this handoff silently. rename(2) is atomic on the same volume.
      if (!beforeWrite()) return false;
      writeFileAtomicSync(path, typeof contents === 'function' ? contents() : contents);
      onWritten?.();
      return true;
    });
  // Hold the slot until liquidsoap consumes THIS write too, so the next
  // queued writer waits for the audio to land, not just for the write call to
  // return. Errors don't break the chain — the .catch above ensures the next
  // writer still gets its turn.
  const release = next.then(() => waitForConsumed(path, maxWaitMs).catch(() => undefined));
  // The caller owns `next` and must see a failed write. The internal tail is
  // bookkeeping only: keep it fulfilled so a rejected write neither becomes
  // an unhandled rejection nor poisons the next writer for this file.
  _handoffChains.set(path, release.catch(() => undefined));
  return next;
}

// Serialize spoken playback across both voice channels, holding for the clip duration. The
// caller returns after its handoff; the next caller waits for playback to finish. #310.
let _voiceChain: Promise<void> = Promise.resolve();

export const VOICE_LEADIN_MS = 800;   // /sounds/leadin.wav pushed before each spoken clip
const VOICE_TAIL_MS = 700;     // duck ramp-back + poll/scheduling slack
// Forecast-only delay covers mixer polling and the silent lead-in. Actual air time comes
// from the marker. #1382.
export const HANDOFF_TO_AIR_MS = 250 + VOICE_LEADIN_MS;
// Cap a single hold so a wildly-wrong duration estimate (or a clip that never
// really aired) can't wedge the voice channel for minutes.
const VOICE_HOLD_MAX_MS = 90_000;

// What a caller gets back once its clip has been handed to Liquidsoap. The
// handoff itself is still awaited (this resolves at the same moment airVoice
// always did); `aired` is the new half — the air-time signal every consumer of
// a spoken segment was previously missing (#1382).
export interface VoiceHandoff {
  /** Correlation id, stamped into the clip's annotate: URI and echoed by the
   *  mixer's marker. Published on the voice.start/voice.end webhooks so a
   *  consumer can pair them. */
  voiceId: string;
  /** The clip's own length, WITHOUT the lead-in and duck-tail padding the
   *  serialiser's hold adds — i.e. how long the words actually last. */
  clipMs: number;
  /** Epoch ms the words hit the live edge, or null when that can't be known
   *  (a mixer that writes no marker, or a clip that never aired). Never
   *  rejects: bookkeeping has to run either way. */
  aired: Promise<number | null>;
}

// What a consumer is told the moment the station commits to speaking, before
// any of the waiting starts. `estimatedAirInMs` is a FORECAST and says so in
// its name — voice.start remains the only measured answer.
export interface QueuedVoice {
  voiceId: string;
  clipMs: number;
  estimatedAirInMs: number;
}

// Track estimated voice-chain availability synchronously for forecasts. Clip duration, fixed
// padding, and handoff latency make this unsuitable for scheduling decisions.
let _chainFreeAt = 0;

// Pure so the arithmetic is testable without a mixer. Two of the inputs are
// epoch ms deadlines the clip has to clear: the serialiser's current holder,
// and any jingle still audible. `jingleWindowMs` is that jingle's own total
// window — the SAME bound waitForJingleClear applies below, so the estimate a
// consumer prepares against and the sleep it actually takes cannot diverge.
export function airInEstimate(
  { now, chainFreeAt, jingleClearAt, jingleWindowMs = JINGLE_WAIT_CEILING_MS }:
    { now: number; chainFreeAt: number; jingleClearAt: number; jingleWindowMs?: number },
): { waitMs: number; estimatedAirInMs: number } {
  const jingleWait = jingleWaitMs(now, jingleClearAt, jingleWindowMs);
  const chainWait = Math.max(0, chainFreeAt - now);
  const waitMs = Math.max(chainWait, jingleWait);
  return { waitMs, estimatedAirInMs: waitMs + HANDOFF_TO_AIR_MS };
}

export async function airVoice(
  path: string,
  wavPath: string,
  text: string,
  gainDb = 0,
  // Fired SYNCHRONOUSLY, before this clip joins the voice chain — the early
  // half of the lifecycle a consumer needs in order to prepare for speech
  // rather than react to it (#1382 follow-up). Everything it reports is known
  // by now; nothing here waits on anything.
  {
    onQueued,
    voiceId: stableVoiceId,
    pauseDeliveryId = null,
    airMarkerPromise,
  }:
    {
      onQueued?: (q: QueuedVoice) => void;
      voiceId?: string;
      pauseDeliveryId?: string | null;
      airMarkerPromise?: Promise<number | null>;
    } = {},
): Promise<VoiceHandoff> {
  // Duration is read from the bare WAV path (header parse), so compute it BEFORE
  // wrapping — the annotate URI isn't a real file. The wrapped URI is only what
  // gets written to the handoff file for Liquidsoap to consume.
  const clipMs = clipDurationMs(wavPath, text);
  const holdMs = Math.min(VOICE_HOLD_MAX_MS, clipMs + VOICE_LEADIN_MS + VOICE_TAIL_MS);
  const voiceId = stableVoiceId || mintVoiceId();
  const uri = voiceUri(wavPath, gainDb, voiceId, pauseDeliveryId);
  const now = Date.now();
  const jingle = jingleWindow();
  const { waitMs, estimatedAirInMs } = airInEstimate({
    now, chainFreeAt: _chainFreeAt,
    jingleClearAt: jingle.clearAtMs, jingleWindowMs: jingle.windowMs,
  });
  // This clip's own turn, then its hold — what the NEXT caller will wait for.
  _chainFreeAt = now + waitMs + holdMs;
  if (onQueued) {
    // A misbehaving consumer must not take the air path down with it. The clip
    // still airs; only its early warning is lost.
    try { onQueued({ voiceId, clipMs, estimatedAirInMs }); } catch { /* ignore */ }
  }
  const turn = _voiceChain
    .catch(() => undefined)
    .then(async () => {
      // A jingle stinger may be on air (or inside the cross buffer) right now —
      // it plays outside this serialiser, so wait it out before handing over.
      await waitForJingleClear();
      return writeHandoff(path, uri);
    });
  // Extend the shared lock until this clip has (about) finished playing.
  _voiceChain = turn.then(() => sleep(holdMs)).then(() => {}, () => {});
  await turn;
  // Registered AFTER the handoff resolves, so the timeout measures the wait for
  // AIR and not the wait for this clip's turn on the shared voice chain (which
  // can legitimately be a whole segment long). The marker reader keeps a short
  // buffer of ids it saw first, so losing this race costs nothing.
  return {
    voiceId,
    clipMs,
    aired: airMarkerPromise ?? awaitVoiceAir(voiceId),
  };
}

// Short, URI-safe, and unique per clip — the whole job is telling one segment's
// marker from the next one's.
function mintVoiceId(): string {
  return randomBytes(6).toString('hex');
}

// Wait out the jingle marker's playback window before handing off speech. Keep the marker on
// disk; stale timestamps require no wait. Prefer mixer-measured duration, then WAV duration,
// then a bounded fallback. #997.

const JINGLE_FALLBACK_MS = 15_000; // clip length when nothing can measure it
const JINGLE_TAIL_MS = 1_000;      // Fade tail and polling slack.
// Bound clock-skewed waits by the clip's own window; this ceiling catches implausibly long clips.
const JINGLE_WAIT_CEILING_MS = 600_000;

// How recent a bed-playing.json startedAt must be to count as a live edge in
// onBedStarted. Detection latency is one 1.5s watcher tick; anything much
// older is the previous bed's marker surviving a controller restart (the file
// is never deleted, and the in-memory dedupe baseline doesn't persist).
export const BED_MARKER_FRESH_MS = 10_000;

// The guard window as two numbers: when the clip clears, and how long the window
// is in total. The second is what bounds the sleep — see jingleWaitMs. Exported
// as the test seam for the marker's durationSec precedence.
export function jingleWindow(): { clearAtMs: number; windowMs: number } {
  const none = { clearAtMs: 0, windowMs: 0 };
  try {
    const m = JSON.parse(readFileSync(config.liquidsoap.jinglePlayingFile, 'utf8'));
    const startedMs = Number(m?.startedAt) * 1000; // liquidsoap time() is unix seconds
    if (!Number.isFinite(startedMs) || startedMs <= 0) return none;
    // Liquidsoap's own measurement first (any container), then the RIFF parse
    // for markers from an older broadcast image, then the blind fallback.
    const measuredSec = Number(m?.durationSec);
    const clipMs = (Number.isFinite(measuredSec) && measuredSec > 0 ? measuredSec * 1000 : 0)
      || (typeof m?.filename === 'string' && wavDurationMs(m.filename))
      || JINGLE_FALLBACK_MS;
    const crossMs = (Number(settings.get()?.crossfadeDuration) || 10) * 1000;
    const windowMs = clipMs + crossMs + JINGLE_TAIL_MS;
    return { clearAtMs: startedMs + windowMs, windowMs };
  } catch {
    return none; // no marker (or unreadable) — nothing on air to avoid
  }
}

// When the marker last reported THIS jingle starting, or 0. Used by
// queue.playJingle to retire a pending press once it has been heard. Matched on
// the basename because the marker carries Liquidsoap's resolved path while the
// caller holds a library filename.
export function jingleAiredAtMs(filename: string): number {
  try {
    const m = JSON.parse(readFileSync(config.liquidsoap.jinglePlayingFile, 'utf8'));
    if (typeof m?.filename !== 'string') return 0;
    if (m.filename.split('/').pop() !== filename) return 0;
    const startedMs = Number(m?.startedAt) * 1000;
    return Number.isFinite(startedMs) && startedMs > 0 ? startedMs : 0;
  } catch {
    return 0;
  }
}

// What the mixer placed between the previous song and the one starting now, if
// anything: the latest jingle, bed or pause-and-talk marker stamped after the
// previous song started. All three are written at cross-FEED time, a whole
// song after `prevStartedMs` (itself a tick late), so the comparison has
// minutes of margin. A marker from before the previous song — the files are
// never deleted — is not after it and so never counts. Unreadable or absent
// markers count as nothing interposed: this only labels a record.
export function interposedSince(prevStartedMs: number, now = Date.now()): Interposed | null {
  if (!Number.isFinite(prevStartedMs) || prevStartedMs <= 0) return null;
  const markers: Array<[Interposed, string]> = [
    ['jingle', config.liquidsoap.jinglePlayingFile],
    ['bed', config.liquidsoap.bedPlayingFile],
    ['break', config.liquidsoap.pauseTalkPlayingFile],
  ];
  let found: Interposed | null = null;
  let latest = 0;
  for (const [kind, file] of markers) {
    try {
      const startedMs = Number(JSON.parse(readFileSync(file, 'utf8'))?.startedAt) * 1000;
      if (Number.isFinite(startedMs) && startedMs > prevStartedMs && startedMs <= now && startedMs > latest) {
        found = kind;
        latest = startedMs;
      }
    } catch {
      // no marker — nothing of this kind has aired
    }
  }
  return found;
}

// Bound a jingle hold by remaining time, its own window, and the absolute ceiling. Forecasts
// and delivery share this calculation.
export function jingleWaitMs(now: number, clearAtMs: number, windowMs: number): number {
  return Math.max(0, Math.min(clearAtMs - now, windowMs, JINGLE_WAIT_CEILING_MS));
}

async function waitForJingleClear() {
  const { clearAtMs, windowMs } = jingleWindow();
  const waitMs = jingleWaitMs(Date.now(), clearAtMs, windowMs);
  if (waitMs > 0) await sleep(waitMs);
}

// Annotate every voice clip with liq_amplify for gain and subwave_voice for marker matching.
// Leave the separate silent lead-in unannotated so it cannot produce the clip's air marker.
// #1382.
export function voiceUri(
  wavPath: string,
  gainDb: number,
  voiceId: string,
  pauseDeliveryId: string | null = null,
): string {
  const meta = [`subwave_voice="${voiceId}"`];
  if (pauseDeliveryId) meta.push(`subwave_pause_delivery="${pauseDeliveryId}"`);
  if (gainDb !== 0) meta.unshift(`liq_amplify="${gainDb} dB"`);
  return `annotate:${meta.join(',')}:${wavPath}`;
}

// Best-effort playback duration of the clip ITSELF. Reads the exact length from
// a WAV header (the local engines), and estimates from word count for anything
// else (cloud mp3). This is the figure published to consumers as `durationMs` —
// the padding below belongs to the serialiser's hold, not to the speech.
export function clipDurationMs(wavPath: string, text: string): number {
  return wavDurationMs(wavPath) ?? estimateSpeechMs(text);
}

// The clip plus the lead-in and duck-tail padding: what the voice chain holds
// its lock for, and what the drain budgets a segment at.
export function speechDurationMs(wavPath: string, text: string): number {
  return clipDurationMs(wavPath, text) + VOICE_LEADIN_MS + VOICE_TAIL_MS;
}

// ~140 wpm, deliberately on the slow side so we over-, never under-estimate
// (an over-estimate just adds a little dead air; an under-estimate lets the
// next segment clip in over the tail).
function estimateSpeechMs(text: string): number {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil((words / 2.3) * 1000);
}

// Duration from a WAV header (byteRate from `fmt `, byte count from `data`).
// Returns null for non-WAV or anything it can't parse, so the caller falls back
// to the word-count estimate. Reads only the first 4KB — headers are tiny.
function wavDurationMs(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 12 || head.toString('ascii', 0, 4) !== 'RIFF'
        || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let byteRate = 0;
    let dataSize = 0;
    let off = 12;
    while (off + 8 <= n) {
      const id = head.toString('ascii', off, off + 4);
      const size = head.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        byteRate = head.readUInt32LE(off + 8 + 8);   // fmt body offset 8 → byteRate
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      off += 8 + size + (size % 2);   // chunks are word-aligned
    }
    if (!byteRate) return null;
    // Streamed WAVs sometimes write a bogus/placeholder data size — fall back
    // to the real file size minus the header we walked.
    if (!dataSize || dataSize > 0x7fffffff) {
      dataSize = Math.max(0, statSync(path).size - (off + 8));
    }
    if (!dataSize) return null;
    return Math.ceil((dataSize / byteRate) * 1000);
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}
