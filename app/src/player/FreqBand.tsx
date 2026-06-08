// The FM-dial navigation band. Replaces the old DotRail tab row: the player's
// sections live on a horizontal swipe pager, and this band is the tuner above
// it — an FM frequency scale with evenly-spaced ticks, a vermilion needle that
// tracks the pager's scroll position, and a labelled "stop" for each section
// (SHWS · TML · LIVE · BTH · REQ). Tap a stop to tune straight to that section.
// Ported from the web mock's FM-dial band; LIVE sits dead-centre as home.

import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export interface BandStop {
  id: string;
  label: string;
  abbr: string;
}

export interface FreqBandProps {
  pages: readonly BandStop[];
  active: number;
  /** Pager scroll position, 0 (first page) → 1 (last page). */
  needle: number;
  onPick: (i: number) => void;
}

const TICKS = 41;
// Stops + needle live within the 8%–92% inner band, matching the web mock.
const stopPct = (i: number, n: number) => 8 + (i * 84) / (n - 1);

export default function FreqBand({ pages, active, needle, onPick }: FreqBandProps) {
  const { colors } = useTheme();
  const needlePct = 8 + Math.min(1, Math.max(0, needle)) * 84;

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
      <View style={{ position: 'relative', height: 30 }}>
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

        {/* Needle — sweeps with the pager */}
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: -2, left: `${needlePct}%`, marginLeft: -1, width: 2, height: 17, backgroundColor: colors.accent }}
        >
          <View
            style={{ position: 'absolute', top: -3, left: -2, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent }}
          />
        </View>

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
