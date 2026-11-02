// The AXO loop's bookkeeping, kept free of React so its promises can be
// pinned by tests. WebKit never composites an SVG child: any attribute or
// style write repaints the node's box on the CPU, a write of the value
// already there included, and a frame's many small boxes merge into one
// large one. So the loop writes only what changed, and where every iPhone
// and iPad browser is WebKit it paints every other frame.

/** The DOM calls the loop makes on a node. */
export interface LoopNode {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): string;
  };
}

export interface Writer {
  /** Set an attribute, or remove it with null, unless that is what this
   *  writer last wrote there. */
  attr(el: LoopNode, name: string, value: string | null): void;
  /** The same for an inline style property. */
  style(el: LoopNode, prop: string, value: string | null): void;
}

/** A write-on-change memory for one run of the loop. It remembers only its
 *  own writes, so it suits what React leaves alone while the loop runs; a
 *  fresh run starts empty and writes everything once. */
export function createWriter(): Writer {
  const memory = new WeakMap<LoopNode, Map<string, string | null>>();
  const changed = (el: LoopNode, key: string, value: string | null) => {
    let seen = memory.get(el);
    if (!seen) memory.set(el, (seen = new Map()));
    if (seen.has(key) && seen.get(key) === value) return false;
    seen.set(key, value);
    return true;
  };
  return {
    attr(el, name, value) {
      if (!changed(el, name, value)) return;
      if (value == null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    },
    style(el, prop, value) {
      if (!changed(el, `style:${prop}`, value)) return;
      if (value == null) el.style.removeProperty(prop);
      else el.style.setProperty(prop, value);
    },
  };
}

/** The loop's frame spacing where WebKit paints SVG on a touch device's CPU:
 *  about 30 a second, set a little under 33 ms so every other frame of a
 *  60 Hz display clears it through rAF's jitter. */
export const TOUCH_FRAME_MS = 30;

/** Lets a frame through once `minMs` has passed since the last one it let
 *  through; 0 lets every frame through. */
export function frameGate(minMs: number): (now: number) => boolean {
  let last = -Infinity;
  return now => {
    if (now - last < minMs) return false;
    last = now;
    return true;
  };
}
