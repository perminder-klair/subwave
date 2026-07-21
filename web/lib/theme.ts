// Station-wide theme application.
//
// The operator picks one theme in admin → Settings → Theme; every listener
// renders with that theme's token map. The controller serves the registry at
// /themes (token maps) and the active id rides along on every /state poll.
//
// On boot we apply a cached token blob from localStorage *before paint* via
// THEME_INIT_SCRIPT so there's no flash. Once /themes responds, the fresh
// token map is applied + cached for the next visit.

import { THEME_TOKEN_KEYS, type DisplayFontId, type MonoFontId } from './theme-tokens.generated';

const TOKEN_KEY_SET = new Set<string>(THEME_TOKEN_KEYS);
const TOKEN_CACHE_KEY = 'subwave-theme-tokens';
const OVERRIDE_KEY = 'subwave-theme-override';

// A theme stores --display-font / --mono-font as a curated id; resolve it to a
// real family stack here (the stacks reference next/font variables set in
// app/layout.tsx). Keyed by DisplayFontId | MonoFontId so TypeScript fails the
// build if either curated set grows without a matching stack.
const FONT_STACKS: Record<DisplayFontId | MonoFontId, string> = {
  // display faces (--display-font)
  'fraunces': 'var(--font-fraunces), Georgia, serif',
  'doto': 'var(--font-doto), var(--font-jetbrains), monospace',
  'space-grotesk': 'var(--font-space-grotesk), var(--font-sans), sans-serif',
  'instrument-serif': 'var(--font-instrument-serif), Georgia, serif',
  'anton': 'var(--font-anton), var(--font-space-grotesk), sans-serif',
  'chakra-petch': 'var(--font-chakra-petch), var(--font-sans), sans-serif',
  'saira-stencil-one': 'var(--font-saira-stencil-one), var(--font-space-grotesk), sans-serif',
  // mono faces (--mono-font)
  'jetbrains': 'var(--font-jetbrains), ui-monospace, monospace',
  'ibm-plex-mono': 'var(--font-ibm-plex-mono), ui-monospace, monospace',
  'space-mono': 'var(--font-space-mono), ui-monospace, monospace',
  'fira-code': 'var(--font-fira-code), ui-monospace, monospace',
  'courier-prime': 'var(--font-courier-prime), "Courier New", monospace',
  'overpass-mono': 'var(--font-overpass-mono), ui-monospace, monospace',
};

// Token keys whose value is a curated font id (resolved to a family stack).
const FONT_TOKEN_KEYS = new Set(['--display-font', '--mono-font']);

/** Resolve a font-token value (--display-font / --mono-font): a curated id →
 *  its family stack, or the value unchanged (already a stack, or unset). Used
 *  by the theme builder's live preview to render sample text in the picked face. */
export function resolveFont(id: string): string {
  return FONT_STACKS[id as DisplayFontId | MonoFontId] ?? id;
}

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
  // Clear the whole allowlist first: a token the incoming theme omits must fall
  // back to its :root default (paper grain, Fraunces/JetBrains), not linger
  // from the previously applied theme.
  for (const key of THEME_TOKEN_KEYS) html.style.removeProperty(key);
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (!TOKEN_KEY_SET.has(k)) continue;
    const value = FONT_TOKEN_KEYS.has(k) ? resolveFont(v) : v;
    html.style.setProperty(k, value);
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
// The key list + font stacks are inlined from the generated registry mirror, so
// adding a token there (and a :root fallback in globals.css) flows here with a
// regenerate — no hand-editing this script.
export const THEME_INIT_SCRIPT = `
  try {
    var raw = localStorage.getItem('${TOKEN_CACHE_KEY}');
    if (raw) {
      var t = JSON.parse(raw);
      if (t && t.tokens) {
        var html = document.documentElement;
        var keys = ${JSON.stringify([...THEME_TOKEN_KEYS])};
        var fonts = ${JSON.stringify(FONT_STACKS)};
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var v = t.tokens[k];
          if (typeof v === 'string') {
            if ((k === '--display-font' || k === '--mono-font') && fonts[v]) v = fonts[v];
            html.style.setProperty(k, v);
          }
        }
        if (t.mode === 'light' || t.mode === 'dark') html.setAttribute('data-theme', t.mode);
      }
    }
  } catch (e) {}
`;
