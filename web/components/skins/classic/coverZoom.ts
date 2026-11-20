// The classic skin's cover zoom: the decisions it makes, kept pure so they
// are pinned without a DOM (cover-zoom.test.tsx).
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

/** Whether the enlarged cover goes. It goes when there is nothing left to show
 *  (no art, off air) or another layer opens over it: a drawer, or the command
 *  palette. The palette is the one layer that can open over it (⌘K works
 *  while the skin's bare-key shortcuts are off), and leaving the cover under
 *  it would let one Escape close both. */
export function coverZoomDismissed(s: {
  hasCover: boolean;
  offline: boolean;
  drawerOpen: boolean;
  paletteOpen: boolean;
}): boolean {
  return !s.hasCover || s.offline || s.drawerOpen || s.paletteOpen;
}

/** Whether the skin's bare-key shortcuts are off. They are while a dialog owns
 *  the keys: the palette, the shortcuts help, or the enlarged cover, so a key
 *  (Space on its close button included) never acts on the player behind it.
 *  The cover closes on Escape through its own listener. */
export function skinShortcutsDisabled(s: {
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  coverOpen: boolean;
}): boolean {
  return s.paletteOpen || s.shortcutsOpen || s.coverOpen;
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
