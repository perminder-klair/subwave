// Station-wide theme application. The controller serves the registry at
// /themes and the active id rides /state. On boot the cached token blob is
// applied pre-paint via THEME_INIT_SCRIPT so there's no flash.

import { THEME_TOKENS, THEME_TOKEN_KEYS, type DisplayFontId, type MonoFontId } from './theme-tokens.generated';

const TOKEN_KEY_SET = new Set<string>(THEME_TOKEN_KEYS);
const TOKEN_CACHE_KEY = 'subwave-theme-tokens';
const OVERRIDE_KEY = 'subwave-theme-override';

// What the document is painted with, keyed by paintKey, so the 30 s registry
// poll can skip a theme that hasn't changed. Rewriting identical tokens on
// <html> still invalidates style for the whole document: WebKit then repaints
// every layer (through a stage-wide --finish filter, where one is on) and
// every canvas watching the theme re-rasterises, a hitch every 30 s on iPad.
// applyTheme stamps it too, so the admin builder's direct writes stay counted.
let painted: string | null = null;

function paintKey(theme: Theme | null): string {
  return theme ? JSON.stringify([theme.mode, theme.tokens]) : `base:${systemMode()}`;
}

// A theme stores --display-font / --mono-font as a curated id; these stacks
// reference the next/font variables set in app/layout.tsx. Keyed by
// DisplayFontId | MonoFontId so a new curated id fails the build without a stack.
const FONT_STACKS: Record<DisplayFontId | MonoFontId, string> = {
  // display faces (--display-font)
  'fraunces': 'var(--font-fraunces), Georgia, serif',
  'doto': 'var(--font-doto), var(--font-jetbrains), monospace',
  'space-grotesk': 'var(--font-space-grotesk), var(--font-sans), sans-serif',
  'instrument-serif': 'var(--font-instrument-serif), Georgia, serif',
  'anton': 'var(--font-anton), var(--font-space-grotesk), sans-serif',
  'chakra-petch': 'var(--font-chakra-petch), var(--font-sans), sans-serif',
  'saira-stencil-one': 'var(--font-saira-stencil-one), var(--font-space-grotesk), sans-serif',
  'vt323': 'var(--font-vt323), var(--font-jetbrains), monospace',
  'bricolage-grotesque': 'var(--font-bricolage-grotesque), var(--font-sans), sans-serif',
  // mono faces (--mono-font)
  'jetbrains': 'var(--font-jetbrains), ui-monospace, monospace',
  'ibm-plex-mono': 'var(--font-ibm-plex-mono), ui-monospace, monospace',
  'space-mono': 'var(--font-space-mono), ui-monospace, monospace',
  'fira-code': 'var(--font-fira-code), ui-monospace, monospace',
  'courier-prime': 'var(--font-courier-prime), "Courier New", monospace',
  'overpass-mono': 'var(--font-overpass-mono), ui-monospace, monospace',
  'dm-mono': 'var(--font-dm-mono), ui-monospace, monospace',
};

const FONT_TOKEN_KEYS = new Set(['--display-font', '--mono-font']);

// Keyword tokens (--texture, --finish) also go onto <html> as data attributes
// (data-texture, data-finish): CSS cannot branch on a custom property's value,
// so globals.css keys the overlay and the filter off the attribute instead.
const KEYWORD_ATTRS: Record<string, string> = Object.fromEntries(
  THEME_TOKENS.filter(t => t.type === 'keyword').map(t => [t.key, `data-${t.key.slice(2)}`]),
);

function applyKeywordAttrs(html: HTMLElement, tokens: Record<string, string>): void {
  for (const [key, attr] of Object.entries(KEYWORD_ATTRS)) {
    const v = tokens[key];
    if (typeof v === 'string' && v) html.setAttribute(attr, v);
    else html.removeAttribute(attr);
  }
}

/** Curated font id → family stack; anything else passes through unchanged. */
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

/** Write a theme's tokens onto the document root and set `data-theme=mode`, which
 *  CSS keyed off the attribute (the `dark:` variant, the paper-grain blend mode)
 *  needs. Keys outside THEME_TOKEN_KEYS are ignored. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  // Clear the whole allowlist first: a token the incoming theme omits must fall
  // back to its :root default, not linger from the previous theme.
  for (const key of THEME_TOKEN_KEYS) html.style.removeProperty(key);
  for (const [k, v] of Object.entries(theme.tokens)) {
    if (!TOKEN_KEY_SET.has(k)) continue;
    const value = FONT_TOKEN_KEYS.has(k) ? resolveFont(v) : v;
    html.style.setProperty(k, value);
  }
  applyKeywordAttrs(html, theme.tokens);
  html.setAttribute('data-theme', theme.mode);
  syncDarkClass(theme.mode);
  painted = paintKey(theme);
}

/** Mirror the resolved mode onto the shadcn-convention `.dark` class. The `dark:`
 *  variant keys off `[data-theme='dark']` (globals.css `@custom-variant dark`),
 *  so this class drives nothing — it's for primitives that expect `.dark`. */
