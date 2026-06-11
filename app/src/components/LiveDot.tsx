// The pulsing "on air" dot — a filled accent disc with a ring that breathes
// outward. Mirrors the web mock's .sw-livedot. `off` renders a static muted dot.

import { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { useAppActive } from '@/hooks/useAppActive';
import { useTheme } from '@/theme/ThemeContext';

export interface LiveDotProps {
  size?: number;
  off?: boolean;
}

export default function LiveDot({ size = 7, off = false }: LiveDotProps) {
  const { colors } = useTheme();
  const appActive = useAppActive();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (off || !appActive) return;
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1600, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [off, appActive, pulse]);

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {!off ? (
        <Animated.View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: colors.accent,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
          }}
        />
      ) : null}
      <View
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: off ? colors.muted : colors.accent }}
      />
    </View>
  );
}
