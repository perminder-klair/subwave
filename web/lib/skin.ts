// Listener-side skin persistence — the skin twin of lib/theme.ts's override
// storage. The operator picks a station-wide skin in admin → Settings (rides
// GET /state as ui.skin); a listener can override it per-browser, and the
// last-seen station skin is cached so a returning visitor boots into the
// right skin before the first poll instead of flashing the default.

const OVERRIDE_KEY = 'subwave-skin-override';
const STATION_CACHE_KEY = 'subwave-skin-station';

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
