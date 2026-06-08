// Drawer launcher row — Schedule / Timeline / Booth / Request. The web renders
// this as a vertical side rail; on a phone it's a horizontal tab row above the
// transport deck. Active tab is filled; Request is accented like the web.

import { CalendarClock, History, Mic, Plus } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeContext';

export type PlayerDrawer = 'timeline' | 'booth' | 'request' | 'schedule';

const ITEMS: { k: PlayerDrawer; label: string }[] = [
  { k: 'schedule', label: 'Schedule' },
  { k: 'timeline', label: 'Timeline' },
  { k: 'booth', label: 'Booth' },
  { k: 'request', label: 'Request' },
];

export interface DotRailProps {
  upcomingCount: number;
  active: PlayerDrawer | null;
  onSelect: (id: PlayerDrawer | null) => void;
}

function Icon({ k, count, color }: { k: PlayerDrawer; count: number; color: string }) {
  if (k === 'request') return <Plus size={20} color={color} strokeWidth={2.25} />;
  if (k === 'booth') return <Mic size={18} color={color} strokeWidth={1.5} />;
  if (k === 'schedule') return <CalendarClock size={18} color={color} strokeWidth={1.5} />;
  // timeline → upcoming count, or a history glyph when empty
  if (count > 0) {
    return (
      <Text className="font-mono" style={{ fontSize: 18, color }}>
        {count}
      </Text>
    );
  }
  return <History size={18} color={color} strokeWidth={1.5} />;
}

export default function DotRail({ upcomingCount, active, onSelect }: DotRailProps) {
  const { colors } = useTheme();
  return (
    <View className="flex-row px-4" style={{ gap: 8 }}>
      {ITEMS.map((item) => {
        const isActive = active === item.k;
        const isRequest = item.k === 'request';
        const fg = isActive ? colors.bg : isRequest ? colors.accent : colors.ink;
        return (
          <Pressable
            key={item.k}
            onPress={() => onSelect(isActive ? null : item.k)}
            className="flex-1 items-center justify-center rounded-lg"
            style={{
              paddingVertical: 12,
              gap: 5,
              backgroundColor: isActive ? colors.ink : isRequest ? `${colors.accent}14` : 'transparent',
              borderWidth: 1,
              borderColor: isActive ? colors.ink : colors.softBorder,
            }}
          >
            <Icon k={item.k} count={upcomingCount} color={isActive ? colors.accent : fg} />
            <Text
              className="font-mono"
              style={{
                fontSize: 9,
                letterSpacing: 2,
                color: isActive ? colors.bg : isRequest ? colors.accent : colors.muted,
              }}
            >
              {item.label.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
