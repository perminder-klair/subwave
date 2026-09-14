// Persisted listener volume (#828). Stored as a clamped 0..1 float string;
// mute (0) is persisted verbatim. AsyncStorage is async, so the knob renders
// at the default on the first frame and snaps once the read resolves.

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

/** Persist the volume (clamped 0..1). Failures are swallowed. */
export async function saveVolumePref(volume: number): Promise<void> {
  try {
    const v = Math.min(1, Math.max(0, volume));
    await AsyncStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    /* non-fatal */
  }
}
