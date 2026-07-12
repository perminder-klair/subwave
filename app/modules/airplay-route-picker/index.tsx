// In-app AirPlay button (iOS only). Renders the native AVRoutePickerView; on
// Android this exports a component that renders nothing — output routing there
// is Google Cast's job (see src/hooks/useCast.ts). Also exposes the audio
// route-change stream (AVAudioSession.routeChangeNotification) for
// route-aware playback behaviour.

import { requireNativeModule, requireNativeViewManager } from 'expo-modules-core';
import type { ComponentType } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

export interface AirplayButtonProps {
  /** Idle icon colour (hex string). */
  tint?: string;
  /** Colour while an AirPlay route is active (hex string). */
  activeTint?: string;
  style?: StyleProp<ViewStyle>;
}

const NativeView: ComponentType<AirplayButtonProps> | null =
  Platform.OS === 'ios'
    ? requireNativeViewManager<AirplayButtonProps>('AirplayRoutePicker')
    : null;

export default function AirplayButton(props: AirplayButtonProps) {
  if (!NativeView) return null;
  return <NativeView {...props} />;
}

/** AVAudioSession.RouteChangeReason.oldDeviceUnavailable — the output device
 *  the session was playing to went away (Bluetooth speaker powered off,
 *  CarPlay disconnected, headphones unplugged). The one route-change reason
 *  that means "pause"; every other reason is a handoff or reconfiguration to
 *  keep playing through. */
export const ROUTE_REASON_OLD_DEVICE_UNAVAILABLE = 2;

export interface AudioRouteChange {
  /** AVAudioSession.RouteChangeReason raw value — 1 = newDeviceAvailable,
   *  2 = oldDeviceUnavailable, 3 = categoryChange, 4 = override,
   *  6 = wakeFromSleep, 8 = routeConfigurationChange. */
  reason: number;
  /** Current outputs, e.g. "AirPlay:HomePod" or "Speaker:iPad Speakers". */
  outputs: string;
}

interface RouteSubscription {
  remove(): void;
}

/** Subscribe to iOS audio-route changes. No-op (returns null) on Android. */
export function addAudioRouteChangeListener(
  listener: (event: AudioRouteChange) => void,
): RouteSubscription | null {
  if (Platform.OS !== 'ios') return null;
  // NativeModule instances are EventEmitters in the Expo Modules API; the
  // generic module type just doesn't carry our event map, hence the cast.
  const mod = requireNativeModule('AirplayRoutePicker') as unknown as {
    addListener(event: 'onAudioRouteChange', fn: (e: AudioRouteChange) => void): RouteSubscription;
  };
  return mod.addListener('onAudioRouteChange', listener);
}
