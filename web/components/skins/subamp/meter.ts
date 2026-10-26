// The Subamp analyser's bar physics, pure so its timing can be pinned without
// a canvas. A step eases every bar toward its target and lets its peak cap
// fall, scaled by the real time since the last paint: the loop paints at
// ~30 fps (Analyzer.tsx), and the meter has to move at the speed it was tuned
// for at 60, whatever the display's refresh.

export const BARS = 12;

/** Cap fall per 60 fps frame, in 0..1 bar heights. */
const CAP_FALL = 0.006;
/** Share of the gap to its target a bar closes per 60 fps frame. */
const SMOOTH = 0.35;
export const FRAME_60_MS = 1000 / 60;

/** Advance `vals` (bar heights) and `caps` (their peaks) by `dtMs` toward
 *  `targets`, in place. A cap never sits below its bar. */
export function stepMeter(
  vals: Float32Array,
  caps: Float32Array,
  targets: ArrayLike<number>,
  dtMs: number,
): void {
  const frames = Math.max(0, dtMs) / FRAME_60_MS;
  const ease = 1 - Math.pow(1 - SMOOTH, frames);
  const fall = CAP_FALL * frames;
  for (let i = 0; i < vals.length; i++) {
    const cur = vals[i] ?? 0;
    const next = cur + ((targets[i] ?? 0) - cur) * ease;
    vals[i] = next;
    caps[i] = Math.max((caps[i] ?? 0) - fall, next);
  }
}
