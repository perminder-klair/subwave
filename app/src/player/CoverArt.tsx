// Now-playing cover with the web player's flourishes: an accent scanline that
// sweeps the art and concentric ripple rings animate while on air (`live`); on a
// `burst` — a ~3s window opened by a track change or a new DJ turn — the art
// glitches (chromatic-split ghosts + colour tears, the native analog of the web
// `.v3-cover-live` CSS) and the corner registration ticks fade in. At rest the
// ticks/glitch are hidden, matching the web player. expo-image handles the
// cross-fade on track change.

import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface CoverArtProps {
  uri: string;
  live: boolean;
  /** ~3s window after a track change or DJ turn — drives the glitch + ticks. */
  burst?: boolean;
  size?: number;
  onPress?: () => void;
}

// Discrete glitch frames — stepped (not eased) for the authentic digital
// stutter the web gets from `animation: … steps(1)`. dx* = chromatic ghost
// offsets; the tear is a thin colour slice that jumps around the frame.
const GLITCH_FRAMES = [
  { dx1: -3, dx2: 3, tearY: 0.10, tearX: -5, tearH: 0.06 },
  { dx1: 2, dx2: -2, tearY: 0.46, tearX: 5, tearH: 0.05 },
  { dx1: -2, dx2: 2, tearY: 0.70, tearX: -4, tearH: 0.04 },
  { dx1: 3, dx2: -3, tearY: 0.24, tearX: 4, tearH: 0.05 },
  { dx1: -1, dx2: 1, tearY: 0.58, tearX: -3, tearH: 0.04 },
];
const TEAL = '#16d6cf';

// Chromatic-aberration glitch: two faint offset copies of the art (RGB-split
// ghosts) plus jumping colour tears. Mounted only during a burst, so its
// interval lives and dies with the effect. RN has no `mix-blend-mode: screen`,
// so offset low-opacity copies stand in for the web's tinted channels.
function CoverGlitch({ uri, size, accent }: { uri: string; size: number; accent: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % GLITCH_FRAMES.length), 90);
    return () => clearInterval(id);
  }, []);
  const f = GLITCH_FRAMES[frame];
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
      <Image
        source={{ uri }}
        style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.4, transform: [{ translateX: f.dx1 }] }}
        contentFit="cover"
      />
      <Image
        source={{ uri }}
        style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.4, transform: [{ translateX: f.dx2 }] }}
        contentFit="cover"
      />
      <View
        style={{ position: 'absolute', left: 0, right: 0, top: f.tearY * size, height: f.tearH * size, backgroundColor: accent, opacity: 0.5, transform: [{ translateX: f.tearX }] }}
      />
      <View
        style={{ position: 'absolute', left: 0, right: 0, top: (f.tearY + 0.12) * size, height: f.tearH * size, backgroundColor: TEAL, opacity: 0.45, transform: [{ translateX: -f.tearX }] }}
      />
    </View>
  );
}

function Tick({ corner, color, opacity }: { corner: 'tl' | 'tr' | 'bl' | 'br'; color: string; opacity: Animated.AnimatedInterpolation<number> | Animated.Value }) {
  const top = corner[0] === 't';
  const left = corner[1] === 'l';
  const v: object = top ? { top: -4 } : { bottom: -4 };
  const h: object = left ? { left: -4 } : { right: -4 };
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: 14, height: 14, opacity }, v, h]}>
      <View style={[{ position: 'absolute', width: 14, height: 1.5, backgroundColor: color }, top ? { top: 0 } : { bottom: 0 }, left ? { left: 0 } : { right: 0 }]} />
      <View style={[{ position: 'absolute', width: 1.5, height: 14, backgroundColor: color }, top ? { top: 0 } : { bottom: 0 }, left ? { left: 0 } : { right: 0 }]} />
    </Animated.View>
  );
}

export default function CoverArt({ uri, live, burst = false, size = 160, onPress }: CoverArtProps) {
  const { colors } = useTheme();
  const scan = useRef(new Animated.Value(0)).current;
  const ripples = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];
  // Corner ticks fade in on burst (track change / DJ thinking), mirroring the
  // web `.v3-cover-tick` opacity transition.
  const tick = useRef(new Animated.Value(0)).current;

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

  useEffect(() => {
    Animated.timing(tick, { toValue: burst ? 1 : 0, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burst]);

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

      {/* cover + glitch + scanline (clipped) */}
      <View style={{ width: size, height: size, borderWidth: 1, borderColor: colors.muted, backgroundColor: colors.field, overflow: 'hidden' }}>
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={280} />
        {burst ? <CoverGlitch uri={uri} size={size} accent={colors.accent} /> : null}
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

      {/* corner ticks — fade in on burst */}
      <Tick corner="tl" color={colors.ink} opacity={tick} />
      <Tick corner="tr" color={colors.ink} opacity={tick} />
      <Tick corner="bl" color={colors.ink} opacity={tick} />
      <Tick corner="br" color={colors.ink} opacity={tick} />
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
