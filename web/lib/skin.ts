// Listener-side skin persistence, the skin twin of lib/theme.ts's override
// storage. The station-wide pick rides GET /state as ui.skin; a listener can
// override it per-browser, and the last-seen station skin is cached so a
// returning visitor boots into the right skin before the first poll.

const OVERRIDE_KEY = 'subwave-skin-override';
const STATION_CACHE_KEY = 'subwave-skin-station';

// Skin-id facts shared by the registry (components/skins/index.ts) and the
// pre-paint script below. They live HERE, as plain data with no React, because
// the server layout inlines SKIN_INIT_SCRIPT and must not drag the registry's
// next/dynamic wrappers into a server component.
export const DEFAULT_SKIN_ID = 'classic';

/** Retired ids resolve to their successor so a saved setting survives an
 *  upgrade. */
export const LEGACY_SKIN_ALIASES: Record<string, string> = {
  terminal: 'tty',
  spool: 'unit',
};

export function canonicalSkinId(id: string | null | undefined): string | null {
  if (!id) return null;
  // Own-key check, not a bare lookup: ids come from localStorage/settings,
  // and a value like "constructor" must not dredge up Object.prototype.
  return Object.prototype.hasOwnProperty.call(LEGACY_SKIN_ALIASES, id)
    ? (LEGACY_SKIN_ALIASES[id] ?? id)
    : id;
}

/** Null when unset or storage is unreadable. */
export function loadSkinOverride(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Pass null to re-follow the station default. Storage failures are swallowed. */
export function saveSkinOverride(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) window.localStorage.setItem(OVERRIDE_KEY, id);
    else window.localStorage.removeItem(OVERRIDE_KEY);
  } catch { /* non-fatal */ }
}

/** Last station skin seen on /state; the flash-free boot hint. */
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

// Hide non-default skins before hydration with data-skin-pending. PlayerShell removes it after the
// resolved skin mounts. The script contains no untrusted input.
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
