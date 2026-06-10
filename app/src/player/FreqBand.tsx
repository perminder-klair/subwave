// The FM-dial navigation band. Replaces the old DotRail tab row: the player's
// sections live on a horizontal swipe pager, and this band is the tuner above
// it — an FM frequency scale with evenly-spaced ticks, a vermilion needle that
// tracks the pager's scroll position, and a labelled "stop" for each section
// (SHWS · TML · LIVE · BTH · REQ). Tap a stop to tune straight to that section.
// Ported from the web mock's FM-dial band; LIVE sits dead-centre as home.
//
// The needle is driven by the pager's native-driver scrollX (a translateX
// interpolation), so sweeping it costs zero React renders — the band only
// re-renders when the snapped-to page (`active`) changes.

import { memo, useMemo, useState } from 'react';
import { Animated, type LayoutChangeEvent, Pressable, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface BandStop {
  id: string;
  label: string;
  abbr: string;
}

export interface FreqBandProps {
  pages: readonly BandStop[];
  active: number;
  /** Pager contentOffset.x, fed from Animated.event(useNativeDriver). */
  scrollX: Animated.Value;
  /** pagerWidth * (pages - 1) — the scroll position of the last page. */
  maxScroll: number;
  onPick: (i: number) => void;
}

const TICKS = 41;
// Stops + needle live within the 8%–92% inner band, matching the web mock.
const stopPct = (i: number, n: number) => 8 + (i * 84) / (n - 1);

function FreqBand({ pages, active, scrollX, maxScroll, onPick }: FreqBandProps) {
  const { colors } = useTheme();
  const [bandW, setBandW] = useState(0);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== bandW) setBandW(w);
  };

  const needleX = useMemo(() => {
    if (bandW <= 0) return null;
    return scrollX.interpolate({
      inputRange: [0, Math.max(1, maxScroll)],
      outputRange: [0.08 * bandW, 0.92 * bandW],
      extrapolate: 'clamp',
    });
  }, [scrollX, maxScroll, bandW]);

  return (
    <View
      style={{
        backgroundColor: colors.bg,
        borderBottomWidth: 1,
        borderBottomColor: colors.ink,
        paddingHorizontal: 14,
        paddingTop: 9,
        paddingBottom: 7,
        zIndex: 30,
      }}
    >
      <View style={{ position: 'relative', height: 30 }} onLayout={onLayout}>
        {/* Tick scale — majors every fifth tick */}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 13, flexDirection: 'row', justifyContent: 'space-between' }}
        >
          {Array.from({ length: TICKS }).map((_, i) => {
            const major = i % 5 === 0;
            return (
              <View
                key={i}
                style={{
                  width: 1,
                  height: major ? 13 : 7,
                  backgroundColor: major ? colors.muted : colors.softBorder,
                  opacity: major ? 0.55 : 1,
                }}
              />
            );
          })}
        </View>

        {/* Needle — sweeps with the pager, off the React render path */}
        {needleX ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: -2,
              left: 0,
              marginLeft: -1,
              width: 2,
              height: 17,
              backgroundColor: colors.accent,
              transform: [{ translateX: needleX }],
            }}
          >
            <View
              style={{ position: 'absolute', top: -3, left: -2, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }}
            />
          </Animated.View>
        ) : null}

        {/* Station stops */}
        {pages.map((p, i) => {
          const on = i === active;
          return (
            <Pressable
              key={p.id}
              onPress={() => onPick(i)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={p.label}
              accessibilityState={{ selected: on }}
              style={{
                position: 'absolute',
                top: 0,
                left: `${stopPct(i, pages.length)}%`,
                width: 32,
                marginLeft: -16,
                alignItems: 'center',
              }}
            >
              <View
                style={{
                  width: 2,
                  height: on ? 15 : 13,
                  backgroundColor: on ? colors.accent : colors.muted,
                  opacity: on ? 1 : 0.6,
                }}
              />
              <Text
                className="font-mono"
                style={{ marginTop: 3, fontSize: 8, letterSpacing: 1, fontWeight: '700', color: on ? colors.ink : colors.muted }}
              >
                {p.abbr}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default memo(FreqBand);
