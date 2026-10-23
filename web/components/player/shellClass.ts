// Class for the player shell's root. A contained showcase stands in for ANOTHER
// station, but theme tokens live on <html> and belong to this one, so any skin
// painting var(--bg-image) would show this station's background inside that
// frame. Resetting the token on the contained root reaches every skin below it
// (Platter's .stage, Subamp's .shell, and any later one) from one place, with
// no per-skin branch on `contained`. Full-page shells get nothing, so the
// theme's own value applies. A Tailwind arbitrary property, not an inline
// style (lint forbids those). Leaf module so a controller test can load it.
export const CONTAINED_SHELL_CLASS = '[--bg-image:none]';

export function shellClass(contained: boolean): string {
  return contained ? CONTAINED_SHELL_CLASS : '';
}
