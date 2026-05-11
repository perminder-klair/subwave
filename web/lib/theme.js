// Theme mode persistence + apply.
// Three modes: 'system' (default, follows prefers-color-scheme), 'light', 'dark'.
// 'system' is stored as the literal absence of [data-theme] on <html> so CSS
// can fall through to the @media (prefers-color-scheme: dark) block.

export const THEME_KEY = 'subwave-theme';
export const THEME_MODES = ['system', 'light', 'dark'];

export function getStoredTheme() {
  if (typeof window === 'undefined') return 'system';
  const v = window.localStorage.getItem(THEME_KEY);
  return THEME_MODES.includes(v) ? v : 'system';
}

export function applyTheme(mode) {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  if (mode === 'light' || mode === 'dark') {
    html.setAttribute('data-theme', mode);
  } else {
    html.removeAttribute('data-theme');
  }
}

export function setTheme(mode) {
  if (!THEME_MODES.includes(mode)) mode = 'system';
  if (typeof window !== 'undefined') {
    if (mode === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, mode);
  }
  applyTheme(mode);
}

// Inline string for the pre-hydration <script> in layout.js — applies the
// stored theme before paint so there's no flash of the wrong palette.
export const THEME_INIT_SCRIPT = `
  try {
    var m = localStorage.getItem('${THEME_KEY}');
    if (m === 'light' || m === 'dark') document.documentElement.setAttribute('data-theme', m);
  } catch (e) {}
`;
