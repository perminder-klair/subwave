// Now-playing cover with the web player's flourishes: corner registration ticks,
// an accent scanline that sweeps the art, and concentric ripple rings — the
// scanline + ripples animate only while on air (`live`). expo-image handles the
// cross-fade on track change.

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface CoverArtProps {
  uri: string;
  live: boolean;
  size?: number;
  onPress?: () => void;
}

function Tick({ corner, color }: { corner: 'tl' | 'tr' | 'bl' | 'br'; color: string }) {
  const top = corner[0] === 't';
  const left = corner[1] === 'l';
  const v: object = top ? { top: -4 } : { bottom: -4 };
  const h: object = left ? { left: -4 } : { right: -4 };
  return (
    <View pointerEvents="none" style={[{ position: 'absolute', width: 14, height: 14 }, v, h]}>
      <View style={[{ position: 'absolute', width: 14, height: 1.5, backgroundColor: color }, top ? { top: 0 } : { bottom: 0 }, left ? { left: 0 } : { right: 0 }]} />
      <View style={[{ position: 'absolute', width: 1.5, height: 14, backgroundColor: color }, top ? { top: 0 } : { bottom: 0 }, left ? { left: 0 } : { right: 0 }]} />
    </View>
  );
}

export default function CoverArt({ uri, live, size = 160, onPress }: CoverArtProps) {
  const { colors } = useTheme();
  const scan = useRef(new Animated.Value(0)).current;
  const ripples = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];

  useEffect(() => {
    if (!live) return;
    const s = Animated.loop(Animated.timing(scan, { toValue: 1, duration: 5500, easing: Easing.linear, useNativeDriver: true }));
    s.start();
    const loops = ripples.map((r, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 1000),
          Animated.timing(r, { toValue: 1, duration: 3000, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => {
      s.stop();
      scan.setValue(0);
      loops.forEach((l) => l.stop());
      ripples.forEach((r) => r.setValue(0));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const ringBase = size * 0.6;

  const body = (
    <View style={{ width: size, height: size }}>
      {/* ripple rings (behind) */}
      {live
        ? ripples.map((r, i) => (
            <Animated.View
              key={i}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: (size - ringBase) / 2,
                top: (size - ringBase) / 2,
                width: ringBase,
                height: ringBase,
                borderRadius: ringBase / 2,
                borderWidth: 1,
                borderColor: colors.accent,
                opacity: r.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] }),
                transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
              }}
            />
          ))
        : null}

      {/* cover + scanline (clipped) */}
      <View style={{ width: size, height: size, borderWidth: 1, borderColor: colors.muted, backgroundColor: colors.field, overflow: 'hidden' }}>
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={280} />
        {live ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: size,
              transform: [{ translateY: scan.interpolate({ inputRange: [0, 1], outputRange: [-size, size] }) }],
            }}
          >
            <LinearGradient
              colors={['transparent', `${colors.accent}29`, 'transparent']}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{ flex: 1 }}
            />
          </Animated.View>
        ) : null}
      </View>

      {/* corner ticks */}
      <Tick corner="tl" color={colors.ink} />
      <Tick corner="tr" color={colors.ink} />
      <Tick corner="bl" color={colors.ink} />
      <Tick corner="br" color={colors.ink} />
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Open timeline">
        {body}
      </Pressable>
    );
  }
  return body;
}
