// Live booth transcript with All / DJ / Tracks filters. Ported from web
// BoothDrawer. System turns are operator-facing and never shown.

import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  isDjTurn,
  turnClass,
  turnKey,
  turnText,
  type TurnDisplayClass,
} from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

type FilterId = 'all' | 'dj' | 'tracks';
const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'dj', label: 'DJ' },
  { id: 'tracks', label: 'Tracks' },
];

function shortTime(t: string | number | undefined): string {
  if (t == null) return '';
  try {
    return new Date(t).toLocaleTimeString('en-GB', { hour12: false });
  } catch {
    return String(t);
  }
}

export interface BoothDrawerProps {
  items: SessionTurn[];
}

export default function BoothDrawer({ items }: BoothDrawerProps) {
  const { colors } = useTheme();
  const [filter, setFilter] = useState<FilterId>('all');

  const filtered = useMemo<SessionTurn[]>(() => {
    if (!items?.length) return [];
    const ordered = [...items].filter((t) => turnClass(t) !== 'system').reverse();
    if (filter === 'all') return ordered;
    return ordered.filter((t) => (filter === 'dj' ? isDjTurn(t) : turnClass(t) === 'track'));
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
        const cls = turnClass(turn);
        const isVoice = cls === 'voice';
        const text = turnText(turn);
        return (
          <View
            key={turnKey(turn, i)}
            style={{
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
                {shortTime(turn.t)}
              </Text>
              <Text className="font-mono" style={{ fontSize: 9, letterSpacing: 2, color: classColor(cls) }}>
                {(turn.kind || '').toUpperCase()}
              </Text>
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
