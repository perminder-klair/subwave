// How much of a woken station's stale idle silence this listener may skip (#2072).
//
// While the idle gate holds the programme, every mount serves blank(), so the
// burst-on-connect of a listener who tunes in is stream.bufferSeconds of
// silence, and the programme they woke reaches them only after it. The web
// player drops most of that silence on tune-in. It keeps SKIP_CUSHION_SECONDS
// of it, because the silence is also the listener's stall cushion. Sonos,
// hardware radios and anything else reading the mount directly hear all of it.
//
// The answer is in lag terms: how far behind the live edge the listener may
// move. A fresh connection sits stream.bufferSeconds behind (a little more in
// practice, since the burst is a byte count and startup adds to it, so the
// advertised figure is a floor). Everything between the listener and the live
// edge is silence back to the moment the programme resumed, so they may close
// up to that moment plus MUSIC_MARGIN_SECONDS, never past it, and never nearer
// than the cushion. Closing up later is fine: the answer shrinks as `now`
// moves on, so a caller asks again each time it checks.
//
// The shed starts at the head of the burst, so the head must be silence too:
// the pause must predate the connection by more than any burst the mounts can
// render (MAX_BURST_SECONDS), not just the advertised one. `/now-playing`
// advertises the burst the running mounts were rendered with (#2142), but
// against a broadcast image older than that it falls back to the setting, which
// is saved at once while Icecast's <burst-size> is rendered when the broadcast
// pair starts. An operator there who LOWERS bufferSeconds without a restart
// advertises less than a connection gets, and checking the pause against the
// advertised figure would fast-forward the music before the pause. The cost is
// that a listener who tunes in within a minute of the pause engaging skips
// nothing. That is rare, since the pause itself engages only after a minute or
// more of empty room.
//
// Known limits, both from the mounts bursting something other than advertised:
//   - On a broadcast image older than #2142, a RAISED bufferSeconds without a
//     restart advertises more than a connection gets. A woken listener's shed
//     then runs on to the live edge, and the start of the music their
//     connection resumed passes fast before `waiting` stops it.
//   - A burst longer than MAX_BURST_SECONDS can still put music at the head.
//     The entrypoint caps the seconds it multiplies by a bitrate, and an
//     ICECAST_STREAM_BITRATE above the encoder's sizes the MP3 burst for a
//     faster stream than the one it holds (60 s at 320 against a 192k encoder
//     is a 100 s burst). A saved bitrate cannot do it: the renderer reads it
//     once and hands the same value to the encoder (#2143).
//
// The server's inputs are ages measured on its own clock when it answered
// (`GET /state`'s `streamIdleWindow`), and the client's are readings of one
// local clock, so the two clocks are never compared and a skewed one cannot
// move the answer. Each age is widened in the direction that skips less:
//   - The pause must cover the whole burst, so its age at the connection is
//     taken as late as possible: from the read's arrival back to the stream
//     request, which went out before Icecast accepted it.
//   - The resume's age is taken as early as possible: from when the read was
//     sent, after the first audio arrived, which is after Icecast accepted it.
//     A station still paused when the read was answered is counted as
//     resuming at that moment, since this listener's own connection wakes it.
//     That holds because the controller publishes the pause as ended the
//     moment its idle_off goes out, before the mixer (which can resume first)
//     answers, so "still paused" means the command had not been sent.
// A read sent before the first audio arrived cannot vouch for the burst, so it
// skips nothing, and so does anything missing or malformed: the listener hears
// today's behaviour.

import { STREAM_BUFFER_SECONDS_BOUNDS } from './schemas.generated';
import type { IdleWindow } from './types';

/** The longest burst the mounts can render, whatever is advertised: the
 *  setting's upper bound, which docker/broadcast-entrypoint.sh (and the AIO's
 *  render_icecast()) also clamps the rendered seconds to. */
export const MAX_BURST_SECONDS = STREAM_BUFFER_SECONDS_BOUNDS.max;
/** Silence kept ahead of the listener after a skip: their stall cushion. */
export const SKIP_CUSHION_SECONDS = 5;
/** How far short of the first music (either side of the pause) a skip stops. */
export const MUSIC_MARGIN_SECONDS = 1;
/** A smaller skip isn't worth moving the listener's offset for. */
export const MIN_SKIP_SECONDS = 1;

export interface IdleSkipInput {
  /** The station's advertised stream.bufferSeconds. */
  bufferSeconds: number | null | undefined;
  /** `streamIdleWindow` from a /state read made for this connection. */
  window: IdleWindow | null | undefined;
  /** Local ms when the stream request went out. */
  requestedAt: number;
  /** Local ms when the first audio arrived. */
  firstAudioAt: number;
  /** Local ms when the /state read was sent, and when it came back. */
  readSentAt: number;
  readReceivedAt: number;
  /** Local ms now. */
  now: number;
}

const finiteAge = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Seconds of lag this listener may shed at `input.now`; 0 means leave the
 *  stream alone. */
export function idleSkipSeconds(input: IdleSkipInput): number {
  const { bufferSeconds: buffer, window, requestedAt, firstAudioAt, readSentAt, readReceivedAt, now } = input;
  if (typeof buffer !== 'number' || !Number.isFinite(buffer) || buffer <= SKIP_CUSHION_SECONDS) return 0;
  if (!window || !finiteAge(window.startedMsAgo)) return 0;
  const ended = window.endedMsAgo;
  if (ended !== null && (!finiteAge(ended) || ended > window.startedMsAgo)) return 0;
  if (![requestedAt, firstAudioAt, readSentAt, readReceivedAt, now].every(Number.isFinite)) return 0;
  if (firstAudioAt < requestedAt || readSentAt < firstAudioAt || readReceivedAt < readSentAt || now < readReceivedAt) return 0;

  // Against the longest burst the mounts can render, never the advertised one,
  // which can be shorter than the running mounts' (header).
  const pausedBeforeConnect = (window.startedMsAgo - (readReceivedAt - requestedAt)) / 1000;
  if (pausedBeforeConnect < Math.max(buffer, MAX_BURST_SECONDS) + MUSIC_MARGIN_SECONDS) return 0;

  const resumedAgo = ((ended ?? 0) + (now - readSentAt)) / 1000;
  const keep = Math.max(SKIP_CUSHION_SECONDS, resumedAgo + MUSIC_MARGIN_SECONDS);
  const skip = buffer - keep;
  return skip >= MIN_SKIP_SECONDS ? skip : 0;
}
