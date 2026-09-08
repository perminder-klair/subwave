// Outbound signalling for one spoken segment (#1382). The one place deciding
// what the world is told, shared by the four call sites that air speech.
//
// Two timebases: `airedAt` is the LIVE EDGE from radio.liq's own clock (what
// operator surfaces want), and a listener sits `streamBufferSeconds` behind it
// (#1114), which rides the payload so a consumer need not fetch /now-playing.
//
// When air time can't be known, `estimated: true` says so and the timestamps
// are OMITTED, never guessed.

import * as settings from '../settings.js';
import * as webhooks from './webhooks.js';

export interface SpokenSegment {
  /** Correlation id shared by this segment's voice.start / voice.end / dj.* . */
  voiceId: string;
  /** The `announce` kind — 'link', 'station-id', 'hourly-check', 'banter', … */
  kind: string;
  /** Mixer channel: 'intro' = light duck, 'say' = heavy duck. Passed by the
   *  caller, never derived from `kind` — a boundary-deferred ident is a
   *  'station-id' that airs on the INTRO channel. */
  channel: 'say' | 'intro';
  text: string;
  /** The clip's own length in ms (no lead-in/tail padding). */
  durationMs: number;
  /** Live-edge epoch ms, or null when the station couldn't measure it. */
  airedAt: number | null;
  personaId?: string | null;
  personaName?: string | null;
  /** Whether to also fire the legacy dj.say/dj.link event. Off for a banter
   *  line: the exchange fires ONE aggregate dj.say, while voice.start/end stay
   *  per line so a ducking consumer sees each real speech window. */
  legacy?: boolean;
}

// What is known BEFORE a segment airs: its identity plus a forecast of the
// wait. Fired when the station commits to speaking, so a consumer can prepare
// rather than react after the first words are out.
export interface QueuedSegment {
  /** The same id the eventual voice.start / voice.end carry. */
  voiceId: string;
  kind: string;
  channel: 'say' | 'intro';
  text: string;
  durationMs: number;
  /** Rough ms until the first word. A forecast, never a measurement — see below. */
  estimatedAirInMs: number;
  personaId?: string | null;
  personaName?: string | null;
}

// Bounds the voice.end timer so a mangled WAV header can't park one hours out.
const MAX_SEGMENT_MS = 90_000;

function bufferSeconds(): number {
  try {
    const s = settings.get() as { stream?: { bufferSeconds?: number } } | null;
    const n = Number(s?.stream?.bufferSeconds);
    return Number.isFinite(n) ? n : 22;
  } catch {
    return 22;
  }
}

// voice.queued → voice.start → voice.end, all three paired by `voiceId`.
//
// This fires when the station COMMITS to a clip, before the queue wait, the
// mixer poll and the lead-in — voice.start alone arrives when the words are
// already audible, too late to start a duck ramp. Anything syncing to the audio
// still keys off voice.start/voice.end.
//
// `estimatedAirInMs` is a FORECAST (the mixer poll and handoff write are
// unknown, and a jingle can extend it); `expectedAirAt` is the same figure as a
// timestamp. There is deliberately no `airedAt` — a field named for a
// measurement must never carry a guess.
export function notifyQueued(seg: QueuedSegment): void {
  const durationMs = Math.max(0, Math.min(MAX_SEGMENT_MS, Math.round(seg.durationMs) || 0));
  const estimatedAirInMs = Math.max(0, Math.round(seg.estimatedAirInMs) || 0);
  webhooks.notify('voice.queued', {
    voiceId: seg.voiceId,
    kind: seg.kind,
    channel: seg.channel,
    text: seg.text,
    durationMs,
    estimatedAirInMs,
    expectedAirAt: new Date(Date.now() + estimatedAirInMs).toISOString(),
    estimated: true,
    // The listener's offset from the live edge, so a consumer syncing to what
    // people HEAR doesn't have to look it up (#1114).
    streamBufferSeconds: bufferSeconds(),
    ...(seg.personaId ? { personaId: seg.personaId } : {}),
    ...(seg.personaName ? { personaName: seg.personaName } : {}),
  });
}

// Fire everything one segment owes the outside world:
//   voice.start        — now, stamped with the real air time when known
//   dj.say / dj.link   — the pre-existing events, unchanged in shape but now
//                        carrying duration + air time, and fired at AIR rather
//                        than at handoff
//   voice.end          — scheduled for the end of the speech
//
// Fire-and-forget like the fan-out underneath it; nothing here is awaited by a
// caller on the air path.
export function notifySpoken(seg: SpokenSegment): void {
  const channel = seg.channel;
  const durationMs = Math.max(0, Math.min(MAX_SEGMENT_MS, Math.round(seg.durationMs) || 0));
  const estimated = seg.airedAt == null;
  const endsAtMs = seg.airedAt != null ? seg.airedAt + durationMs : null;

  const identity = {
    voiceId: seg.voiceId,
    kind: seg.kind,
    channel,
    durationMs,
    // Omitted rather than nulled when unknown — see the header.
    ...(seg.airedAt != null ? { airedAt: new Date(seg.airedAt).toISOString() } : {}),
    estimated,
  };

  webhooks.notify('voice.start', {
    ...identity,
    text: seg.text,
    ...(endsAtMs != null ? { endsAt: new Date(endsAtMs).toISOString() } : {}),
    // The listener's offset from the live edge (#1114).
    streamBufferSeconds: bufferSeconds(),
    ...(seg.personaId ? { personaId: seg.personaId } : {}),
    ...(seg.personaName ? { personaName: seg.personaName } : {}),
  });

  // The original pair, kept for relays already subscribed. Existing fields stay
  // exactly where they were; everything else is additive.
  if (seg.legacy !== false) {
    webhooks.notify(seg.kind === 'link' ? 'dj.link' : 'dj.say', { text: seg.text, ...identity });
  }

  const delay = endsAtMs != null ? Math.max(0, endsAtMs - Date.now()) : durationMs;
  const timer = setTimeout(() => {
    webhooks.notify('voice.end', {
      ...identity,
      ...(endsAtMs != null ? { endedAt: new Date(endsAtMs).toISOString() } : {}),
    });
  }, Math.min(MAX_SEGMENT_MS, delay));
  // A pending end-of-speech ping must never hold the process open.
  timer.unref?.();
}
