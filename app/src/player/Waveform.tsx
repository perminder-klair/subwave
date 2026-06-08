// 120-bar spectrum, drawn with Skia. Native has no Web Audio stream tap, so the
// bars are driven by the pseudo-random useSpectrum — the same fallback the web
// already shows on iOS (honest parity). Bars left of `progress` paint accent,
// the rest paint ink, both at low opacity so they sit behind the stage.

import { Canvas, Rect } from '@shopify/react-native-skia';
import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useSpectrum } from '@/hooks/useSpectrum';
import { useTheme } from '@/theme/ThemeContext';

const BARS = 120;
const HEIGHT = 150;

export interface WaveformProps {
  tunedIn: boolean;
  progress: number;
}

export default function Waveform({ tunedIn, progress }: WaveformProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const spectrum = useSpectrum(BARS, true, tunedIn ? 60 : 120);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const slot = width / BARS;
  const barW = Math.max(1, slot * 0.55);

  return (
    <View
      pointerEvents="none"
      onLayout={onLayout}
      style={{ position: 'absolute', left: 12, right: 12, bottom: 96, height: HEIGHT, opacity: 0.2 }}
    >
      {width > 0 ? (
        <Canvas style={{ flex: 1 }}>
          {spectrum.map((v, i) => {
            const h = (0.08 + Math.pow(v, 0.7) * 0.92) * HEIGHT;
            const x = i * slot + (slot - barW) / 2;
            const past = i / BARS < progress;
            return (
              <Rect
                key={i}
                x={x}
                y={HEIGHT - h}
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
