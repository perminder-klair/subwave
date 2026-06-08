// Masthead: a single marks row — spinning disc, wordmark/station name, caret, and
// the on-air show + host all inline (tap to switch station) — with the theme
// palette on the right and the context tagline beneath. Adapted from the web
// TopBar for a phone-width single column.

import { router } from 'expo-router';
import { Palette } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DiscMark from '@/components/DiscMark';
import { buildTagline } from '@/lib/tagline';
import type { ActiveShow, StationContext } from '@/lib/types';
import { useTheme } from '@/theme/ThemeContext';

export interface TopBarProps {
  tunedIn: boolean;
  context: StationContext | null;
  stationName?: string;
  djName?: string;
  activeShow: ActiveShow | null;
  onOpenThemes: () => void;
}

export default function TopBar({
  tunedIn,
  context,
  stationName,
  djName,
  activeShow,
  onOpenThemes,
}: TopBarProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const tagline = buildTagline(context);
  const showName = activeShow?.name || null;
  const onAirName = activeShow?.persona?.name || djName;

  return (
    <View
      style={{ paddingTop: insets.top + 8, borderBottomWidth: 1, borderBottomColor: colors.softBorder }}
      className="px-5 pb-3"
    >
      <View className="flex-row items-center justify-between">
        <Pressable
          onPress={() => router.push('/stations')}
          accessibilityRole="button"
          accessibilityLabel="Switch station"
          className="flex-row items-center"
          style={{ gap: 8, flex: 1 }}
        >
          <DiscMark size={18} spinning={tunedIn} />
          <Text className="font-mono text-ink" style={{ fontSize: 12, letterSpacing: 2 }} numberOfLines={1}>
            {(stationName?.trim() || 'SUB/WAVE').toUpperCase()}
          </Text>
          <Text className="font-mono text-muted" style={{ fontSize: 12 }}>⌄</Text>
          {showName ? (
            <Text className="font-mono text-ink" style={{ fontSize: 10, letterSpacing: 1.4, flexShrink: 1, marginLeft: 2, opacity: 0.9 }} numberOfLines={1}>
              ▸ {showName.toUpperCase()}
            </Text>
          ) : null}
          {onAirName ? (
            <Text className="font-mono text-accent" style={{ fontSize: 10, letterSpacing: 1.4 }} numberOfLines={1}>
              WITH {onAirName.toUpperCase()}
            </Text>
          ) : null}
        </Pressable>
        <View className="flex-row items-center" style={{ gap: 18, paddingLeft: 12 }}>
          <Pressable onPress={onOpenThemes} hitSlop={10} accessibilityRole="button" accessibilityLabel="Theme">
            <Palette size={18} color={colors.muted} />
          </Pressable>
        </View>
      </View>

      {tagline ? (
        <Text className="font-mono text-muted mt-1.5" style={{ fontSize: 11 }} numberOfLines={1}>
          {tagline}
        </Text>
      ) : null}
    </View>
  );
}
