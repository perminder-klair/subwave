// Lite (low-power) mode: adds a `lite` class to <html> that drops every
// backdrop-filter and disables animations (globals.css), for weak GPUs.
//
// Precedence: `?lite=1`/`?lite=0` in the URL (written through to localStorage so
// a later param-less visit sticks), then the theme-menu toggle, then off.
// Applied pre-paint via LITE_INIT_SCRIPT so a kiosk never flashes the heavy build.

const STORAGE_KEY = 'subwave-lite';
const LITE_CLASS = 'lite';

/** No-op on the server. */
export function applyLite(on: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(LITE_CLASS, on);
}

/** Null when nothing is stored, so callers can tell "never chosen" from
 *  "explicitly off". */
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

/** Storage failures are swallowed; the DOM class still applies for the session. */
export function saveLitePref(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch { /* private mode / quota — non-fatal */ }
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
