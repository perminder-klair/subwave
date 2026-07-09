// In-app AirPlay button (iOS only). Renders the native AVRoutePickerView; on
// Android this exports a component that renders nothing — output routing there
// is Google Cast's job (see src/hooks/useCast.ts).

import { requireNativeViewManager } from 'expo-modules-core';
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
