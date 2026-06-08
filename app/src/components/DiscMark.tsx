// The SUB/WAVE disc-mark motif — a vinyl record drawn as 20 radial spokes with
// an accent label, ringed in ink. Spins (6s linear) while the station is on air,
// matching the web mock's DiscMark. Used in onboarding/stations branding and the
// top bar. Pure react-native-svg so it themes with the active palette.

import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeContext';

const SPOKES = Array.from({ length: 20 }, (_, i) => {
  const a0 = (i / 20) * Math.PI * 2 - Math.PI / 2;
  const a1 = a0 + ((Math.PI * 2) / 20) * 0.55;
  const x0 = 48 + 47 * Math.cos(a0);
  const y0 = 48 + 47 * Math.sin(a0);
  const x1 = 48 + 47 * Math.cos(a1);
  const y1 = 48 + 47 * Math.sin(a1);
  return `M48 48 L${x0.toFixed(1)} ${y0.toFixed(1)} A47 47 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`;
});

export interface DiscMarkProps {
  size?: number;
  spinning?: boolean;
}

export default function DiscMark({ size = 18, spinning = false }: DiscMarkProps) {
  const { colors } = useTheme();
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!spinning) {
      spin.stopAnimation();
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spinning, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size} viewBox="0 0 96 96">
        <Circle cx={48} cy={48} r={47} fill="none" stroke={colors.ink} strokeWidth={2} />
        {SPOKES.map((d, i) => (
          <Path key={i} d={d} fill={colors.ink} />
        ))}
        <Circle cx={48} cy={48} r={16} fill={colors.accent} stroke={colors.bg} strokeWidth={2} />
      </Svg>
    </Animated.View>
  );
}
