// Lite (low-power) mode: adds a `lite` class to <html> that drops every
// backdrop-filter and disables animations (globals.css), for weak GPUs.
//
// Precedence: `?lite=1`/`?lite=0` in the URL (written through to localStorage so
// a later param-less visit sticks, which is how a kiosk pins it), then the
// Appearance menu's toggle, then off. Applied pre-paint via LITE_INIT_SCRIPT so
// a kiosk never flashes the heavy build.

const STORAGE_KEY = 'subwave-lite';
const LITE_CLASS = 'lite';

// Every mounted useLiteMode reader. CSS follows the class on its own, but a
// skin's rAF loop or timeout chain only stops when its hook re-renders, so a
// toggle has to reach all of them, not just the menu that flipped it.
const listeners = new Set<() => void>();

/** Whether lite mode is on: the `<html>` class, which LITE_INIT_SCRIPT set
 *  before paint from `?lite=` or storage. The class, not storage, is the truth,
 *  since `?lite=1` still applies where storage is blocked. False on the server. */
export function isLite(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains(LITE_CLASS);
}

/** Calls `onChange` after every setLite; returns the unsubscribe. */
export function subscribeLite(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The menu toggle: saves the choice for this browser, flips the class and
 *  tells every reader. Storage failures are swallowed; the class still applies
 *  for the session. No-op on the server. */
export function setLite(on: boolean): void {
  if (typeof document === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch { /* private mode / quota — non-fatal */ }
  document.documentElement.classList.toggle(LITE_CLASS, on);
  for (const onChange of listeners) onChange();
}

// Pre-hydration <script> body: resolves lite mode from ?lite= then localStorage
// and toggles the class before paint. Static string, inlined via
// dangerouslySetInnerHTML; no untrusted input reaches it.
export const LITE_INIT_SCRIPT = `
  try {
    var KEY = '${STORAGE_KEY}';
    var on = null;
    var p = new URLSearchParams(location.search).get('lite');
    if (p !== null) {
      on = (p === '' || p === '1' || p === 'true' || p === 'yes');
      try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
    } else {
      var raw = localStorage.getItem(KEY);
      if (raw === '1') on = true; else if (raw === '0') on = false;
    }
    if (on) document.documentElement.classList.add('${LITE_CLASS}');
  } catch (e) {}
`;
