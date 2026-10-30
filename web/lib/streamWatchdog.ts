// What the web player's stall watchdog does when its timer fires. hooks/usePlayer.ts
// owns the timer, the media listeners and the reconnect itself.
//
// `stalled` is a network event and fires routinely on a live mount while
// playback carries on from buffer, so the first fire judges the media clock
// against its reading when the watchdog was armed: a clock that moved means the
// listener is hearing audio, and re-setting src would cut it for nothing (#1232).
//
// A clock that moved says nothing about whether it is still moving. Firefox with
// the bytes gone can creep on a little past the `stalled`, then sit there at
// readyState 4 and paused false with no further event: no `waiting`, no `ended`,
// no `error` (measured, 2 of 4 stall runs, on Icecast with the socket left open).
// So a fire that finds the clock moved looks again, and each look after the first
// is judged on the clock alone: a healthy mount costs one timer for as long as
// the stall stays unresolved, and only a clock that stood still for a whole
// window reconnects. `playing` clears the timer, which is the clean way out.
//
// A later look stands down on a paused element. The OS can pause the element
// without telling the player (a call, AirPods coming out), and a look that
// reconnected would start the audio again behind the listener's back. The first
// fire keeps its old rule on purpose: this is about not adding a reconnect.
// `ended` is paused too, but it is the stream dying, not the listener leaving.

// HTMLMediaElement.HAVE_FUTURE_DATA, read as a constant so the checks work on a detached element.
export const HAVE_FUTURE_DATA = 3;

export type WatchdogCall = 'reconnect' | 'keep-watching' | 'stand-down';

export type MediaClock = Pick<HTMLMediaElement, 'paused' | 'ended' | 'readyState' | 'currentTime'>;

/** `armedAt` is the media clock when this timer was armed. `rewatch` is true
 *  for every look after the first, which keep-watching arms. */
export function watchdogCall(el: MediaClock, armedAt: number, rewatch: boolean): WatchdogCall {
  const moved = el.currentTime > armedAt;
  if (!rewatch) return !el.paused && el.readyState >= HAVE_FUTURE_DATA && moved ? 'keep-watching' : 'reconnect';
  if (el.ended) return 'reconnect';
  if (el.paused) return 'stand-down';
  return moved ? 'keep-watching' : 'reconnect';
}
