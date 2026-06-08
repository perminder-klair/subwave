// 120-bar spectrum, drawn with Skia, matching the web player's bars: slot-filling
// rectangles (~1px gap) centred vertically like the web's `items-center` flex row,
// so they grow symmetrically from the mid-line rather than off the floor. Native
// has no Web Audio stream tap, so the heights come from the synthesised, musical
// useSpectrum (the same place the web falls back to on iOS) — full motion while
// tuned in, a calm shimmer at rest. Bars left of `progress` paint accent, the
// rest paint ink.

import { Canvas, Rect } from '@shopify/react-native-skia';
import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useSpectrum } from '@/hooks/useSpectrum';
import { useTheme } from '@/theme/ThemeContext';

const BARS = 120;
const HEIGHT = 60;
const GAP = 1.5; // px between bars — the web's `gap-px`

export interface WaveformProps {
  tunedIn: boolean;
  progress: number;
}

export default function Waveform({ tunedIn, progress }: WaveformProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const spectrum = useSpectrum(BARS, tunedIn);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const slot = width / BARS;
  const barW = Math.max(1, slot - GAP);

  return (
    <View
      pointerEvents="none"
      onLayout={onLayout}
      style={{ marginHorizontal: 16, marginBottom: 10, height: HEIGHT, opacity: 0.45 }}
    >
      {width > 0 ? (
        <Canvas style={{ flex: 1 }}>
          {spectrum.map((v, i) => {
            const h = (0.06 + Math.pow(v, 0.7) * 0.94) * HEIGHT;
            const x = i * slot + (slot - barW) / 2;
            const y = (HEIGHT - h) / 2; // centre-anchored, mirroring the web's items-center
            const past = i / BARS < progress;
            return (
              <Rect
                key={i}
                x={x}
                y={y}
                width={barW}
                height={h}
                color={past ? colors.accent : colors.ink}
              />
            );
          })}
        </Canvas>
      ) : null}
    </View>
  );
}
