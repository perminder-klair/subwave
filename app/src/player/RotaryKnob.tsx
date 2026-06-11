// Rotary volume knob — the web player's knob rebuilt for native: a radial tick
// ring (SVG), an ink knob body, and a vermilion pointer that sweeps -135°→+135°
// with the level. Drag up/right to raise, down/left to lower (cumulative from
// grab). Pure RN + react-native-svg, themes with the palette.

import { useRef } from 'react';
import { PanResponder, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { useTheme } from '@/theme/ThemeContext';

const TICKS = 30;
const clamp = (v: number) => Math.min(1, Math.max(0, v));

export interface RotaryKnobProps {
  value: number;
  onChange: (v: number) => void;
  size?: number;
}

export default function RotaryKnob({ value, onChange, size = 44 }: RotaryKnobProps) {
  const { colors } = useTheme();
  const valueRef = useRef(value);
  valueRef.current = value;
  const startRef = useRef(value);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 1 || Math.abs(g.dy) > 1,
      onPanResponderGrant: () => {
        startRef.current = valueRef.current;
      },
      onPanResponderMove: (_, g) => {
        const delta = (-g.dy + g.dx) / 200;
        onChange(clamp(startRef.current + delta));
      },
    }),
  ).current;

  const angle = -135 + value * 270;
  const c = size / 2;

  return (
    <View style={{ width: size, height: size }} {...pan.panHandlers}>
      {/* radial tick ring */}
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        {Array.from({ length: TICKS }).map((_, i) => {
          const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
          const r1 = c - 1;
          const r2 = c - 4.5;
          return (
            <Line
              key={i}
              x1={c + r1 * Math.cos(a)}
              y1={c + r1 * Math.sin(a)}
              x2={c + r2 * Math.cos(a)}
              y2={c + r2 * Math.sin(a)}
              stroke={colors.muted}
              strokeWidth={1}
              opacity={0.7}
            />
          );
        })}
      </Svg>

      {/* knob body */}
      <View
        style={{
          position: 'absolute',
          left: 5,
          top: 5,
          right: 5,
          bottom: 5,
          borderRadius: (size - 10) / 2,
          borderWidth: 1.5,
          borderColor: colors.ink,
          backgroundColor: `${colors.ink}12`,
        }}
      />

      {/* pointer (rotates around knob centre) */}
      <View style={{ position: 'absolute', width: size, height: size, transform: [{ rotate: `${angle}deg` }] }}>
        <View
          style={{
            position: 'absolute',
            left: c - 1.25,
            top: size * 0.08,
            width: 2.5,
            height: size * 0.42,
            borderRadius: 2,
            backgroundColor: colors.accent,
          }}
        />
      </View>

      {/* centre cap */}
      <View
        style={{ position: 'absolute', left: c - 3, top: c - 3, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.ink }}
      />
    </View>
  );
}
