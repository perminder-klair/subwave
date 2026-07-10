// Station-wide theme application.
//
// The operator picks one theme in admin → Settings → Theme; every listener
// renders with that theme's token map. The controller serves the registry at
// /themes (token maps) and the active id rides along on every /state poll.
//
// On boot we apply a cached token blob from localStorage *before paint* via
// THEME_INIT_SCRIPT so there's no flash. Once /themes responds, the fresh
// token map is applied + cached for the next visit.

export const THEME_TOKEN_KEYS = [
  '--bg',
  '--ink',
  '--muted',
  '--accent',
  '--overlay',
  '--soft-border',
  '--field',
] as const;
export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];

const TOKEN_KEY_SET = new Set<string>(THEME_TOKEN_KEYS);
const TOKEN_CACHE_KEY = 'subwave-theme-tokens';
const OVERRIDE_KEY = 'subwave-theme-override';

export type ThemeMode = 'light' | 'dark';

export interface Theme {
  id: string;
  name: string;
  description?: string;
  mode: ThemeMode;
  tokens: Record<string, string>;
}

/** Write a theme's tokens onto the document root and set `data-theme=mode`
 *  so any CSS rules keyed off the attribute (shadcn's `dark:` variant, the
 *  paper-grain blend mode) still resolve. Keys outside the allowlist are
 *  silently ignored — the controller already filters them, but we double-check
 *  on the client too. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (!TOKEN_KEY_SET.has(k)) continue;
    html.style.setProperty(k, v);
  }
  html.setAttribute('data-theme', theme.mode);
}

/** Cache the theme so the next page load can apply it pre-paint via
 *  THEME_INIT_SCRIPT. Stored as JSON keyed by `subwave-theme-tokens`. */
export function cacheTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(theme));
  } catch { /* private mode / quota — non-fatal */ }
}

/** Read the listener's per-browser theme override id. When set, the
 *  ThemeProvider applies this theme instead of the station's active one — so
 *  a listener can pick a palette they prefer without affecting anyone else.
 *  Returns null when no override is stored or storage is unreadable. */
export function loadThemeOverride(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Save or clear the listener's per-browser theme override. Pass null to
 *  drop the override and re-follow the station default. Failures (private
 *  mode, quota) are swallowed — the override is a nice-to-have, not load-
 *  bearing. */
export function saveThemeOverride(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(OVERRIDE_KEY, id);
    else window.localStorage.removeItem(OVERRIDE_KEY);
  } catch { /* private mode / quota — non-fatal */ }
}

// Pre-hydration <script> body — applies the cached theme's tokens onto <html>
// before paint so listeners never see a flash. The body is a static constant,
// inlined into layout.tsx via dangerouslySetInnerHTML; no untrusted input
// reaches it.
//
// Keep in sync with THEME_TOKEN_KEYS — the script walks the cached object's
// own keys, so adding a new themable token here just means adding it to the
// constant in this file (and globals.css).
export const THEME_INIT_SCRIPT = `
  try {
    var raw = localStorage.getItem('${TOKEN_CACHE_KEY}');
    if (raw) {
      var t = JSON.parse(raw);
      if (t && t.tokens) {
        var html = document.documentElement;
        var keys = ${JSON.stringify([...THEME_TOKEN_KEYS])};
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (typeof t.tokens[k] === 'string') html.style.setProperty(k, t.tokens[k]);
        }
        if (t.mode === 'light' || t.mode === 'dark') html.setAttribute('data-theme', t.mode);
      }
    }
  } catch (e) {}
`;
