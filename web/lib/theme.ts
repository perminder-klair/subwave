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

/** Best-effort read of the cached theme. Returns null if nothing is cached
 *  or the cache is unreadable. Used by callers that want to compare against
 *  a fresh active id before refetching the registry. */
export function loadCachedTheme(): Theme | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(TOKEN_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Theme>;
    if (
      typeof parsed?.id !== 'string'
      || typeof parsed?.mode !== 'string'
      || !parsed.tokens
    ) {
      return null;
    }
    return parsed as Theme;
  } catch {
    return null;
  }
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
