// System turns are operator-only, except listener show-boundary separators (#1690).

import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  isCarriedTurn,
  isDjTurn,
  isShowBoundary,
  showBoundaryLabel,
  turnClass,
  turnKey,
  turnText,
  type TurnDisplayClass,
} from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';
import { fmtClock, fmtClockMinute, type StationLocale } from '@/lib/format';
import { useTheme } from '@/theme/ThemeContext';

type FilterId = 'all' | 'dj' | 'tracks';
const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'dj', label: 'DJ' },
  { id: 'tracks', label: 'Tracks' },
];

export interface BoothDrawerProps {
  items: SessionTurn[];
  /** Station IANA timezone, so stamps match what the DJ speaks (#418). Falls
   *  back to the device zone. */
  timezone?: string | null;
  /** Station display locale — 24h (en-GB) vs AM/PM (en-US) timestamps (#475). */
  locale?: StationLocale | null;
}

export default function BoothDrawer({ items, timezone, locale }: BoothDrawerProps) {
  const { colors } = useTheme();
  const [filter, setFilter] = useState<FilterId>('all');

  const filtered = useMemo<SessionTurn[]>(() => {
    if (!items?.length) return [];
    const ordered = [...items]
      .filter((t) => turnClass(t) !== 'system' || isShowBoundary(t))
      .reverse();
    if (filter === 'all') return ordered;
    return ordered.filter((t) =>
      isShowBoundary(t) || (filter === 'dj' ? isDjTurn(t) : turnClass(t) === 'track'));
  }, [items, filter]);

  const classColor = (cls: TurnDisplayClass) => (cls === 'voice' ? colors.accent : colors.muted);

  return (
    <View>
      <View
        className="flex-row"
        style={{ gap: 6, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
      >
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <Pressable
              key={f.id}
              onPress={() => setFilter(f.id)}
              accessibilityRole="button"
              accessibilityLabel={`Filter: ${f.label}`}
              accessibilityState={{ selected: active }}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderWidth: 1,
                borderColor: active ? colors.ink : colors.softBorder,
                backgroundColor: active ? colors.ink : 'transparent',
              }}
            >
              <Text
                className="font-mono"
                style={{ fontSize: 10, letterSpacing: 2, color: active ? colors.bg : colors.muted }}
              >
                {f.label.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {filtered.length === 0 ? (
        <Text className="font-body text-muted" style={{ fontSize: 13, paddingVertical: 18, fontStyle: 'italic' }}>
          {items?.length ? 'Nothing in this view.' : 'Booth is quiet. Awaiting transmission…'}
        </Text>
      ) : null}

      {filtered.map((turn, i) => {
        if (isShowBoundary(turn)) {
          const label = showBoundaryLabel(turn, (at) => fmtClockMinute(at, timezone, locale));
          return (
            <View
              key={turnKey(turn, i)}
              accessibilityRole="text"
              accessibilityLabel={`Show boundary: ${label}`}
              className="flex-row items-center"
              style={{ gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
            >
              <View style={{ flex: 1, height: 1, backgroundColor: colors.softBorder }} />
              <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 2 }}>
                {label}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.softBorder }} />
            </View>
          );
        }
        const cls = turnClass(turn);
        const isVoice = cls === 'voice';
        const text = turnText(turn);
        return (
          <View
            key={turnKey(turn, i)}
            style={{
              // The previous show's carried tail is dimmed (#1690).
              opacity: isCarriedTurn(turn) ? 0.6 : 1,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: colors.softBorder,
              borderLeftWidth: isVoice ? 2 : 0,
              borderLeftColor: colors.accent,
              paddingLeft: isVoice ? 12 : 0,
            }}
          >
            <View className="flex-row items-baseline" style={{ gap: 8, marginBottom: 4 }}>
              <Text className="font-mono text-muted" style={{ fontSize: 10, minWidth: 56 }}>
                {fmtClock(turn.t, timezone, locale)}
              </Text>
              <Text className="font-mono" style={{ fontSize: 9, letterSpacing: 2, color: classColor(cls) }}>
                {(turn.kind || '').toUpperCase()}
              </Text>
              {isCarriedTurn(turn) && isVoice && typeof turn.meta?.personaName === 'string' && turn.meta.personaName ? (
                <Text className="font-mono" style={{ fontSize: 9, letterSpacing: 2, color: colors.accent, flexShrink: 1 }}>
                  {turn.meta.personaName}
                </Text>
              ) : null}
            </View>
            <Text
              className="text-ink"
              style={{
                fontSize: isVoice ? 14 : 13,
                lineHeight: 20,
                fontStyle: isVoice ? 'italic' : 'normal',
              }}
            >
              {isVoice ? `"${text}"` : text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
