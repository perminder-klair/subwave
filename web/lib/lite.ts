// Lite (low-power) mode.
//
// The frosted-glass `backdrop-filter` blur and the always-on looping animations
// (spinning disc, live-cover glitch/scan, pulses) are cheap on a laptop GPU but
// brutal on weak ones: a Raspberry Pi 4 re-compositing blurred layers at ~50fps
// pegs Chromium at ~170% CPU. Lite mode adds a `lite` class to <html> that drops
// every backdrop-filter and disables animations (see globals.css) — the heavy
// paint goes away while audio + controls stay intact.
//
// Triggered three ways, in precedence order:
//   1. `?lite=1` / `?lite=0` in the URL — lets a kiosk pin the mode from its
//      start URL. The value is written through to localStorage so a later visit
//      without the param sticks.
//   2. The toggle in the player theme menu — writes the same localStorage key.
//   3. Nothing set → off (full-fat experience).
//
// Applied pre-paint via LITE_INIT_SCRIPT (inlined in layout.tsx) so a pinned
// kiosk never flashes the heavy build before hydration.

const STORAGE_KEY = 'subwave-lite';
const LITE_CLASS = 'lite';

/** Toggle the `lite` class on <html>. No-op on the server. */
export function applyLite(on: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(LITE_CLASS, on);
}

/** Read the stored lite preference. Returns null when nothing is stored, so
 *  callers can tell "never chosen" apart from "explicitly off". */
export function loadLitePref(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

/** Persist the lite preference. Failures (private mode, quota) are swallowed —
 *  the DOM class still applies for the session. */
export function saveLitePref(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch { /* private mode / quota — non-fatal */ }
}

// Pre-hydration <script> body — resolves lite mode from the URL (?lite=…) then
// localStorage and toggles the `lite` class on <html> before paint, so a pinned
// kiosk never flashes the heavy build. A URL param also writes through to
// localStorage so the choice survives the next param-less load. Static string,
// inlined via dangerouslySetInnerHTML; no untrusted input reaches it.
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
