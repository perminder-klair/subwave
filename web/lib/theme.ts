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
// A listener's explicit light/dark choice, independent of which palette is
// active. When set it steers which palette is picked — see resolveAppearance.
const MODE_KEY = 'subwave-mode-override';

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
  syncDarkClass(theme.mode);
}

/** Keep the shadcn-convention `.dark` class in sync with the resolved mode.
 *  SUB/WAVE's Tailwind `dark:` variant keys off `[data-theme='dark']` (see
 *  globals.css `@custom-variant dark`), so this class is not what drives the
 *  palette — it's mirrored so the app also reads as dark to tooling and shadcn
 *  primitives that expect the `.dark` class. */
function syncDarkClass(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', mode === 'dark');
}

/** Drop every palette token from the document root so the built-in light/dark
 *  base in globals.css (`:root` / `:root[data-theme="dark"]`) paints instead.
 *
 *  This is the load-bearing half of the mode override. `applyTheme` writes the
 *  palette as *inline* styles on <html>, and an inline `--bg` beats the
 *  `:root[data-theme="dark"]` rule — so flipping the attribute alone leaves the
 *  surfaces at the palette's own mode while `dark:` utilities and the
 *  `[data-theme="dark"]` grain/frame rules flip underneath them. Half-dark.
 *  Clearing the tokens first is what makes the flip whole. */
function clearThemeTokens(): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  for (const key of THEME_TOKEN_KEYS) html.style.removeProperty(key);
}

/** Force the document into an explicit light/dark mode: sets `data-theme`
 *  (which drives the built-in token blocks, the Tailwind `dark:` variant, and
 *  the grain/frame rules) and mirrors the `.dark` class. Only meaningful once
 *  the palette's inline tokens are out of the way — see `clearThemeTokens`. */
function applyMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', mode);
  syncDarkClass(mode);
}

/** Hand the document back to `prefers-color-scheme`: drop the explicit
 *  `data-theme` so the media-query block in globals.css applies. */
function clearMode(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.removeAttribute('data-theme');
  syncDarkClass(systemMode());
}

/** What `prefers-color-scheme` currently reports. */
export function systemMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** What the document should end up rendering, given the registry and the
 *  listener's two independent overrides. */
export interface ResolvedAppearance {
  /** The palette to paint, or null to fall back to the built-in base — which
   *  happens when a mode is pinned and no registry palette renders in it. */
  theme: Theme | null;
  /** The mode to pin, or null to follow `prefers-color-scheme`. */
  mode: ThemeMode | null;
}

/** Resolve palette + mode together. Pure — `applyAppearance` does the DOM work.
 *
 *  Palette precedence is unchanged: the listener's override beats the station's
 *  active palette beats the first registry entry. A pinned light/dark mode then
 *  decides whether that palette survives — it does if it was authored for that
 *  mode, and is otherwise *paused* in favour of the built-in base, which ships
 *  a complete and coherent light/dark pair.
 *
 *  Pausing rather than recolouring is deliberate: a palette is a hand-picked
 *  set of surfaces, ink, and accents that only holds together in the mode it
 *  was written for. Repainting one into the other mode produces mud, and
 *  silently swapping in a *different* palette would leave the picker
 *  highlighting a row that isn't on screen. A listener who wants a dark palette
 *  picks one — the picker is in the same menu as this toggle. */
export function resolveAppearance(
  registry: Theme[],
  stationId: string | null,
  override: string | null,
  modeOverride: ThemeMode | null,
): ResolvedAppearance {
  const byId = (id: string | null) => (id ? registry.find(t => t.id === id) : undefined);
  const base = byId(override) ?? byId(stationId) ?? registry[0] ?? null;

  if (!modeOverride) return { theme: base, mode: base ? base.mode : null };
  if (base && base.mode === modeOverride) return { theme: base, mode: modeOverride };
  return { theme: null, mode: modeOverride };
}

/** Paint a resolved appearance onto the document root. */
export function applyAppearance(resolved: ResolvedAppearance): void {
  if (typeof document === 'undefined') return;
  if (resolved.theme) {
    applyTheme(resolved.theme);
    return;
  }
  clearThemeTokens();
  if (resolved.mode) applyMode(resolved.mode);
  else clearMode();
}

/** Read the listener's explicit light/dark override, or null when unset. */
export function loadModeOverride(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

/** Save (or, with null, clear) the listener's explicit light/dark override. */
export function saveModeOverride(mode: ThemeMode | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (mode) window.localStorage.setItem(MODE_KEY, mode);
    else window.localStorage.removeItem(MODE_KEY);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

/** Cache the theme so the next page load can apply it pre-paint via
 *  THEME_INIT_SCRIPT. Stored as JSON keyed by `subwave-theme-tokens`. */
export function cacheTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(theme));
  } catch { /* private mode / quota — non-fatal */ }
}

/** Cache whatever was actually painted, so the pre-paint script reproduces it
 *  exactly. A resolution that lands on the built-in base drops the cache
 *  entirely rather than leaving a stale palette for the script to apply. */
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
    var html = document.documentElement;
    var mode = localStorage.getItem('${MODE_KEY}');
    if (mode !== 'light' && mode !== 'dark') mode = null;
    var raw = localStorage.getItem('${TOKEN_CACHE_KEY}');
    var t = raw ? JSON.parse(raw) : null;
    // Mirror resolveAppearance's rule: a pinned mode only keeps the cached
    // palette if that palette was authored for it. Otherwise skip the tokens
    // entirely and let the built-in base paint — applying them and then
    // flipping data-theme would leave inline light surfaces under dark rules.
    var usePalette = t && t.tokens && (!mode || t.mode === mode);
    if (usePalette) {
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
    }
    var resolved = mode || (usePalette && (t.mode === 'light' || t.mode === 'dark') ? t.mode : null);
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
