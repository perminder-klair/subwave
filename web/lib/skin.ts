// Listener-side skin persistence — the skin twin of lib/theme.ts's override
// storage. The operator picks a station-wide skin in admin → Settings (rides
// GET /state as ui.skin); a listener can override it per-browser, and the
// last-seen station skin is cached so a returning visitor boots into the
// right skin before the first poll instead of flashing the default.

const OVERRIDE_KEY = 'subwave-skin-override';
const STATION_CACHE_KEY = 'subwave-skin-station';

// Skin-id facts shared by the registry (components/skins/index.ts) and the
// pre-paint script below. They live HERE — plain data, no React — because the
// server layout inlines SKIN_INIT_SCRIPT and must not drag the registry's
// next/dynamic wrappers into a server component. The registry re-exports
// DEFAULT_SKIN_ID for component-side consumers.
export const DEFAULT_SKIN_ID = 'classic';

/** Renamed/retired skin ids — resolved to their successor so an operator's
 *  saved setting keeps working across upgrades. */
export const LEGACY_SKIN_ALIASES: Record<string, string> = {
  terminal: 'tty',
};

export function canonicalSkinId(id: string | null | undefined): string | null {
  if (!id) return null;
  // Own-key check, not a bare lookup: ids come from localStorage/settings,
  // and a value like "constructor" must not dredge up Object.prototype.
  return Object.prototype.hasOwnProperty.call(LEGACY_SKIN_ALIASES, id)
    ? (LEGACY_SKIN_ALIASES[id] ?? id)
    : id;
}

/** The listener's per-browser skin override id, or null when none is set
 *  or storage is unreadable. */
export function loadSkinOverride(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Save or clear the listener's skin override. Pass null to re-follow the
 *  station default. Failures (private mode, quota) are swallowed. */
export function saveSkinOverride(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(OVERRIDE_KEY, id);
    else window.localStorage.removeItem(OVERRIDE_KEY);
  } catch { /* non-fatal */ }
}

/** Last station skin id seen on /state — the flash-free boot hint. */
export function loadCachedStationSkin(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STATION_CACHE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function cacheStationSkin(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STATION_CACHE_KEY, id);
  } catch { /* non-fatal */ }
}

// Pre-hydration <script> body — the skin twin of THEME_INIT_SCRIPT. SSR can't
// know the browser's skin override, so the server always paints the default
// face and the shell swaps one tick after hydration. When this browser is
// known to resolve to a NON-default skin, stamp `data-skin-pending` on <html>
// and inject a rule hiding the full-page shell, so that first paint is a
// quiet blank instead of a flash of the wrong skin. PlayerShell removes the
// attribute once the resolved skin is mounted. Static constant, inlined via
// dangerouslySetInnerHTML in layout.tsx; no untrusted input reaches it.
export const SKIN_INIT_SCRIPT = `
  try {
    var o = localStorage.getItem('${OVERRIDE_KEY}');
    var s = localStorage.getItem('${STATION_CACHE_KEY}');
    var skin = o || s || '${DEFAULT_SKIN_ID}';
    var aliases = ${JSON.stringify(LEGACY_SKIN_ALIASES)};
    if (Object.prototype.hasOwnProperty.call(aliases, skin)) skin = aliases[skin];
    if (skin !== '${DEFAULT_SKIN_ID}') {
      document.documentElement.setAttribute('data-skin-pending', skin);
      var st = document.createElement('style');
      st.textContent = 'html[data-skin-pending] .sw-player-shell{visibility:hidden}';
      document.head.appendChild(st);
    }
  } catch (e) {}
`;
