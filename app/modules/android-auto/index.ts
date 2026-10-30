// The JS half of Android Auto: the station list the car shows. The car's side
// is android/…/SubwaveBrowseService.kt. A no-op outside Android.

import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { MirroredStation } from '@/lib/station-store';

interface NativeAndroidAuto {
  setStations(json: string): void;
}

// Binaries older than Android Auto support lack this module, and an OTA
// update must not crash them.
const native: NativeAndroidAuto | null = (() => {
  if (Platform.OS !== 'android') return null;
  try {
    return requireNativeModule('SubwaveAndroidAuto') as unknown as NativeAndroidAuto;
  } catch {
    return null;
  }
})();

/** The saved stations and the active one, for a car that may connect while JS
 *  is not running. Names and credential-free bases only, as for Siri. */
export function setStations(active: string | null, stations: MirroredStation[]): void {
  try {
    native?.setStations(JSON.stringify({ active, stations }));
  } catch {
    /* a binary older than Android Auto support */
  }
}
