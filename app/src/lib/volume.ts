// Persisted listener volume — native port of web/web/lib/volume.ts (#828).
//
// The player's volume lives as React state in usePlayer, defaulting to full.
// Listeners expect their last-used level to survive an app relaunch, so it's
// mirrored into AsyncStorage on change and restored at mount. Stored as a
// clamped 0..1 float string; muting (volume 0) is persisted verbatim so "last
// used volume" stays faithful. AsyncStorage is async (unlike the web's
// localStorage), so the knob renders at the default on first frame and snaps
// to the stored value once the read resolves — same visual contract as the
// web's effect-only restore.

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'subwave.volume.v1';

/** Read the stored volume (0..1), or null when nothing valid is stored so the
 *  caller can keep its own default. */
export async function loadVolumePref(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw == null) return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v));
  } catch {
    return null;
  }
}

/** Persist the volume (clamped 0..1). Failures are swallowed — playback is
 *  unaffected. */
export async function saveVolumePref(volume: number): Promise<void> {
  try {
    const v = Math.min(1, Math.max(0, volume));
    await AsyncStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
