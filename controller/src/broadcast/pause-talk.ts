// Pause-and-talk policy. The decision is deliberately pure: rendering is the
// first point at which a segment's real duration is known, while the queue is
// the only place that may turn that decision into a music-timeline handoff.
//
// The shape (#551): a SILENT item rides the music timeline through next.txt,
// and the voice itself still goes down say.txt. Sending the clip down the music
// path instead would strip it of mic_chain and edge_fade (radio.liq applies
// both to voice_queue/intro_queue only), making the one segment on the station
// with no processing on it, and would need a parallel set of air-time stamps.

/** The next song's ramp-in under the tail of the break. Stamped on the silence
 *  item, so `cross` sizes the transition OUT of it from this. */
export const PAUSE_TALK_EXIT_CROSS_SEC = 1.5;
/** now-playing.json tick — how long the marker can sit before we see it. */
export const PAUSE_TALK_MARKER_POLL_MS = 1_500;
/** radio.liq's say.txt poll. */
export const PAUSE_TALK_SAY_POLL_MS = 500;
/** Marker observation plus the mixer picking the clip up. */
export const PAUSE_TALK_RELEASE_LATENCY_MS = PAUSE_TALK_MARKER_POLL_MS + PAUSE_TALK_SAY_POLL_MS;
/** Slack on top of every measured term. A little extra silence is recoverable;
 *  a short one cuts speech off with the incoming track. */
export const PAUSE_TALK_SAFETY_MS = 1_000;
/** How long a committed break may wait for its marker before the queue gives up
 *  and falls back to ducked delivery. Past a long album cut, so a break armed
 *  behind a sent-but-unaired track still gets its boundary. */
export const PAUSE_TALK_ARM_MAX_AGE_MS = 15 * 60_000;
/** On recovery only: enough for an older mixer's say poll + silent lead-in to
 *  publish its generic start marker when no acceptance marker exists. */
export const PAUSE_TALK_RECOVERY_AMBIGUITY_MS = 1_500;

export function wantsPauseTalk({
  enabled,
  eligible,
  clipMs,
  minSeconds,
}: {
  enabled: boolean;
  eligible: boolean;
  clipMs: number | null | undefined;
  minSeconds: number | null | undefined;
}): boolean {
  const thresholdMs = Number(minSeconds) * 1000;
  return enabled
    && eligible
    && Number.isFinite(clipMs)
    && (clipMs as number) > 0
    && Number.isFinite(thresholdMs)
    && (clipMs as number) >= thresholdMs;
}

// How much silence to write. Four terms, all of them real:
//
//   [ incoming cross ][ release latency ][ voice window ][ exit cross ][ safety ]
//   ^ outgoing song                      ^ DJ speaks                  ^ next song
//     still fading                         in the clear                 already up
//
// `cross` sizes a transition from the OUTGOING track's liq_cross_duration
// (radio.liq's dj_transition reads `a.metadata`), so the previous song's tail
// is mixed over the HEAD of this silence for its own crossfade duration —
// 10s on the station default. Un-budgeted, that is where the whole segment
// lands, and a break that plays under a fading song is the ducking this
// feature exists to replace. The release is delayed to match (releaseDelayMs).
export function silenceDurationMs({
  voiceWindowMs,
  incomingCrossMs,
}: {
  voiceWindowMs: number;
  incomingCrossMs: number;
}): number {
  const cross = Number.isFinite(incomingCrossMs) ? Math.max(0, incomingCrossMs) : 0;
  return Math.ceil(
    cross
    + PAUSE_TALK_RELEASE_LATENCY_MS
    + Math.max(0, voiceWindowMs)
    + PAUSE_TALK_EXIT_CROSS_SEC * 1000
    + PAUSE_TALK_SAFETY_MS,
  );
}

// A silence item overlaps the outgoing song on the way in and the incoming
// song on the way out. Forecasts need the part between those overlaps: that is
// the time the otherwise-next track is genuinely pushed back on the music
// timeline.
export function pauseTimelineDelayMs({
  silenceMs,
  incomingCrossMs,
  exitCrossMs = PAUSE_TALK_EXIT_CROSS_SEC * 1000,
}: {
  silenceMs: number;
  incomingCrossMs: number;
  exitCrossMs?: number;
}): number {
  const duration = Number.isFinite(silenceMs) ? Math.max(0, silenceMs) : 0;
  const incoming = Number.isFinite(incomingCrossMs) ? Math.max(0, incomingCrossMs) : 0;
  const outgoing = Number.isFinite(exitCrossMs) ? Math.max(0, exitCrossMs) : 0;
  return Math.max(0, duration - incoming - outgoing);
}

export type TalkPlacement = 'immediate' | 'next-track' | 'pause-talk';

// Pause-and-talk is the more specific placement. A station-wide request to put
// scheduled speech at boundaries must not downgrade a qualifying show's real
// break back to the ordinary light-duck intro path.
export function resolveTalkPlacement({
  pauseTalk,
  talkAir,
}: {
  pauseTalk: boolean;
  talkAir: 'immediate' | 'next-track';
}): TalkPlacement {
  if (pauseTalk) return 'pause-talk';
  return talkAir;
}

// How long to wait after SEEING the marker before opening the mic, so the
// outgoing song's crossfade tail has finished. Measured from the silence's own
// start (radio.liq stamps `startedAt`), not from the observation, so the poll
// latency that already elapsed is credited rather than paid twice.
export function releaseDelayMs({
  incomingCrossMs,
  elapsedSinceStartMs,
}: {
  incomingCrossMs: number;
  elapsedSinceStartMs: number;
}): number {
  const cross = Number.isFinite(incomingCrossMs) ? Math.max(0, incomingCrossMs) : 0;
  const elapsed = Number.isFinite(elapsedSinceStartMs) ? Math.max(0, elapsedSinceStartMs) : 0;
  return Math.max(0, Math.ceil(cross - elapsed));
}

// A committed break whose silence never reached the mixer must not pin the one
// pending-voice slot forever. Past this the queue disarms and the clip falls
// back to ordinary ducked boundary delivery.
export function pauseTalkArmExpired(armedAt: number | null | undefined, nowMs: number): boolean {
  if (!Number.isFinite(armedAt)) return true;
  return nowMs - (armedAt as number) > PAUSE_TALK_ARM_MAX_AGE_MS;
}
