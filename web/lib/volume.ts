// Persisted listener volume (issue #783).
//
// The player's volume lives as React state in usePlayer, defaulting to full.
// Listeners expect their last-used level to survive a reload, so we mirror it
// into localStorage on change and restore it at mount. Stored as a clamped
// 0..1 float string; muting (volume 0) is persisted verbatim so "last used
// volume" stays faithful.
//
// Reads/writes are effect-only (never during render) so there's no hydration
// mismatch — the knob renders at the default on first paint, then snaps to the
// stored value a tick later, same as the lite-mode toggle.

const STORAGE_KEY = 'subwave-volume';

/** Read the stored volume (0..1), or null when nothing valid is stored so the
 *  caller can keep its own default. No-op / null on the server. */
export function loadVolumePref(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v));
  } catch {
    return null;
  }
}

/** Persist the volume (clamped 0..1). Failures (private mode, quota) are
 *  swallowed — playback is unaffected. */
export function saveVolumePref(volume: number): void {
  if (typeof window === 'undefined') return;
  try {
    const v = Math.min(1, Math.max(0, volume));
    window.localStorage.setItem(STORAGE_KEY, String(v));
  } catch { /* private mode / quota — non-fatal */ }
}
