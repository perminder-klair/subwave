// 120-bar Skia spectrum: slot-filling rectangles centred vertically so they
// grow symmetrically from the mid-line. Heights come from the synthesised
// useSpectrum (native has no Web Audio stream tap). Bars left of `progress`
// paint accent, the rest ink; `visible` pauses the simulation when the bars
// are off screen.

import { Canvas, Rect } from '@shopify/react-native-skia';
import { memo, useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useSpectrum } from '@/hooks/useSpectrum';
import { useTheme } from '@/theme/ThemeContext';

const BARS = 120;
const HEIGHT = 60;
const GAP = 1.5; // px between bars — the web's `gap-px`

export interface WaveformProps {
  tunedIn: boolean;
  progress: number;
  /** Whether the LIVE page is on screen — gates the spectrum simulation. */
  visible?: boolean;
}

export default memo(function Waveform({ tunedIn, progress, visible = true }: WaveformProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const spectrum = useSpectrum(BARS, tunedIn, 50, visible);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  // Geometry only changes on layout, not per tick.
  const geom = useMemo(() => {
    if (width <= 0) return null;
    const slot = width / BARS;
    const barW = Math.max(1, slot - GAP);
    const xs: number[] = new Array(BARS);
    for (let i = 0; i < BARS; i++) xs[i] = i * slot + (slot - barW) / 2;
    return { barW, xs };
  }, [width]);

  const accent = colors.accent;
  const ink = colors.ink;
  const cut = progress * BARS; // bars with i < cut have already played

  return (
    <View
      pointerEvents="none"
      onLayout={onLayout}
      style={{ marginHorizontal: 16, marginBottom: 10, height: HEIGHT, opacity: 0.45 }}
    >
      {geom ? (
        <Canvas style={{ flex: 1 }}>
          {spectrum.map((v, i) => {
            const h = (0.06 + Math.pow(v, 0.7) * 0.94) * HEIGHT;
            return (
              <Rect
                key={i}
                x={geom.xs[i]}
                y={(HEIGHT - h) / 2} // centre-anchored, mirroring the web's items-center
                width={geom.barW}
                height={h}
                color={i < cut ? accent : ink}
              />
            );
          })}
        </Canvas>
      ) : null}
    </View>
  );
});
