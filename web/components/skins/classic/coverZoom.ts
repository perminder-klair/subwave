// The classic skin's cover zoom: the two decisions it makes, kept pure so they
// are pinned without a DOM (cover-zoom.test.ts).
//
// A press on the stage's cover enlarges it while there is a cover to show and
// opens the timeline as before when there is none (no art yet, off air), so
// the button never does nothing.
//
// The zoom grows out of the thumbnail and shrinks back into it: the large
// cover is laid out at its final place and animated from a transform that
// puts it exactly over the thumbnail. `zoomFrom` is that transform.

export type CoverPress = 'zoom' | 'timeline';

export function coverPressAction(hasArt: boolean): CoverPress {
  return hasArt ? 'zoom' : 'timeline';
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The transform that lays `to` over `from` (centre on centre, scaled to its
 *  width), or null when either box is unusable, which means: just fade. */
export function zoomFrom(from: Box | null | undefined, to: Box | null | undefined): { x: number; y: number; scale: number } | null {
  if (!from || !to) return null;
  if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) return null;
  const x = from.left + from.width / 2 - (to.left + to.width / 2);
  const y = from.top + from.height / 2 - (to.top + to.height / 2);
  const scale = from.width / to.width;
  if (![x, y, scale].every(Number.isFinite)) return null;
  return { x, y, scale };
}

/** `transform` for `zoomFrom`'s answer. */
export function zoomTransform(t: { x: number; y: number; scale: number }): string {
  return `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
}