function syncDarkClass(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', mode === 'dark');
}

/** Drop every palette token so the built-in base in globals.css paints instead.
 *  Required because a palette's tokens are *inline* styles on <html> and would
 *  otherwise beat the base rules. Only reachable when the registry is empty. */
function clearThemeTokens(): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) html.style.removeProperty(key);
  applyKeywordAttrs(html, {});
}

function systemMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export interface ResolvedAppearance {
  /** The palette to paint, or null for the built-in base (empty registry only). */
  theme: Theme | null;
}

/** Resolve which palette paints. Pure — `applyAppearance` does the DOM work.
 *  Precedence: listener override → station active → first registry entry.
 *
 *  Light vs dark is not a separate axis: each theme declares the mode it was
 *  authored for, and repainting a palette into the other mode produces mud. A
 *  listener who wants dark picks a dark theme. */
export function resolveAppearance(
  registry: Theme[],
  stationId: string | null,
  override: string | null,
): ResolvedAppearance {
  const byId = (id: string | null) => (id ? registry.find(t => t.id === id) : undefined);
  return { theme: byId(override) ?? byId(stationId) ?? registry[0] ?? null };
}

/** Paint the resolved appearance. Returns false, writing nothing, when the
 *  document already shows it, so a caller can skip its cache write too. */
export function applyAppearance(resolved: ResolvedAppearance): boolean {
  if (typeof document === 'undefined') return false;
  const key = paintKey(resolved.theme);
  if (key === painted) return false;
  if (resolved.theme) {
    applyTheme(resolved.theme);
    return true;
  }
  // No palette — hand the document back to `prefers-color-scheme`.
  clearThemeTokens();
  document.documentElement.removeAttribute('data-theme');
  syncDarkClass(systemMode());
  painted = key;
  return true;
}

/** Cache the theme so the next load applies it pre-paint via THEME_INIT_SCRIPT. */
export function cacheTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(theme));
  } catch { /* private mode / quota — non-fatal */ }
}

/** Cache whatever was actually painted. Landing on the built-in base drops the
 *  cache rather than leaving a stale palette for the pre-paint script. */
export function cacheAppearance(resolved: ResolvedAppearance): void {
  if (typeof window === 'undefined') return;
  if (resolved.theme) {
    cacheTheme(resolved.theme);
    return;
  }
  try {
    window.localStorage.removeItem(TOKEN_CACHE_KEY);
  } catch { /* private mode / quota — non-fatal */ }
}

/** The listener's per-browser theme override id; null when unset or unreadable. */
export function loadThemeOverride(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Save the listener's theme override; null drops it and re-follows the station.
 *  Storage failures are swallowed — the override is not load-bearing. */
export function saveThemeOverride(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(OVERRIDE_KEY, id);
    else window.localStorage.removeItem(OVERRIDE_KEY);
  } catch { /* private mode / quota — non-fatal */ }
}

// Pre-hydration <script> body — applies the cached tokens before paint. A static
// constant, inlined into layout.tsx via dangerouslySetInnerHTML; no untrusted
// input reaches it. The key list + font stacks come from the generated registry
// mirror, so a new token flows here on regenerate — never hand-edit this script.
export const THEME_INIT_SCRIPT = `
  try {
    var html = document.documentElement;
    var raw = localStorage.getItem('${TOKEN_CACHE_KEY}');
    var t = raw ? JSON.parse(raw) : null;
    var usePalette = !!(t && t.tokens);
    if (usePalette) {
      var keys = ${JSON.stringify([...THEME_TOKEN_KEYS])};
      var fonts = ${JSON.stringify(FONT_STACKS)};
      var attrs = ${JSON.stringify(KEYWORD_ATTRS)};
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = t.tokens[k];
        if (typeof v === 'string') {
          if ((k === '--display-font' || k === '--mono-font') && fonts[v]) v = fonts[v];
          html.style.setProperty(k, v);
          if (attrs[k] && v) html.setAttribute(attrs[k], v);
        }
      }
    }
    var resolved = usePalette && (t.mode === 'light' || t.mode === 'dark') ? t.mode : null;
    if (resolved) html.setAttribute('data-theme', resolved);
    else html.removeAttribute('data-theme');
    html.classList.toggle(
      'dark',
      resolved
        ? resolved === 'dark'
        : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches),
    );
  } catch (e) {}
`;
