// Up-next queue + recently played. Ported from web TimelineDrawer.

import { Text, View } from 'react-native';
import { relTime } from '@/lib/format';
import type { QueueEntry } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

export interface TimelineDrawerProps {
  upcoming?: QueueEntry[];
  history?: QueueEntry[];
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="font-mono text-muted" style={{ fontSize: 9, letterSpacing: 3, paddingTop: 4, paddingBottom: 10 }}>
      {children.toUpperCase()}
    </Text>
  );
}

export default function TimelineDrawer({ upcoming, history }: TimelineDrawerProps) {
  const { colors } = useTheme();
  const hasUpcoming = !!upcoming?.length;
  const hasHistory = !!history?.length;

  if (!hasUpcoming && !hasHistory) {
    return (
      <Text className="font-body text-muted" style={{ fontSize: 13, lineHeight: 20 }}>
        Nothing played yet. The DJ is on autopilot — request a track to jump the line.
      </Text>
    );
  }

  return (
    <View>
      {hasUpcoming ? (
        <View style={{ marginBottom: hasHistory ? 24 : 0 }}>
          <SectionLabel>Up next</SectionLabel>
          {upcoming!.map((t, i) => (
            <View
              key={`q-${i}`}
              className="flex-row items-baseline"
              style={{ gap: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
            >
              <Text className="font-mono text-muted" style={{ fontSize: 24, width: 36 }}>
                {String(i + 1).padStart(2, '0')}
              </Text>
              <View className="flex-1">
                <Text className="font-body-semibold text-ink" style={{ fontSize: 17 }}>{t.title}</Text>
                <Text className="font-body text-muted mt-0.5" style={{ fontSize: 12 }}>{t.artist}</Text>
                {t.requestedBy ? (
                  <Text className="font-mono text-accent mt-1" style={{ fontSize: 9, letterSpacing: 2 }}>
                    ↳ REQUESTED BY {t.requestedBy.toUpperCase()}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {hasHistory ? (
        <View>
          <SectionLabel>Played</SectionLabel>
          {history!.map((t, i) => (
            <View
              key={`h-${i}`}
              className="flex-row items-baseline justify-between"
              style={{ gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
            >
              <View className="flex-1">
                <Text className="font-body text-ink" style={{ fontSize: 14 }} numberOfLines={1}>{t.title}</Text>
                <Text className="font-body text-muted" style={{ fontSize: 11 }} numberOfLines={1}>{t.artist}</Text>
              </View>
              {t.t ? (
                <Text className="font-mono text-muted" style={{ fontSize: 10, letterSpacing: 1 }}>
                  {relTime(t.t)} ago
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
