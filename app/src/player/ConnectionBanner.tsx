// A one-line status strip in the console aesthetic (mono 10px, ink border, like
// TransportBar), shown above the pager so it's visible on all five pages. It
// surfaces the three states the player otherwise swallows: no device network,
// the station off air, and a live reconnect in flight. Renders null when
// healthy; fades in/out with a plain Animated opacity (no Reanimated).
//
// Priority is most-fundamental-first: a dead phone link (NO CONNECTION)
// supersedes an off-air station, which supersedes a tune-in still connecting.

import { useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import type { PlayerStatus } from '@/hooks/usePlayer';
import { useTheme } from '@/theme/ThemeContext';

export interface ConnectionBannerProps {
  isConnected: boolean | null;
  streamOnline: boolean | null;
  tunedIn: boolean;
  status: PlayerStatus;
}

type Tone = 'alert' | 'info';

function resolveBanner(
  { isConnected, streamOnline, tunedIn, status }: ConnectionBannerProps,
): { label: string; tone: Tone } | null {
  if (isConnected === false) return { label: 'NO CONNECTION', tone: 'alert' };
  if (streamOnline === false) return { label: 'STATION OFF AIR', tone: 'alert' };
  if (tunedIn && status === 'connecting') return { label: 'CONNECTING…', tone: 'info' };
  return null;
}

export default function ConnectionBanner(props: ConnectionBannerProps) {
  const { colors } = useTheme();
  const banner = resolveBanner(props);

  // Keep rendering the last banner through the fade-out, then unmount.
  const [shown, setShown] = useState(banner);
  const opacity = useRef(new Animated.Value(banner ? 1 : 0)).current;

  useEffect(() => {
    if (banner) {
      setShown(banner);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setShown(null);
      });
    }
  }, [banner, opacity]);

  if (!shown) return null;

  const toneColor = shown.tone === 'alert' ? colors.accent : colors.muted;

  return (
    <Animated.View style={{ opacity, marginHorizontal: 16, marginTop: 8 }}>
      <View
        accessibilityRole="alert"
        accessibilityLabel={shown.label}
        className="flex-row items-center justify-center"
        style={{
          borderWidth: 1,
          borderColor: colors.ink,
          backgroundColor: `${toneColor}14`,
          paddingVertical: 5,
          paddingHorizontal: 10,
          gap: 7,
        }}
      >
        <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: toneColor }} />
        <Text
          className="font-mono"
          style={{ fontSize: 10, letterSpacing: 1.5, color: toneColor }}
          numberOfLines={1}
        >
          {shown.label}
        </Text>
      </View>
    </Animated.View>
  );
}
