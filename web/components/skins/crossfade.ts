// A colour change as an opacity crossfade between two stacked layers, for the
// big cover-tinted gradients (Classic's ambient, Drift's washes). Transitioning
// the colour itself re-rasterises the gradient on every frame, and WebKit
// never composites a registered custom property's transition, so on an iPad
// that is a CPU repaint of a viewport-sized gradient for the whole fade. Here
// each layer paints its gradient once and the compositor fades the opacity.
//
// A new value paints into the hidden layer, which then becomes the front. Until
// that fade ends the outgoing layer is still on screen, so a value that lands
// mid-fade waits for it rather than repainting a half-visible layer, and the
// latest value wins. Pure, so the hook in sharedHooks.ts stays thin.

export interface Crossfade<T> {
  /** What each layer holds. */
  layers: readonly [T, T];
  /** The layer showing, or fading in. */
  front: 0 | 1;
  /** A fade is running, so the hidden layer is still on screen. */
  fading: boolean;
}

/** Both layers hold the first value, the front one showing: mounting is not a
 *  change, so nothing fades. */
export function crossfadeStart<T>(value: T): Crossfade<T> {
  return { layers: [value, value], front: 0, fading: false };
}

/** The state that shows `value`; `state` itself when it already does, or when
 *  a fade is running and `value` has to wait for it. `instant` (no fade, as
 *  under lite mode) swaps at once and never waits. */
export function crossfadeTo<T>(state: Crossfade<T>, value: T, instant: boolean): Crossfade<T> {
  if (Object.is(state.layers[state.front], value)) return state;
  if (state.fading && !instant) return state;
  const back = state.front === 0 ? 1 : 0;
  const layers: readonly [T, T] = back === 0 ? [value, state.layers[1]] : [state.layers[0], value];
  return { layers, front: back, fading: !instant };
}

/** The fade has run its length: the hidden layer is off screen again. */
export function crossfadeSettled<T>(state: Crossfade<T>): Crossfade<T> {
  return state.fading ? { ...state, fading: false } : state;
}
